// Proves the safe-area declarations actually apply. A malformed env()/calc()
// would be dropped by the parser and, because the prototype's declaration is
// kept as a fallback, would render identically at zero insets - so "it looks
// right in a browser" proves nothing.
//
// Chromium always DEFINES safe-area-inset-* (as 0px), so an env() fallback
// never fires there and cannot be used to fake a notch. Instead the second
// render aliases the four names to undefined env vars with a 44px fallback.
// That exercises the same declaration, cascade position and calc() arithmetic,
// and moves only if the override really applies. The real inset names are
// checked separately, statically, below.
import fs from 'fs'; import path from 'path'; import os from 'os';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright-core';
import http from 'http';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const INSET = 44;

function variant(dir){
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-'));
  fs.cpSync(path.join(ROOT, 'dist'), out, { recursive: true });
  const cssFile = fs.readdirSync(path.join(out, 'assets')).find(f => f.endsWith('.css'));
  const p = path.join(out, 'assets', cssFile);
  if (dir === 'inset'){
    fs.writeFileSync(p, fs.readFileSync(p, 'utf8')
      .replaceAll('env(safe-area-inset-', 'env(simulated-inset-')
      .replaceAll(',0px)', `,${INSET}px)`));
  }
  return out;
}

// Served over HTTP, not file://: ES modules are blocked by CORS on file://,
// which stops main.js (and therefore nothing here) but also makes the whole
// page load unrepresentative.
function serve(dir){
  const types = { '.html':'text/html', '.css':'text/css', '.js':'text/javascript' };
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.join(dir, rel);
    if (!file.startsWith(dir) || !fs.existsSync(file)){ res.statusCode = 404; return res.end('nope'); }
    res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, port: srv.address().port })));
}

const PROBES = [
  ['.wrap',    ['paddingTop','paddingRight','paddingBottom','paddingLeft']],
  ['#preview', ['top','right']],
  ['.sheet',   ['paddingBottom','paddingLeft','paddingRight']],
  ['#dbg',     ['bottom','left']],
  ['#dawn',    ['top','right','bottom','left']],
];

const browser = await chromium.launch({ executablePath: EXE });
async function measure(dir){
  const { srv, port } = await serve(dir);
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
  const out = await page.evaluate((probes) => {
    const r = {};
    for (const [sel, props] of probes){
      const el = document.querySelector(sel);
      if (!el){ r[sel] = null; continue; }
      const cs = getComputedStyle(el);
      r[sel] = Object.fromEntries(props.map(p => [p, cs[p]]));
    }
    return r;
  }, PROBES);
  await page.close();
  srv.close();
  return out;
}
const base  = await measure(variant('base'));
const inset = await measure(variant('inset'));
await browser.close();

const px = v => parseFloat(v);
let pass = 0, fail = 0;
const check = (l, c, x='') => { c ? pass++ : fail++; console.log(`  ${c?'PASS':'FAIL'}  ${l}${x?'  '+x:''}`); };

console.log(`== computed at 390x844, simulated inset = ${INSET}px ==`);
for (const [sel, props] of PROBES){
  for (const p of props){
    const b = px(base[sel][p]), i = px(inset[sel][p]);
    const delta = i - b;
    const wantMove = sel !== '#dawn';
    const ok = wantMove ? Math.abs(delta - INSET) < 0.5 : Math.abs(delta) < 0.5;
    check(`${sel} ${p}`, ok, `${b}px -> ${i}px (${delta>=0?'+':''}${delta})${wantMove?'':' [must not move: full-bleed]'}`);
  }
}
// The render above proves the mechanism; this proves the real names are wired
// to the right properties in the shipped CSS.
const css = fs.readFileSync(path.join(ROOT, 'dist', 'assets',
  fs.readdirSync(path.join(ROOT,'dist','assets')).find(f => f.endsWith('.css'))), 'utf8');
const rule = (sel) => (css.match(new RegExp(sel.replace('.','\\.') + '\\{[^}]*\\}')) || [''])[0];
console.log('\n== real inset names in the shipped CSS ==');
const EXPECT = [
  ['.wrap', ['top','right','bottom','left']],
  ['#preview', ['top','right']],
  ['.sheet', ['bottom','left','right']],
  ['#dbg', ['bottom','left']],
];
for (const [sel, sides] of EXPECT){
  const r = rule(sel);
  for (const side of sides){
    check(`${sel} uses env(safe-area-inset-${side})`, r.includes(`env(safe-area-inset-${side},`));
  }
}
check('#dawn has no inset (stays full-bleed)', !rule('#dawn').includes('env('));
check('#dawnWarm has no inset (stays full-bleed)', !rule('#dawnWarm').includes('env('));

console.log(`\n  base padding on .wrap: ${base['.wrap'].paddingTop} (prototype value, unchanged at zero insets)`);
console.log(`  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

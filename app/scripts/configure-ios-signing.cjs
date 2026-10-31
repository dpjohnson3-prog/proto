#!/usr/bin/env node
/**
 * Puts the signing + entitlements settings into the Xcode project.
 *
 *     node scripts/configure-ios-signing.cjs
 *
 * Capacitor generates the iOS project without a development team, so a fresh
 * `npx cap add ios` produces a project that cannot be signed. Rather than
 * clicking it in Xcode each time (and losing it on the next regeneration),
 * this sets it in the project file, idempotently, with the `xcode` parser
 * rather than a regex.
 *
 * It sets, on BOTH the App target's Debug and Release configurations:
 *   DEVELOPMENT_TEAM        - so automatic signing can pick a profile
 *   CODE_SIGN_ENTITLEMENTS  - App/App.entitlements, for Time Sensitive
 *                             Notifications
 *
 * It does NOT touch CODE_SIGN_STYLE (stays Automatic) or the bundle id.
 */
const fs = require('fs');
const path = require('path');
const xcode = require('xcode');
const pbxFile = require('xcode/lib/pbxFile');

const TEAM = process.env.DEVELOPMENT_TEAM || 'UMPTW639PG';
const ENTITLEMENTS = 'App/App.entitlements';

const ROOT = path.resolve(__dirname, '..');
const PBX = path.join(ROOT, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');
const ENT_ABS = path.join(ROOT, 'ios', 'App', 'App', 'App.entitlements');

if (!fs.existsSync(PBX)){ console.error('No iOS project. Run `npx cap add ios`.'); process.exit(1); }
if (!fs.existsSync(ENT_ABS)){ console.error('Missing ' + ENT_ABS); process.exit(1); }

const before = fs.readFileSync(PBX, 'utf8');
const proj = xcode.project(PBX);
proj.parseSync();

// The App target's configurations are the ones carrying the bundle id; the
// project-level ones must be left alone.
const cfgs = proj.hash.project.objects['XCBuildConfiguration'];
let touched = 0;
for (const [key, cfg] of Object.entries(cfgs)){
  if (!cfg || typeof cfg !== 'object' || key.endsWith('_comment')) continue;
  const bs = cfg.buildSettings;
  if (!bs || !bs.PRODUCT_BUNDLE_IDENTIFIER) continue;
  bs.DEVELOPMENT_TEAM = TEAM;
  bs.CODE_SIGN_ENTITLEMENTS = '"' + ENTITLEMENTS + '"';
  touched++;
}

// Show the entitlements file in the Xcode navigator. It is not compiled or
// copied, so it belongs to no build phase - a file reference in the App group
// is all it needs.
const groups = proj.hash.project.objects['PBXGroup'];
let appGroup = null;
for (const [k, v] of Object.entries(groups)){
  if (v && typeof v === 'object' && v.path === 'App') appGroup = k;
}
const refs = proj.hash.project.objects['PBXFileReference'] || {};
const known = new Set(Object.values(refs)
  .filter(r => r && typeof r === 'object' && r.path)
  .map(r => String(r.path).replace(/^"|"$/g, '')));
let addedRef = false;
if (appGroup && !known.has('App.entitlements')){
  const f = new pbxFile('App.entitlements', { lastKnownFileType: 'text.plist.entitlements' });
  f.uuid = proj.generateUuid();
  f.fileRef = proj.generateUuid();
  proj.addToPbxFileReferenceSection(f);
  proj.addToPbxGroup(f, appGroup);
  addedRef = true;
}

let out = proj.writeSync();
// The writer renormalises these two cosmetic attributes; restore them so this
// script's diff shows only the settings it meant to change.
for (const k of ['LastSwiftUpdateCheck', 'LastUpgradeCheck']){
  const had = before.match(new RegExp(k + ' = ([^;]+);'));
  if (had && out.includes(k)) out = out.replace(new RegExp(k + ' = [^;]+;'), k + ' = ' + had[1] + ';');
}
fs.writeFileSync(PBX, out);

// Re-read from disk and prove it, rather than trusting the write.
const check = xcode.project(PBX); check.parseSync();
let ok = 0, bad = 0;
for (const [key, cfg] of Object.entries(check.hash.project.objects['XCBuildConfiguration'])){
  if (!cfg || typeof cfg !== 'object' || key.endsWith('_comment')) continue;
  const bs = cfg.buildSettings;
  if (!bs || !bs.PRODUCT_BUNDLE_IDENTIFIER) continue;
  const team = String(bs.DEVELOPMENT_TEAM || '').replace(/"/g, '');
  const ent = String(bs.CODE_SIGN_ENTITLEMENTS || '').replace(/"/g, '');
  const style = String(bs.CODE_SIGN_STYLE || '');
  const good = team === TEAM && ent === ENTITLEMENTS && style === 'Automatic';
  console.log(`  ${good ? 'ok' : '??'}  ${cfg.name.padEnd(8)} team=${team || '(unset)'} entitlements=${ent || '(unset)'} style=${style}`);
  good ? ok++ : bad++;
}
console.log(`configurations updated: ${touched}, verified: ${ok}${addedRef ? ', entitlements added to the project navigator' : ''}`);
if (bad){ console.error('FAILED: ' + bad + ' configuration(s) not set correctly.'); process.exit(1); }

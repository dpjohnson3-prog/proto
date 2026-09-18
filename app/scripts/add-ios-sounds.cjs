#!/usr/bin/env node
/**
 * Adds the generated alarm sounds to the iOS App target's Resources phase.
 *
 * Why this exists: a notification sound has to sit at the app BUNDLE ROOT, not
 * in the web assets Capacitor copies. Dropping the .wav files into
 * ios/App/App/ is not enough - unless they are also members of the App target
 * they never reach the bundle, and iOS silently substitutes the default sound.
 * Silent substitution is exactly the failure mode this app keeps trying not to
 * have, so this is scripted rather than left as a manual Xcode step.
 *
 * Uses the `xcode` parser (the same one Cordova uses) rather than patching the
 * pbxproj by hand. Idempotent: safe to re-run after adding a sound.
 *
 *     node scripts/add-ios-sounds.cjs
 */
const fs = require('fs');
const path = require('path');
const xcode = require('xcode');
const pbxFile = require('xcode/lib/pbxFile');

const ROOT = path.resolve(__dirname, '..');
const APP_DIR = path.join(ROOT, 'ios', 'App', 'App');
const PBX = path.join(ROOT, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj');

if (!fs.existsSync(PBX)){
  console.error('No iOS project yet. Run `npx cap add ios` first.');
  process.exit(1);
}

const sounds = fs.readdirSync(APP_DIR).filter(f => f.endsWith('.wav')).sort();
if (!sounds.length){
  console.error('No .wav files in ios/App/App - run scripts/make-sounds.py first.');
  process.exit(1);
}

const proj = xcode.project(PBX);
proj.parseSync();

// The group whose path is 'App' is the one that maps to the bundle root.
const groups = proj.hash.project.objects['PBXGroup'];
let appGroup = null;
for (const [key, val] of Object.entries(groups)){
  if (val && typeof val === 'object' && val.path === 'App') appGroup = key;
}
if (!appGroup){ console.error('Could not find the App group in the project.'); process.exit(1); }

const existing = () => {
  const refs = proj.hash.project.objects['PBXFileReference'] || {};
  return new Set(Object.values(refs)
    .filter(r => r && typeof r === 'object' && r.path)
    .map(r => String(r.path).replace(/^"|"$/g, '')));
};

// proj.addResourceFile() resolves its group argument by NAME, and Capacitor's
// App group only carries a `path`, so it throws. Do the four steps it would
// have done, explicitly: file reference, build file, Resources phase, group.
let added = 0, skipped = 0;
for (const wav of sounds){
  if (existing().has(wav)){ skipped++; continue; }
  const file = new pbxFile(wav, { lastKnownFileType: 'audio.wav' });
  file.uuid = proj.generateUuid();
  file.fileRef = proj.generateUuid();
  proj.addToPbxFileReferenceSection(file);
  proj.addToPbxBuildFileSection(file);
  proj.addToPbxResourcesBuildPhase(file);
  proj.addToPbxGroup(file, appGroup);
  added++;
}

if (added){
  let out = proj.writeSync();
  // The writer drops these two cosmetic attributes. They are only Xcode
  // bookkeeping, but putting them back keeps this script's diff purely
  // additive, so a reviewer can see it touched nothing it did not mean to.
  const before = fs.readFileSync(PBX, 'utf8');
  for (const key of ['LastSwiftUpdateCheck', 'LastUpgradeCheck']){
    const had = before.match(new RegExp(key + ' = ([^;]+);'));
    if (!had) continue;
    if (out.includes(key)){
      // Present but renormalised (the parser turns 0920 into 920). Put the
      // original value back so the diff shows only the sounds.
      out = out.replace(new RegExp(key + ' = [^;]+;'), key + ' = ' + had[1] + ';');
    } else {
      out = out.replace(/(\n\s*)(TargetAttributes = \{)/,
        '$1' + key + ' = ' + had[1] + ';$1$2');
    }
  }
  fs.writeFileSync(PBX, out);
}

// Re-parse from disk and prove each sound is really a member of the target,
// rather than trusting that the write worked.
const check = xcode.project(PBX);
check.parseSync();
const phase = check.pbxResourcesBuildPhaseObj(null);
const inPhase = new Set((phase.files || []).map(f => String(f.comment || '')));
let bad = 0;
for (const wav of sounds){
  const ok = [...inPhase].some(c => c.startsWith(wav + ' '));
  if (!ok){ console.error('  MISSING from Resources phase: ' + wav); bad++; }
}
console.log(`sounds: ${added} added, ${skipped} already present`);
console.log(`Resources build phase now has ${inPhase.size} entries`);
for (const wav of sounds) console.log('  ' + (bad ? '?' : 'ok') + '  ' + wav);
if (bad){ console.error('FAILED: ' + bad + ' sound(s) not in the target.'); process.exit(1); }
console.log('All sounds are members of the App target.');

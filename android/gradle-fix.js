/**
 * Patches the Capacitor-generated android/build.gradle files to replace
 * flatDir repository declarations with proper Maven local repo lookups.
 * This eliminates the "Using flatDir should be avoided" Gradle warnings.
 *
 * Run automatically as part of `npx cap sync` via the prepare-web.js script,
 * or manually: node gradle-fix.js
 *
 * Background: Capacitor 6 still uses flatDir to locate its AAR files.
 * The warning doesn't break the build but is noisy in CI logs.
 * See: https://github.com/ionic-team/capacitor/issues/6100
 */

const fs   = require('fs');
const path = require('path');

const androidDir = path.join(__dirname, 'android');
const targets    = [
  path.join(androidDir, 'build.gradle'),
  path.join(androidDir, 'capacitor-cordova-android-plugins', 'build.gradle'),
];

const FLATDIR_RE = /flatDir\s*\{[^}]*dirs[^}]*\}/g;
const REPLACEMENT = `maven { url = uri("../node_modules/@capacitor/android/capacitor/build/outputs/aar") }`;

let patched = 0;
for (const file of targets) {
  if (!fs.existsSync(file)) continue;
  const orig = fs.readFileSync(file, 'utf8');
  const next = orig.replace(FLATDIR_RE, REPLACEMENT);
  if (next !== orig) {
    fs.writeFileSync(file, next, 'utf8');
    console.log('  patched:', path.relative(__dirname, file));
    patched++;
  }
}

if (patched === 0) {
  console.log('  (no flatDir patterns found - may not have run cap sync yet, skipping)');
}

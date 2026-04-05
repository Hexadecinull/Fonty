/**
 * Copies the shared web assets from the repo root into android/www/
 * so Capacitor can bundle them into the APK.
 * Run via: npm run prepare  (or automatically via npm run android)
 */
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const WWW  = path.join(__dirname, 'www');
const LIB  = path.join(WWW, 'lib');

fs.mkdirSync(LIB, { recursive: true });

const files = [
  ['index.html', 'index.html'],
  ['app.js',     'app.js'],
  ['app.css',    'app.css'],
  ['lib/fonty.js', 'lib/fonty.js'],
];

for (const [src, dst] of files) {
  fs.copyFileSync(path.join(ROOT, src), path.join(WWW, dst));
  console.log(`  copied ${src}`);
}

console.log('Web assets ready in android/www/');

# Fonty

Font manager, inspector and converter. Best-in-class AngelCode FNT bitmap font support.

**[GitHub](https://github.com/Hexadecinull/Fonty)** — Found a bug, a warning, a wrong value, or anything that looks off? Please open an issue or pull request without hesitation. Even the tiniest thing is worth reporting. PRs for fixes, features, or improvements of any size are always welcome.

---

## Versions

| Version  | Location    | How to use                                              |
|----------|-------------|---------------------------------------------------------|
| Web      | `/` (root)  | Open `index.html` in any modern browser, or push to GitHub Pages (root or `docs/`) |
| Desktop  | `desktop/`  | Electron app — native dialogs, custom titlebar          |
| Android  | `android/`  | Capacitor app — runs the web UI natively on Android     |

The web, desktop, and Android versions all share `index.html`, `app.js`, `app.css`, and `lib/fonty.js`. Electron and Capacitor features activate automatically at runtime when their respective bridges are detected, so there is no separate codebase to maintain.

---

## Web

Open `index.html` directly in a browser, or deploy to GitHub Pages from the repo root. No build step needed.

---

## Desktop (Electron)

```bash
cd desktop
npm install
npm start
```

### Build distributable

```bash
npm run build:win    # Windows: NSIS installer (.exe) + portable (.exe)
npm run build:linux  # Linux: AppImage + .deb
npm run build:mac    # macOS: .dmg (x64 + arm64)
```

Output lands in `desktop/dist/`.

**Requirements:** Node.js 18+, and on Linux: `libfuse2` or `libfuse2t64` for AppImage support.

---

## Android (Capacitor)

Capacitor wraps the web UI in a native Android WebView. No React Native, no custom bridge code.

### First-time setup

```bash
# Install dependencies
cd android
npm install

# Copy web assets, initialise Capacitor, open Android Studio
npm run android
```

Android Studio will open with the project ready to run on a device or emulator.

### Build from command line

```bash
# Debug APK (no signing required)
npm run build:debug

# Release APK (requires a keystore configured in android/android/app/build.gradle)
npm run build:release
```

APKs are written to `android/android/app/build/outputs/apk/`.

### Signing for release

To publish on the Play Store, generate a keystore and add signing config to `android/android/app/build.gradle`:

```groovy
android {
    signingConfigs {
        release {
            storeFile file(System.getenv("KEYSTORE_PATH") ?: "keystore.jks")
            storePassword System.getenv("KEYSTORE_PASSWORD")
            keyAlias System.getenv("KEY_ALIAS")
            keyPassword System.getenv("KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
        }
    }
}
```

---

## CI / Releases

Two GitHub Actions workflows live in `.github/workflows/`:

| Workflow       | Triggers on             | What it does                                                    |
|----------------|-------------------------|-----------------------------------------------------------------|
| `build.yml`    | Push to main, any PR    | Builds Electron (Win/Linux/macOS) and Android debug APK. Uploads artifacts to the Actions tab (14-day retention). |
| `release.yml`  | Push a `v*` tag         | Builds all platforms and publishes a GitHub Release with all artifacts attached. Tags containing a hyphen are marked as pre-releases. |

### Publishing a release

```bash
git tag v2.1.0
git push origin v2.1.0
```

That is all. The release workflow handles the rest.

### macOS code signing (optional)

Add these repository secrets to enable notarization:

| Secret                | Description                              |
|-----------------------|------------------------------------------|
| `APPLE_CERTIFICATE`   | Base64-encoded `.p12` signing certificate |
| `APPLE_CERTIFICATE_PWD` | Password for the `.p12`               |
| `APPLE_ID`            | Apple ID email                           |
| `APPLE_ID_PWD`        | App-specific password                    |
| `APPLE_TEAM_ID`       | Apple Developer Team ID                  |

---

## Features

### Font loading
- Drag and drop or click Browse. Supported: TTF, OTF, WOFF, WOFF2, FNT (AngelCode text, XML, binary).
- Multiple fonts in one session.
- Variable fonts detected and labelled.

### Preview
- Live text preview with size slider (12 to 200 px).
- Waterfall view at 6 preset sizes.
- Metric guides: ascender, cap height, x-height, baseline, descender (toggle on/off).
- Variable font axes: one slider per axis, live preview as you drag.

### Metadata
- View and edit all name table fields on vector fonts.
- Bitmap (FNT) fonts show read-only stats: atlas size, line height, character count, kerning pairs.

### Convert
- Single export or batch export all loaded fonts.
- Formats: TTF, OTF, WOFF, WOFF2, FNT.

### FNT / AngelCode bitmap font

Fonty is one of the only tools to fully support the AngelCode FNT format in both directions.

**Generating (vector to FNT):**
- Glyph rendering via `opentype.js` `glyph.draw()` with mathematically correct bbox-derived origin placement.
- Proper xoffset, yoffset, xadvance from the font's units-per-em.
- Kerning pairs from `kern`/`GPOS` tables.
- Multi-page atlas with shelf bin-packing.
- Auto atlas size (smallest power-of-2 that fits), or manual.
- Output: Text `.fnt`, XML `.fnt` (Hiero-compatible), Binary BMF v3 (all 5 block types).

**Reading FNT files:**
- Text format, XML format (DOMParser), Binary BMF v3 (all 5 blocks: info, common, pages, chars, kerning).
- Auto-detection by magic bytes, XML declaration, or `info` keyword.

**Charset presets:** ASCII, Extended ASCII, Digits, Alphanumeric, Latin Extended A+B, Cyrillic, Greek, Hiragana, Custom.

### Glyphs
- Full glyph grid with Unicode code points. Click any glyph to copy the character.
- Search by character or hex code.

### CSS snippets
- `@font-face` block, usage example, base64 data URI.
- Variable font `font-variation-settings` with axis ranges annotated.
- One-click copy.

---

## Keyboard shortcuts

| Shortcut       | Action                        |
|----------------|-------------------------------|
| Ctrl/Cmd + O   | Open file picker (web)        |
| Escape         | Close any open modal          |

---

## Architecture

```
index.html       Shell, markup
app.js           UI logic and state
app.css          Design system
lib/
  fonty.js       Core library (parsing, conversion, FNT generation)
desktop/
  main.js        Electron main process
  preload.js     Context bridge
  package.json   Electron build config
android/
  capacitor.config.json   Capacitor project config
  package.json            Capacitor dependencies
  prepare-web.js          Script that copies web assets into android/www/
.github/
  workflows/
    build.yml     CI build workflow
    release.yml   Release workflow
```

---

## Dependencies

| Library      | Version | Purpose                                          |
|--------------|---------|--------------------------------------------------|
| opentype.js  | 1.3.4   | Font parsing and glyph rendering (CDN)           |
| pako         | 2.1.0   | Deflate compression for WOFF output (CDN)        |
| wawoff2      | 2.0.1   | Brotli for WOFF2 (CDN, loaded on demand)         |
| Electron     | 31      | Desktop wrapper (dev dependency)                 |
| Capacitor    | 6       | Android wrapper (dev dependency)                 |

---

## License

GPL-3.0. See `LICENSE` for the full text.

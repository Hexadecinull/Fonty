# Fonty

Font manager, inspector and converter. Best-in-class AngelCode FNT bitmap font support.

---

## Versions

| Version | Location | How to use |
|---------|----------|------------|
| Web     | `/` (root) | Open `index.html` in any modern browser, or deploy to GitHub Pages |
| Desktop | `desktop/` | Electron app with native file dialogs |

The web and desktop versions share the same codebase. Electron features (native dialogs, custom titlebar, folder export) activate automatically when running inside Electron.

---

## Running the web version

Just open `index.html` in a browser. No build step, no server required.

For GitHub Pages, push to the `main` branch and enable Pages from root (`/`).

---

## Running the desktop version

```bash
cd desktop
npm install
npm start
```

### Building a distributable

```bash
npm run build        # auto-detects current platform
npm run build:win    # Windows NSIS installer + portable
npm run build:linux  # AppImage + .deb
npm run build:mac    # .dmg
```

Output goes to `desktop/dist/`.

---

## Features

### Font loading
- Drag and drop from the OS or click Browse.
- Formats: TTF, OTF, WOFF, WOFF2, FNT (AngelCode text, XML, and binary).
- Multiple fonts loaded at once, listed in the sidebar.
- Variable fonts are detected and labelled.

### Preview
- Live preview with editable text and font size slider (12 to 200 px).
- Waterfall view at 6 standard sizes.
- Metric guides (ascender, cap height, x-height, baseline, descender) toggle on/off.
- Variable font axes: sliders for every axis with live preview.

### Metadata (vector fonts)
- Inspect and edit all name table fields: family, subfamily, PostScript name, version, designer, copyright, license, and more.
- Save back to the in-memory font (applied on next export).
- Bitmap (FNT) fonts show read-only stats: atlas size, line height, character count, etc.

### Convert
- Export any loaded font to TTF, OTF, WOFF, WOFF2, or FNT.
- Batch export: all loaded fonts in one go.

### FNT / AngelCode bitmap font

This is the core differentiator. Most tools produce broken or incomplete FNT files.

**Generation (vector to FNT):**
- Accurate glyph rendering via opentype.js `glyph.draw()` with exact bbox placement.
  Coordinate contract: `x = atlasX - bbox.x1 * scale`, `y = atlasY + bbox.y2 * scale`,
  which positions each glyph cell exactly at its recorded atlas coordinates.
- Proper metrics: xoffset, yoffset, xadvance all derived from the font's units-per-em.
- Kerning pairs: extracted via `font.getKerningValue()` for every character pair in the charset.
- Multi-page atlas: glyphs that overflow one page automatically spill to a new page.
- Shelf bin-packing: glyphs sorted by height for efficient packing.
- Auto atlas size: smallest power-of-2 that fits the charset (with 30% slack), or manually set.
- Three output formats:
  - Text: standard `.fnt` compatible with all AngelCode-aware engines.
  - XML: Hiero-style XML `.fnt`.
  - Binary: full BMF v3 binary format with all 5 block types (info, common, pages, chars, kerning).

**Parsing (reading FNT files):**
- Text format: full attribute parser.
- Binary format: all 5 block types including info (face name, smooth, bold, italic flags), pages, and kerning.
- XML format: DOMParser-based, compatible with Hiero and AngelCode XML exports.
- Auto-detection: BMF magic bytes, XML declaration, or `info` tag.

**Charset presets:**
- ASCII (95 printable characters)
- Extended ASCII (224 characters, 32-255)
- Digits, Alphanumeric
- Latin Extended A+B (with diacritics)
- ASCII + Cyrillic
- ASCII + Greek
- ASCII + Hiragana
- Custom (type anything)

### Glyphs
- Grid of all glyphs in the font with Unicode code points.
- Search by character or by hex code (`U+0041` or just `0041`).
- Click any glyph to copy the character to the clipboard.
- Up to 600 glyphs shown at once, search narrows the set.

### CSS snippets (new in v2.1)
- Ready-to-paste `@font-face` block.
- Usage example with `font-family`.
- Base64 data URI.
- Variable font `font-variation-settings` snippet with axis ranges annotated.
- One-click copy buttons throughout.

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| Ctrl/Cmd + O | Open file picker (web) |
| Escape | Close any open modal |

---

## Architecture

```
index.html       Main HTML shell
app.js           UI logic, event handling, state management
app.css          Design system and component styles
lib/
  fonty.js       Core library: parsing, conversion, FNT generation
```

The library (`lib/fonty.js`) has no build step. It wraps itself in a UMD pattern and exports `Fonty` to the global scope (browser) or via `module.exports` (Node.js / Electron main). It depends on `opentype.js` (font parsing and glyph rendering) and `pako` (WOFF zlib compression).

---

## Dependencies (loaded from CDN)

| Library | Version | Purpose |
|---------|---------|---------|
| opentype.js | 1.3.4 | TTF/OTF/WOFF parsing and glyph rendering |
| pako | 2.1.0 | Deflate compression for WOFF output |
| wawoff2 | 2.0.1 | Brotli decompression/compression for WOFF2 (optional, loaded on demand) |

---

## License

MIT

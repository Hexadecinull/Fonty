/**
 * Fonty Web Library v1.0.0
 * Font parsing, metadata editing, and format conversion for the browser.
 *
 * Required (load before fonty.js):
 *   opentype.js  https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js
 *   pako         https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js
 *
 * Optional:
 *   jszip        https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
 *   wawoff2      https://cdn.jsdelivr.net/npm/wawoff2@2.0.1/build/decompress_binding.js
 *                (required for WOFF2 read/write support)
 *
 * @license MIT
 */

(function (global) {
  'use strict';

  // ─────────────────────────────────────────────────────────────────────────────
  // Constants
  // ─────────────────────────────────────────────────────────────────────────────

  const FORMAT = Object.freeze({
    TTF:   'ttf',
    OTF:   'otf',
    WOFF:  'woff',
    WOFF2: 'woff2',
    FNT:   'fnt',
  });

  const MIME_TYPES = Object.freeze({
    ttf:   'font/ttf',
    otf:   'font/otf',
    woff:  'font/woff',
    woff2: 'font/woff2',
    fnt:   'application/octet-stream',
  });

  // SFNT/WOFF magic signatures
  const SIG_WOFF2 = 0x774F4632; // 'wOF2'
  const SIG_WOFF  = 0x774F4646; // 'wOFF'
  const SIG_TTF   = 0x00010000;
  const SIG_TRUE  = 0x74727565; // 'true' — older Mac TTFs
  const SIG_TYP1  = 0x74797031; // 'typ1'
  const SIG_OTF   = 0x4F54544F; // 'OTTO' — CFF/OTF

  // ─────────────────────────────────────────────────────────────────────────────
  // Format Detection
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Detect font format from binary buffer and optional filename.
   * @param {ArrayBuffer} buffer
   * @param {string} [filename]
   * @returns {string|null} One of FORMAT values, or null if unrecognized
   */
  function detectFormat(buffer, filename) {
    if (!buffer || buffer.byteLength < 4) return null;
    const view = new DataView(buffer);
    const sig  = view.getUint32(0);

    if (sig === SIG_WOFF2) return FORMAT.WOFF2;
    if (sig === SIG_WOFF)  return FORMAT.WOFF;
    if (sig === SIG_TTF || sig === SIG_TRUE || sig === SIG_TYP1) return FORMAT.TTF;
    if (sig === SIG_OTF)   return FORMAT.OTF;

    // Binary AngelCode FNT: starts with 'BMF'
    const b = new Uint8Array(buffer, 0, Math.min(5, buffer.byteLength));
    if (b[0] === 0x42 && b[1] === 0x4D && b[2] === 0x46) return FORMAT.FNT;

    // Text AngelCode FNT: starts with 'info'
    const peek = new TextDecoder('utf-8', { fatal: false })
      .decode(new Uint8Array(buffer, 0, Math.min(5, buffer.byteLength)));
    if (peek.startsWith('info')) return FORMAT.FNT;

    // Fallback: file extension
    if (filename) {
      const ext = filename.split('.').pop().toLowerCase();
      if (Object.values(FORMAT).includes(ext)) return ext;
    }

    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SFNT Table Reader
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Read the table directory of an SFNT font (TTF/OTF).
   * @param {ArrayBuffer} buffer
   * @returns {{ tag: string, checksum: number, offset: number, length: number }[]}
   */
  function readSFNTTables(buffer) {
    const view = new DataView(buffer);
    const numTables = view.getUint16(4);
    const tables = [];
    for (let i = 0; i < numTables; i++) {
      const base = 12 + i * 16;
      const tag = String.fromCharCode(
        view.getUint8(base),     view.getUint8(base + 1),
        view.getUint8(base + 2), view.getUint8(base + 3)
      );
      tables.push({
        tag,
        checksum: view.getUint32(base + 4),
        offset:   view.getUint32(base + 8),
        length:   view.getUint32(base + 12),
      });
    }
    return tables;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WOFF Builder  (SFNT → WOFF)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Convert an SFNT (TTF/OTF) ArrayBuffer into a WOFF ArrayBuffer.
   * Uses pako for deflate compression of individual tables.
   * @param {ArrayBuffer} sfntBuffer
   * @returns {ArrayBuffer}
   */
  function sfntToWOFF(sfntBuffer) {
    if (typeof pako === 'undefined') {
      throw new Error('pako library is required for WOFF encoding. Load pako before fonty.js.');
    }

    const view   = new DataView(sfntBuffer);
    const flavor = view.getUint32(0);     // preserve TTF/OTF flavor
    const tables = readSFNTTables(sfntBuffer);

    // Compress each table; keep uncompressed if deflate doesn't help
    const entries = tables.map(t => {
      const orig = new Uint8Array(sfntBuffer, t.offset, t.length);
      const comp = pako.deflate(orig, { level: 9 });
      const useComp = comp.byteLength < t.length;
      return {
        tag:        t.tag,
        checksum:   t.checksum,
        origLength: t.length,
        compLength: useComp ? comp.byteLength : t.length,
        data:       useComp ? comp : orig,
      };
    });

    // Calculate offsets, padding each block to 4-byte boundary
    const WOFF_HEADER  = 44;
    const WOFF_DIR_SZ  = 20;
    let offset = WOFF_HEADER + entries.length * WOFF_DIR_SZ;
    entries.forEach(e => {
      e.woffOffset = offset;
      offset += e.compLength;
      offset += (4 - (offset % 4)) % 4;   // 4-byte align
    });

    const totalLength = offset;
    const out  = new ArrayBuffer(totalLength);
    const outV = new DataView(out);
    const outB = new Uint8Array(out);

    // ── WOFF Header (44 bytes) ──
    outV.setUint32(0,  SIG_WOFF);
    outV.setUint32(4,  flavor);
    outV.setUint32(8,  totalLength);
    outV.setUint16(12, entries.length);
    outV.setUint16(14, 0);                      // reserved
    outV.setUint32(16, sfntBuffer.byteLength);  // totalSfntSize
    outV.setUint16(20, 1);                      // majorVersion
    outV.setUint16(22, 0);                      // minorVersion
    outV.setUint32(24, 0);                      // metaOffset  (none)
    outV.setUint32(28, 0);                      // metaLength
    outV.setUint32(32, 0);                      // metaOrigLength
    outV.setUint32(36, 0);                      // privOffset  (none)
    outV.setUint32(40, 0);                      // privLength

    // ── Table Directory + Data ──
    entries.forEach((e, i) => {
      const base = WOFF_HEADER + i * WOFF_DIR_SZ;
      for (let j = 0; j < 4; j++) outV.setUint8(base + j, e.tag.charCodeAt(j));
      outV.setUint32(base + 4,  e.woffOffset);
      outV.setUint32(base + 8,  e.compLength);
      outV.setUint32(base + 12, e.origLength);
      outV.setUint32(base + 16, e.checksum);
      outB.set(e.data, e.woffOffset);
    });

    return out;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // AngelCode FNT Parser
  // ─────────────────────────────────────────────────────────────────────────────

  /** Parse text-format AngelCode .fnt */
  function _parseFNTText(buffer) {
    const text   = new TextDecoder().decode(buffer);
    const result = { info: {}, common: {}, pages: [], chars: new Map(), kernings: [] };

    const parseAttrs = raw => {
      const attrs = {};
      const re = /(\w+)=("([^"]*)"|(-?\d+(?:,-?\d+)*))/g;
      let m;
      while ((m = re.exec(raw)) !== null) {
        const val = m[3] !== undefined ? m[3] : m[4];
        attrs[m[1]] = val.includes(',')
          ? val.split(',').map(Number)
          : (isNaN(val) ? val : Number(val));
      }
      return attrs;
    };

    for (const line of text.split(/\r?\n/)) {
      const type  = line.split(' ')[0];
      const attrs = parseAttrs(line);
      switch (type) {
        case 'info':    result.info = attrs; break;
        case 'common':  result.common = attrs; break;
        case 'page':    result.pages.push(attrs); break;
        case 'char':    result.chars.set(attrs.id, attrs); break;
        case 'kerning': result.kernings.push(attrs); break;
      }
    }
    return result;
  }

  /** Parse binary-format AngelCode .fnt (BMF magic) */
  function _parseFNTBinary(buffer) {
    const view   = new DataView(buffer);
    const result = { info: {}, common: {}, pages: [], chars: new Map(), kernings: [] };
    let pos = 4; // skip 'BMF' + version

    while (pos + 5 <= buffer.byteLength) {
      const blockType = view.getUint8(pos);
      const blockSize = view.getUint32(pos + 1, true);
      pos += 5;

      if (blockType === 2 && blockSize >= 15) {
        result.common = {
          lineHeight: view.getUint16(pos,     true),
          base:       view.getUint16(pos + 2, true),
          scaleW:     view.getUint16(pos + 4, true),
          scaleH:     view.getUint16(pos + 6, true),
          pages:      view.getUint16(pos + 8, true),
        };
      } else if (blockType === 4) {
        const count = Math.floor(blockSize / 20);
        for (let i = 0; i < count; i++) {
          const b = pos + i * 20;
          const id = view.getUint32(b, true);
          result.chars.set(id, {
            id,
            x:        view.getUint16(b + 4,  true),
            y:        view.getUint16(b + 6,  true),
            width:    view.getUint16(b + 8,  true),
            height:   view.getUint16(b + 10, true),
            xoffset:  view.getInt16(b + 12,  true),
            yoffset:  view.getInt16(b + 14,  true),
            xadvance: view.getInt16(b + 16,  true),
            page:     view.getUint8(b + 18),
            chnl:     view.getUint8(b + 19),
          });
        }
      }
      pos += blockSize;
    }
    return result;
  }

  /**
   * Parse an AngelCode .fnt file (text or binary format).
   * @param {ArrayBuffer} buffer
   * @returns {{ info, common, pages, chars: Map, kernings }}
   */
  function parseFNT(buffer) {
    const b = new Uint8Array(buffer, 0, 3);
    if (b[0] === 0x42 && b[1] === 0x4D && b[2] === 0x46) return _parseFNTBinary(buffer);
    return _parseFNTText(buffer);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Vector → FNT Rasterizer
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Rasterize a vector (opentype.js) font into AngelCode bitmap font format.
   * Returns the .fnt text content and a PNG atlas as a data URL.
   *
   * @param {object} otFont  opentype.js font object
   * @param {{ size?, padding?, spacing?, charset? }} options
   * @returns {{ fnt: string, pngDataURL: string }}
   */
  function fontToFNT(otFont, options = {}) {
    const {
      size    = 32,
      padding = 2,
      spacing = 1,
      charset = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~',
    } = options;

    const canvas  = document.createElement('canvas');
    const ctx     = canvas.getContext('2d');
    const familyID = `fonty-rast-${Date.now()}`;
    const dataURL  = _otFontToDataURL(otFont);

    // Inject @font-face
    const style = document.createElement('style');
    style.textContent = `@font-face{font-family:'${familyID}';src:url('${dataURL}')}`;
    document.head.appendChild(style);

    // Trigger font load with a quick render
    canvas.width = 1; canvas.height = 1;
    ctx.font = `${size}px '${familyID}'`;
    ctx.fillText('A', 0, 0);

    // Measure each unique character
    ctx.font = `${size}px '${familyID}'`;
    const chars   = [...new Set(charset)];
    const metrics = chars.map(ch => {
      const m = ctx.measureText(ch);
      return {
        ch,
        width:    Math.max(1, Math.ceil(m.width)),
        height:   size,
        xoffset:  0,
        yoffset:  0,
        xadvance: Math.ceil(m.width),
      };
    });

    // Row-pack glyphs into atlas
    const ATLAS_W = 512;
    let x = padding, y = padding, rowH = 0;
    metrics.forEach(m => {
      if (x + m.width + padding > ATLAS_W) {
        x = padding;
        y += rowH + spacing + padding;
        rowH = 0;
      }
      m.atlasX = x;
      m.atlasY = y;
      x += m.width + spacing + padding;
      rowH = Math.max(rowH, m.height);
    });

    const ATLAS_H = _nextPow2(y + rowH + padding);
    canvas.width  = ATLAS_W;
    canvas.height = ATLAS_H;
    ctx.clearRect(0, 0, ATLAS_W, ATLAS_H);
    ctx.font         = `${size}px '${familyID}'`;
    ctx.fillStyle    = '#ffffff';
    ctx.textBaseline = 'top';
    metrics.forEach(m => ctx.fillText(m.ch, m.atlasX, m.atlasY));

    document.head.removeChild(style);

    // Build FNT text file
    const face = otFont.names?.fontFamily?.en || 'Unknown';
    const fntLines = [
      `info face="${face}" size=${size} bold=0 italic=0 charset="" unicode=1 stretchH=100 smooth=1 aa=1 padding=${padding},${padding},${padding},${padding} spacing=${spacing},${spacing}`,
      `common lineHeight=${size} base=${size} scaleW=${ATLAS_W} scaleH=${ATLAS_H} pages=1 packed=0`,
      `page id=0 file="0.png"`,
      `chars count=${metrics.length}`,
      ...metrics.map(m =>
        `char id=${m.ch.codePointAt(0)} x=${m.atlasX} y=${m.atlasY} width=${m.width} height=${m.height} xoffset=${m.xoffset} yoffset=${m.yoffset} xadvance=${m.xadvance} page=0 chnl=15`
      ),
    ];

    return { fnt: fntLines.join('\n'), pngDataURL: canvas.toDataURL('image/png') };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // WOFF2 Lazy Module Loader
  // ─────────────────────────────────────────────────────────────────────────────

  let _woff2Promise = null;
  let _woff2Module  = null;

  /**
   * Lazily load the wawoff2 WASM module from CDN.
   * Resolves with the Module object; rejects if load fails.
   * @returns {Promise<object>}
   */
  function loadWOFF2Module() {
    if (_woff2Module)  return Promise.resolve(_woff2Module);
    if (_woff2Promise) return _woff2Promise;

    _woff2Promise = new Promise((resolve, reject) => {
      // If already initialized synchronously
      if (typeof Module !== 'undefined' && typeof Module.decompress === 'function') {
        _woff2Module = Module;
        return resolve(_woff2Module);
      }

      // Inject Module config before loading the script
      const prev = global.Module;
      global.Module = {
        onRuntimeInitialized() {
          _woff2Module = global.Module;
          resolve(_woff2Module);
        },
      };

      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/wawoff2@2.0.1/build/decompress_binding.js';
      s.onerror = () => {
        global.Module = prev;
        _woff2Promise = null;
        reject(new Error('Failed to load wawoff2 — WOFF2 support unavailable.'));
      };
      document.head.appendChild(s);
    });

    return _woff2Promise;
  }

  /** @returns {boolean} true if the WOFF2 WASM module is currently loaded */
  function isWOFF2Available() {
    return _woff2Module !== null ||
      (typeof Module !== 'undefined' && typeof Module.decompress === 'function');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Internal Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  function _nextPow2(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
  }

  function _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary  = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  function _otFontToDataURL(otFont) {
    return `data:font/ttf;base64,${_arrayBufferToBase64(otFont.toArrayBuffer())}`;
  }

  function _basename(filename) {
    return String(filename).replace(/\.[^.]+$/, '');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Trigger a browser download of an ArrayBuffer.
   * @param {ArrayBuffer} buffer
   * @param {string} filename
   * @param {string} [mimeType]
   */
  function downloadBuffer(buffer, filename, mimeType = 'application/octet-stream') {
    const blob = new Blob([buffer], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    URL.revokeObjectURL(url);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // FontyFont — Main Class
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Represents a single loaded font with full read/write/convert capability.
   *
   * Usage:
   *   const font = await FontyFont.fromFile(file);
   *   const woffBuffer = await font.toWOFF();
   *   font.setMetadata({ designer: 'Jane Doe' });
   */
  class FontyFont {
    constructor() {
      this._id       = Math.random().toString(36).slice(2, 10);
      this._filename = '';
      this._buffer   = null;   // original raw bytes
      this._sfntBuf  = null;   // SFNT bytes (may differ from _buffer for WOFF2)
      this._format   = null;
      this._otFont   = null;   // opentype.js font object
      this._fntData  = null;   // parsed AngelCode FNT data
    }

    // ── Static constructors ────────────────────────────────────────────────

    /** Load from a browser File object */
    static async fromFile(file) {
      const inst = new FontyFont();
      inst._filename = file.name;
      inst._buffer   = await file.arrayBuffer();
      await inst._init();
      return inst;
    }

    /** Load from an ArrayBuffer (or TypedArray) */
    static async fromBuffer(buffer, filename = 'font') {
      const inst = new FontyFont();
      inst._filename = filename;
      inst._buffer   = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
      await inst._init();
      return inst;
    }

    async _init() {
      if (!this._buffer || this._buffer.byteLength === 0) {
        throw new Error(`Empty buffer for "${this._filename}"`);
      }

      this._format = detectFormat(this._buffer, this._filename);
      if (!this._format) {
        throw new Error(`Unrecognized font format: "${this._filename}"`);
      }

      // FNT is bitmap-only — parse it and return early
      if (this._format === FORMAT.FNT) {
        this._fntData = parseFNT(this._buffer);
        return;
      }

      // WOFF2 requires WASM decompression before opentype.js can parse it
      if (this._format === FORMAT.WOFF2) {
        const wasm = await loadWOFF2Module();
        const decompressed = wasm.decompress(new Uint8Array(this._buffer));
        this._sfntBuf = decompressed.buffer;
      } else {
        // TTF, OTF, WOFF — opentype.js handles all natively
        this._sfntBuf = this._buffer;
      }

      try {
        this._otFont = opentype.parse(this._sfntBuf);
      } catch (e) {
        throw new Error(`Failed to parse "${this._filename}": ${e.message}`);
      }
    }

    // ── Identity & Info ────────────────────────────────────────────────────

    /** Unique runtime ID for this font instance */
    get id()       { return this._id; }
    /** Original filename (e.g. "MyFont-Regular.ttf") */
    get filename() { return this._filename; }
    /** Detected format string: 'ttf' | 'otf' | 'woff' | 'woff2' | 'fnt' */
    get format()   { return this._format; }
    /** True if this is a bitmap (FNT) font — vector operations unavailable */
    get isBitmap() { return this._format === FORMAT.FNT; }

    get glyphCount() { return this._otFont?.glyphs?.length  ?? 0; }
    get unitsPerEm() { return this._otFont?.unitsPerEm      ?? 1000; }
    get ascender()   { return this._otFont?.ascender        ?? 0; }
    get descender()  { return this._otFont?.descender       ?? 0; }

    // ── Metadata ───────────────────────────────────────────────────────────

    /**
     * Get font metadata from the 'name' table.
     * @returns {object} Flat key/value map of metadata fields.
     */
    getMetadata() {
      if (this.isBitmap) {
        return {
          family:    this._fntData?.info?.face || _basename(this._filename),
          subfamily: 'Regular',
          isBitmap:  true,
          fntSize:   this._fntData?.info?.size ?? null,
        };
      }
      if (!this._otFont) return {};

      const n = this._otFont.names;
      const g = k => n[k]?.en || n[k]?.[''] || '';

      return {
        family:          g('fontFamily'),
        subfamily:       g('fontSubfamily'),
        fullName:        g('fullName'),
        postScriptName:  g('postScriptName'),
        version:         g('version'),
        copyright:       g('copyright'),
        trademark:       g('trademark'),
        manufacturer:    g('manufacturer'),
        manufacturerURL: g('manufacturerURL'),
        designer:        g('designer'),
        designerURL:     g('designerURL'),
        description:     g('description'),
        license:         g('license'),
        licenseURL:      g('licenseURL'),
        uniqueID:        g('uniqueSubfamilyID'),
      };
    }

    /**
     * Patch font metadata. Only provided keys are updated; others left unchanged.
     * Changes are reflected in the next toTTF()/toWOFF()/etc. call.
     * @param {object} patch
     */
    setMetadata(patch) {
      if (!this._otFont) return;

      const MAP = {
        family:          'fontFamily',
        subfamily:       'fontSubfamily',
        fullName:        'fullName',
        postScriptName:  'postScriptName',
        version:         'version',
        copyright:       'copyright',
        trademark:       'trademark',
        manufacturer:    'manufacturer',
        manufacturerURL: 'manufacturerURL',
        designer:        'designer',
        designerURL:     'designerURL',
        description:     'description',
        license:         'license',
        licenseURL:      'licenseURL',
        uniqueID:        'uniqueSubfamilyID',
      };

      for (const [key, otKey] of Object.entries(MAP)) {
        if (key in patch) {
          this._otFont.names[otKey] = { en: String(patch[key]) };
        }
      }
    }

    // ── Conversion ─────────────────────────────────────────────────────────

    /** @returns {Promise<ArrayBuffer>} SFNT (TTF/OTF) bytes */
    async toArrayBuffer() {
      if (this.isBitmap) throw new Error('Bitmap fonts cannot be exported as vector formats.');
      return this._otFont.toArrayBuffer();
    }

    /** @returns {Promise<ArrayBuffer>} TrueType/OpenType SFNT bytes */
    async toTTF() { return this.toArrayBuffer(); }

    /**
     * Re-packages the font into an OTF container.
     * Note: this preserves the original outline type (TrueType or CFF).
     * True CFF outline conversion is not performed.
     * @returns {Promise<ArrayBuffer>}
     */
    async toOTF() { return this.toArrayBuffer(); }

    /** @returns {Promise<ArrayBuffer>} WOFF bytes (zlib-compressed tables) */
    async toWOFF() {
      return sfntToWOFF(await this.toArrayBuffer());
    }

    /**
     * Encode to WOFF2 (Brotli-compressed, transformed tables).
     * Requires the wawoff2 WASM module to be loaded.
     * @returns {Promise<ArrayBuffer>}
     */
    async toWOFF2() {
      const wasm = await loadWOFF2Module();
      if (typeof wasm.compress !== 'function') {
        throw new Error(
          'WOFF2 encoding requires the compress_binding from wawoff2. ' +
          'Decompress-only module is loaded — load compress_binding.js as well.'
        );
      }
      const sfnt = new Uint8Array(await this.toArrayBuffer());
      return wasm.compress(sfnt).buffer;
    }

    /**
     * Rasterize to AngelCode bitmap font format.
     * @param {{ size?, padding?, spacing?, charset? }} [options]
     * @returns {Promise<{ fnt: string, pngDataURL: string }>}
     */
    async toFNT(options = {}) {
      if (this.isBitmap) throw new Error('Font is already a bitmap (FNT) format.');
      return fontToFNT(this._otFont, options);
    }

    /**
     * Convert to any supported format.
     * @param {'ttf'|'otf'|'woff'|'woff2'|'fnt'} targetFormat
     * @param {object} [options]  passed to toFNT() when targetFormat is 'fnt'
     * @returns {Promise<{ buffer: ArrayBuffer, ext: string } | { fnt: string, pngDataURL: string, ext: 'fnt' }>}
     */
    async convert(targetFormat, options = {}) {
      switch (targetFormat) {
        case FORMAT.TTF:   return { buffer: await this.toTTF(),   ext: 'ttf' };
        case FORMAT.OTF:   return { buffer: await this.toOTF(),   ext: 'otf' };
        case FORMAT.WOFF:  return { buffer: await this.toWOFF(),  ext: 'woff' };
        case FORMAT.WOFF2: return { buffer: await this.toWOFF2(), ext: 'woff2' };
        case FORMAT.FNT: {
          const res = await this.toFNT(options);
          return { ...res, ext: 'fnt' };
        }
        default:
          throw new Error(`Unknown target format: "${targetFormat}"`);
      }
    }

    // ── Preview / CSS ──────────────────────────────────────────────────────

    /** @returns {string} data: URL of this font for use in CSS */
    getPreviewDataURL() {
      const b64  = _arrayBufferToBase64(this._buffer);
      const mime = MIME_TYPES[this._format] || 'font/ttf';
      return `data:${mime};base64,${b64}`;
    }

    /**
     * CSS @font-face declaration that loads this font.
     * Inject into a <style> element to enable CSS font-family usage.
     * @returns {string}
     */
    getCSSFontFace() {
      return `@font-face{font-family:'fonty-${this._id}';src:url('${this.getPreviewDataURL()}');}`;
    }

    /** CSS font-family string to use in element styles */
    get cssFamily() { return `'fonty-${this._id}'`; }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Module Export
  // ─────────────────────────────────────────────────────────────────────────────

  const Fonty = {
    version: '1.0.0',

    // Core class
    FontyFont,

    // Constants
    FORMAT,
    MIME_TYPES,

    // Low-level functions (for library consumers)
    detectFormat,
    sfntToWOFF,
    parseFNT,
    fontToFNT,

    // Download helper
    downloadBuffer,

    // WOFF2 WASM management
    loadWOFF2Module,
    isWOFF2Available,

    // Utilities
    utils: {
      arrayBufferToBase64: _arrayBufferToBase64,
      otFontToDataURL:     _otFontToDataURL,
      basename:            _basename,
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Fonty;
  } else {
    global.Fonty = Fonty;
  }

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

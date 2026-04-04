/**
 * Fonty Library v2.1.0
 * Font parsing, metadata editing, and format conversion.
 *
 * Requires (load before fonty.js):
 *   opentype.js  https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js
 *   pako         https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js
 *
 * Optional:
 *   wawoff2      https://cdn.jsdelivr.net/npm/wawoff2@2.0.1/build/decompress_binding.js
 *
 * @license MIT
 */

(function (global) {
  'use strict';

  // ===========================================================================
  // Constants
  // ===========================================================================

  const FORMAT = Object.freeze({
    TTF: 'ttf', OTF: 'otf', WOFF: 'woff', WOFF2: 'woff2', FNT: 'fnt',
  });

  const FNT_OUTPUT = Object.freeze({ TEXT: 'text', XML: 'xml', BINARY: 'binary' });

  const MIME_TYPES = Object.freeze({
    ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
    fnt: 'application/octet-stream',
  });

  const CHARSET_PRESETS = Object.freeze({
    ASCII: _charRange(32, 126),
    EXTENDED_ASCII: _charRange(32, 255),
    DIGITS: '0123456789',
    ALPHANUMERIC: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    LATIN_EXTENDED_A: _charRange(32, 126) + _charRange(0xC0, 0x17E),
    CYRILLIC: _charRange(32, 126) + _charRange(0x0410, 0x044F) + '\u0401\u0451',
    GREEK: _charRange(32, 126) + _charRange(0x0391, 0x03C9),
    HIRAGANA: _charRange(32, 126) + _charRange(0x3041, 0x3096),
  });

  function _charRange(from, to) {
    let s = '';
    for (let i = from; i <= to; i++) s += String.fromCodePoint(i);
    return s;
  }

  const SIG_WOFF2 = 0x774F4632, SIG_WOFF = 0x774F4646;
  const SIG_TTF   = 0x00010000, SIG_TRUE = 0x74727565;
  const SIG_TYP1  = 0x74797031, SIG_OTF  = 0x4F54544F;

  // ===========================================================================
  // Format Detection
  // ===========================================================================

  function detectFormat(buffer, filename) {
    if (!buffer || buffer.byteLength < 4) return null;
    const view = new DataView(buffer);
    const sig  = view.getUint32(0);

    if (sig === SIG_WOFF2) return FORMAT.WOFF2;
    if (sig === SIG_WOFF)  return FORMAT.WOFF;
    if (sig === SIG_TTF || sig === SIG_TRUE || sig === SIG_TYP1) return FORMAT.TTF;
    if (sig === SIG_OTF)   return FORMAT.OTF;

    const b    = new Uint8Array(buffer, 0, Math.min(5, buffer.byteLength));
    const peek = new TextDecoder('utf-8', { fatal: false })
      .decode(new Uint8Array(buffer, 0, Math.min(30, buffer.byteLength)));

    if (b[0] === 0x42 && b[1] === 0x4D && b[2] === 0x46) return FORMAT.FNT;
    if (peek.startsWith('info') || peek.includes('<?xml') || peek.trimStart().startsWith('<font'))
      return FORMAT.FNT;

    if (filename) {
      const ext = filename.split('.').pop().toLowerCase();
      if (Object.values(FORMAT).includes(ext)) return ext;
    }
    return null;
  }

  // ===========================================================================
  // SFNT Table Reader
  // ===========================================================================

  function readSFNTTables(buffer) {
    const view = new DataView(buffer);
    const n    = view.getUint16(4);
    const out  = [];
    for (let i = 0; i < n; i++) {
      const base = 12 + i * 16;
      const tag  = String.fromCharCode(
        view.getUint8(base), view.getUint8(base + 1),
        view.getUint8(base + 2), view.getUint8(base + 3)
      );
      out.push({ tag, checksum: view.getUint32(base + 4),
                 offset: view.getUint32(base + 8), length: view.getUint32(base + 12) });
    }
    return out;
  }

  // ===========================================================================
  // WOFF Builder
  // ===========================================================================

  function sfntToWOFF(sfntBuffer) {
    if (typeof pako === 'undefined') throw new Error('pako is required for WOFF encoding.');
    const view   = new DataView(sfntBuffer);
    const flavor = view.getUint32(0);
    const tables = readSFNTTables(sfntBuffer);

    const entries = tables.map(t => {
      const orig = new Uint8Array(sfntBuffer, t.offset, t.length);
      const comp = pako.deflate(orig, { level: 9 });
      const use  = comp.byteLength < t.length;
      return { tag: t.tag, checksum: t.checksum, origLength: t.length,
               compLength: use ? comp.byteLength : t.length, data: use ? comp : orig };
    });

    const HDR = 44, DIR = 20;
    let off = HDR + entries.length * DIR;
    entries.forEach(e => { e.off = off; off += e.compLength; off += (4 - off % 4) % 4; });

    const out  = new ArrayBuffer(off);
    const outV = new DataView(out);
    const outB = new Uint8Array(out);

    outV.setUint32(0, SIG_WOFF); outV.setUint32(4, flavor); outV.setUint32(8, off);
    outV.setUint16(12, entries.length); outV.setUint32(16, sfntBuffer.byteLength);
    outV.setUint16(20, 1);

    entries.forEach((e, i) => {
      const b = HDR + i * DIR;
      for (let j = 0; j < 4; j++) outV.setUint8(b + j, e.tag.charCodeAt(j));
      outV.setUint32(b + 4, e.off); outV.setUint32(b + 8, e.compLength);
      outV.setUint32(b + 12, e.origLength); outV.setUint32(b + 16, e.checksum);
      outB.set(e.data, e.off);
    });

    return out;
  }

  // ===========================================================================
  // FNT Parsers
  // ===========================================================================

  function _parseFNTText(buffer) {
    const text   = new TextDecoder().decode(buffer);
    const result = { info: {}, common: {}, pages: [], chars: new Map(), kernings: [] };
    const attrs  = raw => {
      const o = {}, re = /(\w+)=("([^"]*)"|(-?\d+(?:,-?\d+)*))/g;
      let m;
      while ((m = re.exec(raw)) !== null) {
        const v = m[3] !== undefined ? m[3] : m[4];
        o[m[1]] = v.includes(',') ? v.split(',').map(Number) : (isNaN(v) ? v : Number(v));
      }
      return o;
    };
    for (const line of text.split(/\r?\n/)) {
      const type = line.split(' ')[0], a = attrs(line);
      if (type === 'info')    result.info = a;
      else if (type === 'common')  result.common = a;
      else if (type === 'page')    result.pages.push(a);
      else if (type === 'char')    result.chars.set(a.id, a);
      else if (type === 'kerning') result.kernings.push(a);
    }
    return result;
  }

  function _parseFNTBinary(buffer) {
    const view   = new DataView(buffer);
    const result = { info: {}, common: {}, pages: [], chars: new Map(), kernings: [] };
    const dec    = new TextDecoder();
    let pos = 4;

    while (pos + 5 <= buffer.byteLength) {
      const type = view.getUint8(pos), size = view.getUint32(pos + 1, true);
      pos += 5;

      if (type === 1 && size >= 14) {
        const bf = view.getUint8(pos + 2);
        result.info = {
          size: Math.abs(view.getInt16(pos, true)), smooth: !!(bf & 0x80),
          unicode: !!(bf & 0x40), italic: !!(bf & 0x20), bold: !!(bf & 0x10),
          stretchH: view.getUint16(pos + 4, true), aa: view.getUint8(pos + 6),
          paddingUp: view.getUint8(pos + 7), paddingRight: view.getUint8(pos + 8),
          paddingDown: view.getUint8(pos + 9), paddingLeft: view.getUint8(pos + 10),
          spacingHoriz: view.getUint8(pos + 11), spacingVert: view.getUint8(pos + 12),
          outline: view.getUint8(pos + 13),
        };
        if (size > 14) {
          const nb = new Uint8Array(buffer, pos + 14, size - 14);
          const ni = nb.indexOf(0);
          result.info.face = dec.decode(nb.subarray(0, ni === -1 ? undefined : ni));
        }
      } else if (type === 2 && size >= 15) {
        result.common = {
          lineHeight: view.getUint16(pos, true), base: view.getUint16(pos + 2, true),
          scaleW: view.getUint16(pos + 4, true), scaleH: view.getUint16(pos + 6, true),
          pages: view.getUint16(pos + 8, true), packed: !!(view.getUint8(pos + 10) & 1),
          alphaChnl: view.getUint8(pos + 11), redChnl: view.getUint8(pos + 12),
          greenChnl: view.getUint8(pos + 13), blueChnl: view.getUint8(pos + 14),
        };
      } else if (type === 3) {
        const pd = new Uint8Array(buffer, pos, size);
        let start = 0, id = 0;
        for (let i = 0; i <= pd.length; i++) {
          if (i === pd.length || pd[i] === 0) {
            if (i > start) result.pages.push({ id: id++, file: dec.decode(pd.subarray(start, i)) });
            start = i + 1;
          }
        }
      } else if (type === 4) {
        const cnt = Math.floor(size / 20);
        for (let i = 0; i < cnt; i++) {
          const b = pos + i * 20, id = view.getUint32(b, true);
          result.chars.set(id, {
            id, x: view.getUint16(b + 4, true), y: view.getUint16(b + 6, true),
            width: view.getUint16(b + 8, true), height: view.getUint16(b + 10, true),
            xoffset: view.getInt16(b + 12, true), yoffset: view.getInt16(b + 14, true),
            xadvance: view.getInt16(b + 16, true), page: view.getUint8(b + 18),
            chnl: view.getUint8(b + 19),
          });
        }
      } else if (type === 5) {
        const cnt = Math.floor(size / 10);
        for (let i = 0; i < cnt; i++) {
          const b = pos + i * 10;
          result.kernings.push({
            first: view.getUint32(b, true), second: view.getUint32(b + 4, true),
            amount: view.getInt16(b + 8, true),
          });
        }
      }
      pos += size;
    }
    return result;
  }

  function _parseFNTXML(buffer) {
    const text   = new TextDecoder().decode(buffer);
    const result = { info: {}, common: {}, pages: [], chars: new Map(), kernings: [] };
    if (typeof DOMParser === 'undefined') return _parseFNTText(buffer);

    const doc  = new DOMParser().parseFromString(text, 'text/xml');
    const num  = (el, k, d = 0) => { const v = el?.getAttribute(k); return v === null ? d : Number(v); };
    const str  = (el, k, d = '') => el?.getAttribute(k) ?? d;

    const ie = doc.querySelector('info'), ce = doc.querySelector('common');
    if (ie) result.info   = { face: str(ie,'face'), size: Math.abs(num(ie,'size')),
                               bold: num(ie,'bold'), italic: num(ie,'italic'),
                               stretchH: num(ie,'stretchH', 100), smooth: num(ie,'smooth',1),
                               aa: num(ie,'aa',1), outline: num(ie,'outline',0) };
    if (ce) result.common = { lineHeight: num(ce,'lineHeight'), base: num(ce,'base'),
                               scaleW: num(ce,'scaleW'), scaleH: num(ce,'scaleH'),
                               pages: num(ce,'pages',1), packed: !!num(ce,'packed') };

    doc.querySelectorAll('pages > page').forEach(el =>
      result.pages.push({ id: num(el,'id'), file: str(el,'file') })
    );
    doc.querySelectorAll('chars > char').forEach(el => {
      const id = num(el,'id');
      result.chars.set(id, { id, x: num(el,'x'), y: num(el,'y'), width: num(el,'width'),
        height: num(el,'height'), xoffset: num(el,'xoffset'), yoffset: num(el,'yoffset'),
        xadvance: num(el,'xadvance'), page: num(el,'page'), chnl: num(el,'chnl',15) });
    });
    doc.querySelectorAll('kernings > kerning').forEach(el =>
      result.kernings.push({ first: num(el,'first'), second: num(el,'second'), amount: num(el,'amount') })
    );
    return result;
  }

  function parseFNT(buffer) {
    const b    = new Uint8Array(buffer, 0, 5);
    const peek = new TextDecoder('utf-8', { fatal: false })
      .decode(new Uint8Array(buffer, 0, Math.min(30, buffer.byteLength)));
    if (b[0] === 0x42 && b[1] === 0x4D && b[2] === 0x46) return _parseFNTBinary(buffer);
    if (peek.includes('<?xml') || peek.trimStart().startsWith('<font')) return _parseFNTXML(buffer);
    return _parseFNTText(buffer);
  }

  // ===========================================================================
  // FNT Generation - Utilities
  // ===========================================================================

  function _autoAtlasSize(glyphInfos) {
    const totalArea = glyphInfos.reduce((s, g) => s + g.slotW * g.slotH, 0);
    const target    = totalArea * 1.3;
    for (const sz of [64, 128, 256, 512, 1024, 2048, 4096]) {
      if (sz * sz >= target) return sz;
    }
    return 4096;
  }

  /**
   * Shelf bin-pack glyphs.
   * atlasX/atlasY on each glyph = top-left of the CELL (what goes in the .fnt file).
   * Slot = cell + padding on all sides.
   */
  function _shelfPackGlyphs(glyphInfos, atlasW, spacing, padding) {
    const pages = [];
    let curPage = [];
    let slotX = 0, slotY = 0, rowH = 0;

    // Sort tallest first for better packing efficiency
    const sorted = [...glyphInfos].sort((a, b) => b.slotH - a.slotH);

    for (const g of sorted) {
      if (slotX + g.slotW + spacing > atlasW) {
        slotX  = 0;
        slotY += rowH + spacing;
        rowH   = 0;

        // Page overflow: start a new page
        if (slotY + g.slotH > atlasW) {
          if (curPage.length) pages.push(curPage);
          curPage = [];
          slotX = 0; slotY = 0; rowH = 0;
        }
      }

      // Cell starts padding inside the slot
      g.atlasX = slotX + padding;
      g.atlasY = slotY + padding;
      g.page   = pages.length;

      curPage.push(g);
      slotX += g.slotW + spacing;
      rowH   = Math.max(rowH, g.slotH);
    }

    if (curPage.length) pages.push(curPage);
    return pages;
  }

  function _extractKernings(otFont, glyphInfos, scale) {
    const kernings = [];
    if (!otFont.getKerningValue) return kernings;
    for (let i = 0; i < glyphInfos.length; i++) {
      for (let j = 0; j < glyphInfos.length; j++) {
        try {
          const kv = otFont.getKerningValue(glyphInfos[i].glyph, glyphInfos[j].glyph);
          if (kv !== 0) {
            const scaled = Math.round(kv * scale);
            if (scaled !== 0) kernings.push({ first: glyphInfos[i].cp, second: glyphInfos[j].cp, amount: scaled });
          }
        } catch (_) {}
      }
    }
    return kernings;
  }

  // ===========================================================================
  // FNT Generation - Serializers
  // ===========================================================================

  function _buildFNTText({ face, size, lineHeight, base, padding, spacing,
                            renderedPages, kernings, pageNames }) {
    const L = [];
    const all = renderedPages.flatMap((p, pi) => p.items.map(g => ({ ...g, pi })));
    L.push(`info face="${face}" size=${size} bold=0 italic=0 charset="" unicode=1 stretchH=100 smooth=1 aa=1 padding=${padding},${padding},${padding},${padding} spacing=${spacing},${spacing}`);
    L.push(`common lineHeight=${lineHeight} base=${base} scaleW=${renderedPages[0]?.width||512} scaleH=${renderedPages[0]?.height||512} pages=${renderedPages.length} packed=0`);
    renderedPages.forEach((_, i) => L.push(`page id=${i} file="${pageNames[i]}"`));
    L.push(`chars count=${all.length}`);
    for (const g of all) {
      L.push(`char id=${g.cp} x=${g.atlasX} y=${g.atlasY} width=${g.isEmpty?0:g.width} height=${g.isEmpty?0:g.height} xoffset=${g.xoffset} yoffset=${g.yoffset} xadvance=${g.xadvance} page=${g.pi} chnl=15`);
    }
    if (kernings.length) {
      L.push(`kernings count=${kernings.length}`);
      for (const k of kernings) L.push(`kerning first=${k.first} second=${k.second} amount=${k.amount}`);
    }
    return L.join('\n');
  }

  function _buildFNTXML({ face, size, lineHeight, base, padding, spacing,
                           renderedPages, kernings, pageNames }) {
    const esc = s => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    const scaleW = renderedPages[0]?.width  || 512;
    const scaleH = renderedPages[0]?.height || 512;
    const all    = renderedPages.flatMap((p, pi) => p.items.map(g => ({ ...g, pi })));
    const L      = [];
    L.push('<?xml version="1.0"?>');
    L.push('<font>');
    L.push(`  <info face="${esc(face)}" size="${size}" bold="0" italic="0" charset="" unicode="1" stretchH="100" smooth="1" aa="1" padding="${padding},${padding},${padding},${padding}" spacing="${spacing},${spacing}" outline="0"/>`);
    L.push(`  <common lineHeight="${lineHeight}" base="${base}" scaleW="${scaleW}" scaleH="${scaleH}" pages="${renderedPages.length}" packed="0" alphaChnl="0" redChnl="0" greenChnl="0" blueChnl="0"/>`);
    L.push('  <pages>');
    renderedPages.forEach((_, i) => L.push(`    <page id="${i}" file="${esc(pageNames[i])}"/>`));
    L.push('  </pages>');
    L.push(`  <chars count="${all.length}">`);
    for (const g of all) {
      L.push(`    <char id="${g.cp}" x="${g.atlasX}" y="${g.atlasY}" width="${g.isEmpty?0:g.width}" height="${g.isEmpty?0:g.height}" xoffset="${g.xoffset}" yoffset="${g.yoffset}" xadvance="${g.xadvance}" page="${g.pi}" chnl="15"/>`);
    }
    L.push('  </chars>');
    if (kernings.length) {
      L.push(`  <kernings count="${kernings.length}">`);
      for (const k of kernings) L.push(`    <kerning first="${k.first}" second="${k.second}" amount="${k.amount}"/>`);
      L.push('  </kernings>');
    }
    L.push('</font>');
    return L.join('\n');
  }

  function _writeFNTBinary({ face, size, lineHeight, base, padding, spacing,
                              renderedPages, kernings, pageNames }) {
    const enc   = new TextEncoder();
    const faceB = enc.encode(face + '\0');

    // Block 1: info
    const ip = 14 + faceB.length;
    const b1 = new ArrayBuffer(5 + ip), b1v = new DataView(b1);
    b1v.setUint8(0, 1); b1v.setUint32(1, ip, true);
    b1v.setInt16(5, size, true); b1v.setUint8(7, 0x80); b1v.setUint8(8, 0);
    b1v.setUint16(9, 100, true); b1v.setUint8(11, 1);
    b1v.setUint8(12, padding); b1v.setUint8(13, padding);
    b1v.setUint8(14, padding); b1v.setUint8(15, padding);
    b1v.setUint8(16, spacing); b1v.setUint8(17, spacing); b1v.setUint8(18, 0);
    new Uint8Array(b1, 19).set(faceB);

    // Block 2: common
    const scaleW = renderedPages[0]?.width || 512, scaleH = renderedPages[0]?.height || 512;
    const b2 = new ArrayBuffer(5 + 15), b2v = new DataView(b2);
    b2v.setUint8(0, 2); b2v.setUint32(1, 15, true);
    b2v.setUint16(5, lineHeight, true); b2v.setUint16(7, base, true);
    b2v.setUint16(9, scaleW, true); b2v.setUint16(11, scaleH, true);
    b2v.setUint16(13, renderedPages.length, true);

    // Block 3: pages
    const pnb = pageNames.map(n => enc.encode(n + '\0'));
    const pp  = pnb.reduce((s, b) => s + b.byteLength, 0);
    const b3  = new ArrayBuffer(5 + pp), b3v = new DataView(b3);
    b3v.setUint8(0, 3); b3v.setUint32(1, pp, true);
    let po = 5;
    for (const nb of pnb) { new Uint8Array(b3, po).set(nb); po += nb.byteLength; }

    // Block 4: chars
    const all = renderedPages.flatMap((p, pi) => p.items.map(g => ({ g, pi })));
    const cp  = all.length * 20;
    const b4  = new ArrayBuffer(5 + cp), b4v = new DataView(b4);
    b4v.setUint8(0, 4); b4v.setUint32(1, cp, true);
    all.forEach(({ g, pi }, i) => {
      const o = 5 + i * 20;
      b4v.setUint32(o, g.cp, true); b4v.setUint16(o+4, g.atlasX, true);
      b4v.setUint16(o+6, g.atlasY, true); b4v.setUint16(o+8, g.isEmpty?0:g.width, true);
      b4v.setUint16(o+10, g.isEmpty?0:g.height, true); b4v.setInt16(o+12, g.xoffset, true);
      b4v.setInt16(o+14, g.yoffset, true); b4v.setInt16(o+16, g.xadvance, true);
      b4v.setUint8(o+18, pi); b4v.setUint8(o+19, 15);
    });

    // Block 5: kerning
    let b5 = new ArrayBuffer(0);
    if (kernings.length) {
      const kp = kernings.length * 10;
      b5 = new ArrayBuffer(5 + kp); const b5v = new DataView(b5);
      b5v.setUint8(0, 5); b5v.setUint32(1, kp, true);
      kernings.forEach((k, i) => {
        const o = 5 + i * 10;
        b5v.setUint32(o, k.first, true); b5v.setUint32(o+4, k.second, true);
        b5v.setInt16(o+8, k.amount, true);
      });
    }

    return _concatBuffers([new Uint8Array([0x42,0x4D,0x46,3]).buffer, b1, b2, b3, b4, b5]);
  }

  // ===========================================================================
  // FNT Generation - Main
  // ===========================================================================

  /**
   * Rasterize a vector font to AngelCode bitmap font format.
   *
   * Coordinate contract:
   *   atlasX, atlasY  = top-left of the glyph CELL in the atlas (padding excluded).
   *   This is exactly what gets written into the .fnt x/y fields.
   *   The slot (cell + padding on all sides) is used only for packing layout.
   *
   * Render formula (glyph.draw origin):
   *   ox = atlasX - bbox.x1 * scale
   *   oy = atlasY + bbox.y2 * scale
   *
   * This places the glyph's top-left pixel exactly at (atlasX, atlasY) in canvas coords.
   */
  function fontToFNT(otFont, options = {}) {
    const {
      size           = 32,
      padding        = 2,
      spacing        = 1,
      charset        = CHARSET_PRESETS.ASCII,
      outputFmt      = FNT_OUTPUT.TEXT,
      atlasWidth     = 0,
      includeKerning = true,
    } = options;

    if (typeof document === 'undefined')
      throw new Error('fontToFNT requires a Canvas-capable environment.');

    const chars = [...new Set(typeof charset === 'string' ? [...charset] : charset)]
      .filter(ch => (ch.codePointAt(0) ?? 0) >= 32);

    const scale  = size / otFont.unitsPerEm;
    const lineH  = Math.ceil((otFont.ascender - otFont.descender) * scale);
    const base   = Math.ceil(otFont.ascender * scale);

    // Measure every glyph
    const glyphInfos = [];
    for (const ch of chars) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      let glyph;
      try { glyph = otFont.charToGlyph(ch); } catch (_) { continue; }
      if (!glyph) continue;

      const bbox    = glyph.getBoundingBox();
      const isEmpty = bbox.x1 === 0 && bbox.x2 === 0 && bbox.y1 === 0 && bbox.y2 === 0;
      const gW      = isEmpty ? 0 : Math.max(1, Math.ceil((bbox.x2 - bbox.x1) * scale));
      const gH      = isEmpty ? 0 : Math.max(1, Math.ceil((bbox.y2 - bbox.y1) * scale));

      glyphInfos.push({
        ch, cp, glyph, bbox, isEmpty,
        width:    gW,
        height:   gH,
        xoffset:  isEmpty ? 0 : Math.round(bbox.x1 * scale),
        yoffset:  isEmpty ? 0 : Math.round((otFont.ascender - bbox.y2) * scale),
        xadvance: Math.round(glyph.advanceWidth * scale),
        // Slot = cell + padding*2 on each side
        slotW:    isEmpty ? Math.max(2, padding*2) : gW + padding * 2,
        slotH:    isEmpty ? Math.max(2, padding*2) : gH + padding * 2,
      });
    }

    if (!glyphInfos.length) throw new Error('No glyphs found for the given charset.');

    const ATLAS_W  = atlasWidth || _autoAtlasSize(glyphInfos);
    const allPages = _shelfPackGlyphs(glyphInfos, ATLAS_W, spacing, padding);

    // Render each page to canvas
    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';

    const renderedPages = allPages.map(items => {
      // Atlas height = bottom of lowest slot, rounded up to next power of 2
      const maxBottom = items.reduce((m, g) => {
        const slotBottom = g.atlasY + (g.isEmpty ? 0 : g.height) + padding;
        return Math.max(m, slotBottom);
      }, 0);
      const H = _nextPow2(maxBottom);

      canvas.width  = ATLAS_W;
      canvas.height = H;
      ctx.clearRect(0, 0, ATLAS_W, H);
      ctx.fillStyle = '#ffffff';

      for (const g of items) {
        if (g.isEmpty || g.width <= 0 || g.height <= 0) continue;
        // ox, oy place the glyph origin so the cell top-left lands at (atlasX, atlasY)
        const ox = g.atlasX - g.bbox.x1 * scale;
        const oy = g.atlasY + g.bbox.y2 * scale;
        try { g.glyph.draw(ctx, ox, oy, size); }
        catch (e) { console.warn(`[Fonty] Glyph U+${g.cp.toString(16).toUpperCase()}: ${e.message}`); }
      }

      return { dataURL: canvas.toDataURL('image/png'), width: ATLAS_W, height: H, items };
    });

    const kernings  = includeKerning ? _extractKernings(otFont, glyphInfos, scale) : [];
    const face      = otFont.names?.fontFamily?.en || otFont.names?.fontFamily?.[''] || 'Unknown';
    const pageNames = renderedPages.map((_, i) => `${i}.png`);
    const ctx2      = { face, size, lineHeight: lineH, base, padding, spacing,
                        renderedPages, kernings, pageNames };

    let fnt;
    if (outputFmt === FNT_OUTPUT.XML)    fnt = _buildFNTXML(ctx2);
    else if (outputFmt === FNT_OUTPUT.BINARY) fnt = _writeFNTBinary(ctx2);
    else                                  fnt = _buildFNTText(ctx2);

    return {
      fnt, fntFormat: outputFmt,
      pngDataURLs: renderedPages.map(p => p.dataURL),
      pageCount:   renderedPages.length,
      charCount:   glyphInfos.length,
      atlasWidth:  ATLAS_W,
      atlasHeights: renderedPages.map(p => p.height),
      lineHeight:  lineH,
      base,
      kerningCount: kernings.length,
    };
  }

  // ===========================================================================
  // WOFF2 Loader
  // ===========================================================================

  let _woff2Promise = null, _woff2Module = null;

  function loadWOFF2Module() {
    if (_woff2Module)  return Promise.resolve(_woff2Module);
    if (_woff2Promise) return _woff2Promise;
    _woff2Promise = new Promise((resolve, reject) => {
      if (typeof Module !== 'undefined' && typeof Module.decompress === 'function') {
        _woff2Module = Module; return resolve(_woff2Module);
      }
      const prev = global.Module;
      global.Module = { onRuntimeInitialized() { _woff2Module = global.Module; resolve(_woff2Module); } };
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/wawoff2@2.0.1/build/decompress_binding.js';
      s.onerror = () => { global.Module = prev; _woff2Promise = null; reject(new Error('wawoff2 load failed.')); };
      document.head.appendChild(s);
    });
    return _woff2Promise;
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  function _nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

  function _arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192)
      bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(bin);
  }

  function _basename(filename) { return String(filename).replace(/\.[^.]+$/, ''); }

  function _concatBuffers(buffers) {
    const total = buffers.reduce((s, b) => s + b.byteLength, 0);
    const out   = new Uint8Array(total);
    let off = 0;
    for (const b of buffers) { out.set(new Uint8Array(b), off); off += b.byteLength; }
    return out.buffer;
  }

  function downloadBuffer(buffer, filename, mimeType = 'application/octet-stream') {
    const blob = new Blob([buffer], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click();
    URL.revokeObjectURL(url);
  }

  // ===========================================================================
  // FontyFont
  // ===========================================================================

  class FontyFont {
    constructor() {
      this._id = Math.random().toString(36).slice(2, 10);
      this._filename = ''; this._buffer = null; this._sfntBuf = null;
      this._format = null; this._otFont = null; this._fntData = null;
    }

    static async fromFile(file) {
      const inst = new FontyFont();
      inst._filename = file.name;
      inst._buffer   = await file.arrayBuffer();
      await inst._init(); return inst;
    }

    static async fromBuffer(buffer, filename = 'font') {
      const inst = new FontyFont();
      inst._filename = filename;
      inst._buffer   = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
      await inst._init(); return inst;
    }

    static async fromBase64(b64, filename = 'font') {
      const bin = atob(b64), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return FontyFont.fromBuffer(bytes.buffer, filename);
    }

    async _init() {
      if (!this._buffer?.byteLength) throw new Error(`Empty buffer for "${this._filename}"`);
      this._format = detectFormat(this._buffer, this._filename);
      if (!this._format) throw new Error(`Unrecognized format: "${this._filename}"`);

      if (this._format === FORMAT.FNT) {
        this._fntData = parseFNT(this._buffer); return;
      }
      if (this._format === FORMAT.WOFF2) {
        const wasm = await loadWOFF2Module();
        this._sfntBuf = wasm.decompress(new Uint8Array(this._buffer)).buffer;
      } else {
        this._sfntBuf = this._buffer;
      }
      try { this._otFont = opentype.parse(this._sfntBuf); }
      catch (e) { throw new Error(`Parse failed for "${this._filename}": ${e.message}`); }
    }

    // Identity
    get id()       { return this._id; }
    get filename() { return this._filename; }
    get format()   { return this._format; }
    get isBitmap() { return this._format === FORMAT.FNT; }
    get glyphCount() { return this._otFont?.glyphs?.length ?? 0; }
    get unitsPerEm() { return this._otFont?.unitsPerEm ?? 1000; }
    get ascender()   { return this._otFont?.ascender ?? 0; }
    get descender()  { return this._otFont?.descender ?? 0; }

    /** Returns true if the font has a variation (fvar) table. */
    get isVariable() { return !!this._otFont?.tables?.fvar; }

    /**
     * Returns variation axes for variable fonts, or null.
     * @returns {{ tag, name, min, max, default }[] | null}
     */
    getVariationAxes() {
      if (!this._otFont?.tables?.fvar) return null;
      return this._otFont.tables.fvar.axes.map(axis => ({
        tag:     axis.tag,
        name:    this._otFont.names[axis.nameID]?.en || axis.tag,
        min:     axis.minValue,
        max:     axis.maxValue,
        default: axis.defaultValue,
      }));
    }

    /**
     * Get font metrics normalised to a given font size (px).
     * @returns {{ ascender, descender, xHeight, capHeight, lineHeight, base }}
     */
    getMetrics(size = 100) {
      if (!this._otFont) return null;
      const sc = size / this._otFont.unitsPerEm;
      const os2 = this._otFont.tables.os2;
      return {
        ascender:   Math.round(this._otFont.ascender   * sc),
        descender:  Math.round(this._otFont.descender  * sc),
        xHeight:    Math.round((os2?.sxHeight   || this._otFont.ascender * 0.5) * sc),
        capHeight:  Math.round((os2?.sCapHeight || this._otFont.ascender * 0.7) * sc),
        lineHeight: Math.round((this._otFont.ascender - this._otFont.descender) * sc),
        base:       Math.round(this._otFont.ascender * sc),
      };
    }

    /**
     * Get an SVG path string for a single character.
     * @param {string} char
     * @param {number} [size=100]
     * @returns {string | null}
     */
    getGlyphSVGPath(char, size = 100) {
      if (!this._otFont) return null;
      try {
        const glyph = this._otFont.charToGlyph(char);
        if (!glyph) return null;
        const path = glyph.getPath(0, size * 0.75, size);
        return path.toSVG(2);
      } catch (_) { return null; }
    }

    /**
     * Get a complete standalone SVG for a single character.
     * @param {string} char
     * @param {number} [size=120]
     */
    getGlyphSVG(char, size = 120) {
      const pathData = this.getGlyphSVGPath(char, size);
      if (!pathData) return null;
      return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">\n  ${pathData}\n</svg>`;
    }

    getMetadata() {
      if (this.isBitmap) {
        const f = this._fntData;
        return {
          family:    f?.info?.face || _basename(this._filename),
          subfamily: 'Regular',
          isBitmap:  true,
          fntSize:   f?.info?.size ?? null,
          fntPages:  f?.pages?.length ?? 1,
          fntChars:  f?.chars?.size ?? 0,
          fntKerns:  f?.kernings?.length ?? 0,
          fntAtlasW: f?.common?.scaleW ?? null,
          fntAtlasH: f?.common?.scaleH ?? null,
          fntLineH:  f?.common?.lineHeight ?? null,
          fntBase:   f?.common?.base ?? null,
        };
      }
      if (!this._otFont) return {};
      const n = this._otFont.names;
      const g = k => n[k]?.en || n[k]?.[''] || '';
      return {
        family: g('fontFamily'), subfamily: g('fontSubfamily'), fullName: g('fullName'),
        postScriptName: g('postScriptName'), version: g('version'),
        copyright: g('copyright'), trademark: g('trademark'),
        manufacturer: g('manufacturer'), manufacturerURL: g('manufacturerURL'),
        designer: g('designer'), designerURL: g('designerURL'),
        description: g('description'), license: g('license'), licenseURL: g('licenseURL'),
        uniqueID: g('uniqueSubfamilyID'),
      };
    }

    setMetadata(patch) {
      if (!this._otFont) return;
      const MAP = {
        family: 'fontFamily', subfamily: 'fontSubfamily', fullName: 'fullName',
        postScriptName: 'postScriptName', version: 'version', copyright: 'copyright',
        trademark: 'trademark', manufacturer: 'manufacturer', manufacturerURL: 'manufacturerURL',
        designer: 'designer', designerURL: 'designerURL', description: 'description',
        license: 'license', licenseURL: 'licenseURL', uniqueID: 'uniqueSubfamilyID',
      };
      for (const [k, ot] of Object.entries(MAP))
        if (k in patch) this._otFont.names[ot] = { en: String(patch[k]) };
    }

    async toArrayBuffer() {
      if (this.isBitmap) throw new Error('Bitmap fonts cannot be converted to vector formats.');
      return this._otFont.toArrayBuffer();
    }
    async toTTF()  { return this.toArrayBuffer(); }
    async toOTF()  { return this.toArrayBuffer(); }
    async toWOFF() { return sfntToWOFF(await this.toArrayBuffer()); }

    async toWOFF2() {
      const wasm = await loadWOFF2Module();
      if (typeof wasm.compress !== 'function')
        throw new Error('WOFF2 encoding requires compress_binding.js from wawoff2.');
      return wasm.compress(new Uint8Array(await this.toArrayBuffer())).buffer;
    }

    async toFNT(options = {}) {
      if (this.isBitmap) throw new Error('Font is already in bitmap (FNT) format.');
      return fontToFNT(this._otFont, options);
    }

    async convert(targetFormat, options = {}) {
      switch (targetFormat) {
        case FORMAT.TTF:   return { buffer: await this.toTTF(),   ext: 'ttf' };
        case FORMAT.OTF:   return { buffer: await this.toOTF(),   ext: 'otf' };
        case FORMAT.WOFF:  return { buffer: await this.toWOFF(),  ext: 'woff' };
        case FORMAT.WOFF2: return { buffer: await this.toWOFF2(), ext: 'woff2' };
        case FORMAT.FNT:   return { ...(await this.toFNT(options)), ext: 'fnt' };
        default: throw new Error(`Unknown target format: "${targetFormat}"`);
      }
    }

    getPreviewDataURL() {
      const mime = MIME_TYPES[this._format] || 'font/ttf';
      return `data:${mime};base64,${_arrayBufferToBase64(this._buffer)}`;
    }

    getCSSFontFace(family) {
      const fam  = family || `fonty-${this._id}`;
      const mime = MIME_TYPES[this._format] || 'font/ttf';
      const b64  = _arrayBufferToBase64(this._buffer);
      return `@font-face {\n  font-family: '${fam}';\n  src: url('data:${mime};base64,${b64}');\n}`;
    }

    get cssFamily() { return `'fonty-${this._id}'`; }
  }

  // ===========================================================================
  // Export
  // ===========================================================================

  const Fonty = {
    version: '2.1.0',
    FontyFont,
    FORMAT, FNT_OUTPUT, MIME_TYPES, CHARSET_PRESETS,
    detectFormat, sfntToWOFF, parseFNT, fontToFNT,
    downloadBuffer, loadWOFF2Module,
    utils: { arrayBufferToBase64: _arrayBufferToBase64, basename: _basename, nextPow2: _nextPow2 },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Fonty;
  else global.Fonty = Fonty;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

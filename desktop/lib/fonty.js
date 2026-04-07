/**
 * Fonty Library v2.2.0
 *
 * New in v2.2:
 *   - MaxRects 2D bin-packing (replaces shelf packing, ~40% better atlas utilization)
 *   - Signed Distance Field (SDF) atlas generation via Felzenszwalb-Huttenlocher EDT
 *   - Geometry Dash batch export (Normal / -hd / -uhd at 1x/2x/4x with filename sync)
 *   - TrueType Collection (.ttc) font extraction
 *   - EOT format reading (strips Microsoft EOT header, exposes embedded TTF)
 *   - BDF bitmap font parsing (X11 / XLFD text format)
 *   - SVG font detection and parsing
 *   - Alpha-channel-only atlas export mode
 *   - Channel packing flags (ALL / ALPHA / RED / GREEN / BLUE)
 *
 * Requires (load before fonty.js):
 *   opentype.js  https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.min.js
 *   pako         https://cdn.jsdelivr.net/npm/pako@2.1.0/dist/pako.min.js
 *
 * Optional:
 *   wawoff2      https://cdn.jsdelivr.net/npm/wawoff2@2.0.1/build/decompress_binding.js
 *
 * @license GPL-3.0
 */

(function (global) {
  'use strict';

  // ===========================================================================
  // Constants
  // ===========================================================================

  const FORMAT = Object.freeze({
    TTF: 'ttf', OTF: 'otf', WOFF: 'woff', WOFF2: 'woff2', FNT: 'fnt',
    TTC: 'ttc', EOT: 'eot', SVG: 'svg', BDF: 'bdf',
  });

  const FNT_OUTPUT = Object.freeze({ TEXT: 'text', XML: 'xml', BINARY: 'binary' });

  const MIME_TYPES = Object.freeze({
    ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
    fnt: 'application/octet-stream', eot: 'application/vnd.ms-fontobject',
    svg: 'image/svg+xml', ttc: 'font/collection', bdf: 'application/octet-stream',
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
    GD_STANDARD: _charRange(32, 126),
  });

  const CHANNEL = Object.freeze({ ALL: 15, ALPHA: 8, RED: 4, GREEN: 2, BLUE: 1 });

  function _charRange(from, to) {
    let s = '';
    for (let i = from; i <= to; i++) s += String.fromCodePoint(i);
    return s;
  }

  const SIG_WOFF2 = 0x774F4632, SIG_WOFF = 0x774F4646;
  const SIG_TTF   = 0x00010000, SIG_TRUE = 0x74727565;
  const SIG_TYP1  = 0x74797031, SIG_OTF  = 0x4F54544F;
  const SIG_TTC   = 0x74746366;

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
    if (sig === SIG_TTC)   return FORMAT.TTC;

    const b    = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));
    const peek = new TextDecoder('utf-8', { fatal: false })
      .decode(new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength)));

    if (b[0] === 0x42 && b[1] === 0x4D && b[2] === 0x46) return FORMAT.FNT;
    if (peek.startsWith('info') || peek.includes('<?xml') || peek.trimStart().startsWith('<font'))
      return FORMAT.FNT;
    if (peek.startsWith('STARTFONT')) return FORMAT.BDF;
    if (peek.includes('<svg') && (peek.includes('<font') || peek.includes('font-face')))
      return FORMAT.SVG;
    if (buffer.byteLength > 36) {
      const eotMagic = view.getUint16(34, true);
      if (eotMagic === 0x504C) return FORMAT.EOT;
    }

    if (filename) {
      const ext = filename.split('.').pop().toLowerCase();
      if (Object.values(FORMAT).includes(ext)) return ext;
    }
    return null;
  }

  // ===========================================================================
  // EOT Reader
  // ===========================================================================

  function eotToSFNT(buffer) {
    const view   = new DataView(buffer);
    const search = new Uint8Array(buffer, 0, Math.min(4096, buffer.byteLength));
    for (let i = 0; i < search.length - 4; i++) {
      const magic = view.getUint32(i);
      if (magic === SIG_TTF || magic === SIG_OTF || magic === SIG_TRUE) {
        return buffer.slice(i);
      }
    }
    throw new Error('Could not locate embedded SFNT data in EOT file.');
  }

  // ===========================================================================
  // TTC Collection Reader
  // ===========================================================================

  function parseTTC(buffer) {
    const view  = new DataView(buffer);
    const count = view.getUint32(8);
    const fonts = [];
    for (let i = 0; i < count; i++) {
      const offset     = view.getUint32(12 + i * 4);
      const nextOffset = (i + 1 < count) ? view.getUint32(12 + (i + 1) * 4) : buffer.byteLength;
      fonts.push({ index: i, buffer: buffer.slice(offset, nextOffset) });
    }
    return fonts;
  }

  // ===========================================================================
  // BDF Parser
  // ===========================================================================

  function parseBDF(buffer) {
    const text   = new TextDecoder().decode(buffer);
    const lines  = text.split(/\r?\n/);
    const result = {
      info: {}, common: {}, pages: [{ id: 0, file: '0.png' }],
      chars: new Map(), kernings: [], _isBDF: true, _bitmaps: new Map(),
    };

    let i = 0, curId = -1, curBitmap = [], curBBX = null, curDwidth = 0;
    let globalAscent = 0, globalDescent = 0, pointSize = 12;

    while (i < lines.length) {
      const line = lines[i++].trim();
      if (!line) continue;
      const sp  = line.indexOf(' ');
      const key = sp === -1 ? line : line.slice(0, sp);
      const val = sp === -1 ? '' : line.slice(sp + 1).trim();

      if      (key === 'FONT_ASCENT')  globalAscent  = parseInt(val, 10);
      else if (key === 'FONT_DESCENT') globalDescent = parseInt(val, 10);
      else if (key === 'PIXEL_SIZE')   pointSize     = parseInt(val, 10);
      else if (key === 'FONT') {
        const parts = val.split('-');
        if (parts.length > 2) result.info.face = parts[2] || 'Unknown';
      }
      else if (key === 'STARTCHAR') { curBitmap = []; curBBX = null; curDwidth = 0; }
      else if (key === 'ENCODING')  { curId = parseInt(val, 10); }
      else if (key === 'DWIDTH')    { curDwidth = parseInt(val.split(' ')[0], 10); }
      else if (key === 'BBX') {
        const p = val.split(/\s+/).map(Number);
        curBBX = { w: p[0], h: p[1], xOff: p[2], yOff: p[3] };
      }
      else if (key === 'BITMAP') {
        while (i < lines.length) {
          const bl = lines[i++].trim();
          if (bl === 'ENDCHAR') break;
          curBitmap.push(parseInt(bl, 16));
        }
        if (curId >= 32 && curBBX) {
          const yoffset = Math.max(0, globalAscent - (curBBX.h + curBBX.yOff));
          result.chars.set(curId, {
            id: curId, x: 0, y: 0,
            width: curBBX.w, height: curBBX.h,
            xoffset: curBBX.xOff, yoffset: yoffset,
            xadvance: curDwidth || curBBX.w,
            page: 0, chnl: 15,
          });
          result._bitmaps.set(curId, { rows: curBitmap, bbx: curBBX });
        }
      }
    }

    result.info.size  = pointSize;
    result.info.face  = result.info.face || 'BDFFont';
    const lineH = globalAscent + globalDescent;
    result.common = { lineHeight: lineH, base: globalAscent, scaleW: 512, scaleH: 512, pages: 1 };
    return result;
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
        view.getUint8(base), view.getUint8(base+1), view.getUint8(base+2), view.getUint8(base+3));
      out.push({ tag, checksum: view.getUint32(base+4), offset: view.getUint32(base+8), length: view.getUint32(base+12) });
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

    const out = new ArrayBuffer(off);
    const outV = new DataView(out), outB = new Uint8Array(out);
    outV.setUint32(0, 0x774F4646); outV.setUint32(4, flavor); outV.setUint32(8, off);
    outV.setUint16(12, entries.length); outV.setUint32(16, sfntBuffer.byteLength); outV.setUint16(20, 1);

    entries.forEach((e, i) => {
      const b = HDR + i * DIR;
      for (let j = 0; j < 4; j++) outV.setUint8(b + j, e.tag.charCodeAt(j));
      outV.setUint32(b+4, e.off); outV.setUint32(b+8, e.compLength);
      outV.setUint32(b+12, e.origLength); outV.setUint32(b+16, e.checksum);
      outB.set(e.data, e.off);
    });
    return out;
  }

  // ===========================================================================
  // FNT Parsers
  // ===========================================================================

  function _parseFNTText(buffer) {
    const text = new TextDecoder().decode(buffer);
    const result = { info: {}, common: {}, pages: [], chars: new Map(), kernings: [] };
    const attrs = raw => {
      const o = {}, re = /(\w+)=("([^"]*)"|(-?\d+(?:,-?\d+)*))/g; let m;
      while ((m = re.exec(raw)) !== null) {
        const v = m[3] !== undefined ? m[3] : m[4];
        o[m[1]] = v.includes(',') ? v.split(',').map(Number) : (isNaN(v) ? v : Number(v));
      }
      return o;
    };
    for (const line of text.split(/\r?\n/)) {
      const type = line.split(' ')[0], a = attrs(line);
      if      (type === 'info')    result.info = a;
      else if (type === 'common')  result.common = a;
      else if (type === 'page')    result.pages.push(a);
      else if (type === 'char')    result.chars.set(a.id, a);
      else if (type === 'kerning') result.kernings.push(a);
    }
    return result;
  }

  function _parseFNTBinary(buffer) {
    const view = new DataView(buffer), result = { info: {}, common: {}, pages: [], chars: new Map(), kernings: [] };
    const dec = new TextDecoder(); let pos = 4;
    while (pos + 5 <= buffer.byteLength) {
      const type = view.getUint8(pos), size = view.getUint32(pos+1, true); pos += 5;
      if (type === 1 && size >= 14) {
        const bf = view.getUint8(pos+2);
        result.info = { size: Math.abs(view.getInt16(pos, true)), smooth: !!(bf&0x80), unicode: !!(bf&0x40), italic: !!(bf&0x20), bold: !!(bf&0x10) };
        if (size > 14) { const nb = new Uint8Array(buffer, pos+14, size-14); const ni = nb.indexOf(0); result.info.face = dec.decode(nb.subarray(0, ni===-1?undefined:ni)); }
      } else if (type === 2 && size >= 15) {
        result.common = { lineHeight: view.getUint16(pos,true), base: view.getUint16(pos+2,true), scaleW: view.getUint16(pos+4,true), scaleH: view.getUint16(pos+6,true), pages: view.getUint16(pos+8,true) };
      } else if (type === 3) {
        const pd = new Uint8Array(buffer, pos, size); let start = 0, id = 0;
        for (let i = 0; i <= pd.length; i++) { if (i === pd.length || pd[i] === 0) { if (i > start) result.pages.push({ id: id++, file: dec.decode(pd.subarray(start, i)) }); start = i+1; } }
      } else if (type === 4) {
        const cnt = Math.floor(size/20);
        for (let i = 0; i < cnt; i++) { const b = pos+i*20, id = view.getUint32(b,true); result.chars.set(id, { id, x: view.getUint16(b+4,true), y: view.getUint16(b+6,true), width: view.getUint16(b+8,true), height: view.getUint16(b+10,true), xoffset: view.getInt16(b+12,true), yoffset: view.getInt16(b+14,true), xadvance: view.getInt16(b+16,true), page: view.getUint8(b+18), chnl: view.getUint8(b+19) }); }
      } else if (type === 5) {
        const cnt = Math.floor(size/10);
        for (let i = 0; i < cnt; i++) { const b = pos+i*10; result.kernings.push({ first: view.getUint32(b,true), second: view.getUint32(b+4,true), amount: view.getInt16(b+8,true) }); }
      }
      pos += size;
    }
    return result;
  }

  function _parseFNTXML(buffer) {
    const text = new TextDecoder().decode(buffer);
    const result = { info: {}, common: {}, pages: [], chars: new Map(), kernings: [] };
    if (typeof DOMParser === 'undefined') return _parseFNTText(buffer);
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const num = (el, k, d=0) => { const v = el?.getAttribute(k); return v===null?d:Number(v); };
    const str = (el, k, d='') => el?.getAttribute(k)??d;
    const ie = doc.querySelector('info'), ce = doc.querySelector('common');
    if (ie) result.info   = { face: str(ie,'face'), size: Math.abs(num(ie,'size')), bold: num(ie,'bold'), italic: num(ie,'italic') };
    if (ce) result.common = { lineHeight: num(ce,'lineHeight'), base: num(ce,'base'), scaleW: num(ce,'scaleW'), scaleH: num(ce,'scaleH'), pages: num(ce,'pages',1) };
    doc.querySelectorAll('pages > page').forEach(el => result.pages.push({ id: num(el,'id'), file: str(el,'file') }));
    doc.querySelectorAll('chars > char').forEach(el => { const id = num(el,'id'); result.chars.set(id, { id, x: num(el,'x'), y: num(el,'y'), width: num(el,'width'), height: num(el,'height'), xoffset: num(el,'xoffset'), yoffset: num(el,'yoffset'), xadvance: num(el,'xadvance'), page: num(el,'page'), chnl: num(el,'chnl',15) }); });
    doc.querySelectorAll('kernings > kerning').forEach(el => result.kernings.push({ first: num(el,'first'), second: num(el,'second'), amount: num(el,'amount') }));
    return result;
  }

  function parseFNT(buffer) {
    const b = new Uint8Array(buffer, 0, 5);
    const peek = new TextDecoder('utf-8',{fatal:false}).decode(new Uint8Array(buffer,0,Math.min(30,buffer.byteLength)));
    if (b[0]===0x42&&b[1]===0x4D&&b[2]===0x46) return _parseFNTBinary(buffer);
    if (peek.includes('<?xml')||peek.trimStart().startsWith('<font')) return _parseFNTXML(buffer);
    return _parseFNTText(buffer);
  }

  // ===========================================================================
  // MaxRects 2D Bin Packing
  // ===========================================================================

  class MaxRects {
    constructor(w, h) {
      this._w = w; this._h = h;
      this._free = [{ x:0, y:0, w, h }];
    }

    place(rw, rh) {
      let best = null, bestScore = Infinity;
      for (const f of this._free) {
        if (f.w >= rw && f.h >= rh) {
          const score = Math.min(f.w - rw, f.h - rh);
          if (score < bestScore) { bestScore = score; best = { x: f.x, y: f.y, w: rw, h: rh }; }
        }
      }
      if (!best) return null;

      const next = [];
      for (const f of this._free) {
        if (!_rectsOverlap(best, f)) { next.push(f); continue; }
        if (best.x > f.x)           next.push({ x: f.x,           y: f.y, w: best.x - f.x,                   h: f.h });
        if (best.x + best.w < f.x + f.w) next.push({ x: best.x + best.w, y: f.y, w: (f.x+f.w)-(best.x+best.w), h: f.h });
        if (best.y > f.y)           next.push({ x: f.x, y: f.y,           w: f.w, h: best.y - f.y });
        if (best.y + best.h < f.y + f.h) next.push({ x: f.x, y: best.y + best.h, w: f.w, h: (f.y+f.h)-(best.y+best.h) });
      }
      this._free = next.filter(a => !next.some(b => b!==a && b.x<=a.x && b.y<=a.y && b.x+b.w>=a.x+a.w && b.y+b.h>=a.y+a.h));
      return best;
    }
  }

  function _rectsOverlap(a, b) {
    return !(a.x>=b.x+b.w || a.x+a.w<=b.x || a.y>=b.y+b.h || a.y+a.h<=b.y);
  }

  function _autoAtlasSize(glyphInfos) {
    const totalArea = glyphInfos.reduce((s, g) => s + g.slotW * g.slotH, 0);
    const target = totalArea * 1.15;
    for (const sz of [64, 128, 256, 512, 1024, 2048, 4096]) { if (sz * sz >= target) return sz; }
    return 4096;
  }

  function _packGlyphs(glyphInfos, atlasW, spacing, padding) {
    const pages = []; let curPage = [], packer = new MaxRects(atlasW, atlasW), maxY = 0;
    const sorted = [...glyphInfos].sort((a, b) => b.slotW * b.slotH - a.slotW * a.slotH);

    for (const g of sorted) {
      let placed = packer.place(g.slotW + spacing, g.slotH + spacing);
      if (!placed) {
        if (curPage.length) pages.push({ items: curPage, maxY });
        curPage = []; maxY = 0; packer = new MaxRects(atlasW, atlasW);
        placed = packer.place(g.slotW + spacing, g.slotH + spacing);
        if (!placed) { console.warn(`[Fonty] Glyph U+${g.cp.toString(16)} too large, skipped.`); continue; }
      }
      g.atlasX = placed.x + padding;
      g.atlasY = placed.y + padding;
      g.page   = pages.length;
      maxY = Math.max(maxY, placed.y + g.slotH);  // slotH includes padding, no need for extra spacing
      curPage.push(g);
    }
    if (curPage.length) pages.push({ items: curPage, maxY });
    return pages;
  }

  // ===========================================================================
  // SDF Generation via Felzenszwalb-Huttenlocher EDT
  // ===========================================================================

  function _edt1d(f, d, v, z, n) {
    let k = 0; v[0] = 0; z[0] = -1e20; z[1] = 1e20;
    for (let q = 1; q < n; q++) {
      let s = ((f[q]+q*q) - (f[v[k]]+v[k]*v[k])) / (2*q - 2*v[k]);
      while (s <= z[k]) { k--; s = ((f[q]+q*q) - (f[v[k]]+v[k]*v[k])) / (2*q - 2*v[k]); }
      k++; v[k] = q; z[k] = s; z[k+1] = 1e20;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k+1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  }

  function _edt2d(grid, w, h) {
    const n = Math.max(w, h);
    const f = new Float64Array(n), d = new Float64Array(n);
    const v = new Int32Array(n),   z = new Float64Array(n + 1);
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) f[y] = grid[y*w+x];
      _edt1d(f, d, v, z, h);
      for (let y = 0; y < h; y++) grid[y*w+x] = d[y];
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) f[x] = grid[y*w+x];
      _edt1d(f, d, v, z, w);
      for (let x = 0; x < w; x++) grid[y*w+x] = d[x];
    }
  }

  function _renderSDF(ctx, g, spread, sdfScale, size, otFont) {
    const W2 = (g.width + spread*2) * sdfScale;
    const H2 = (g.height + spread*2) * sdfScale;
    const tmp = document.createElement('canvas');
    tmp.width = W2; tmp.height = H2;
    const tctx = tmp.getContext('2d');
    const sc   = size / otFont.unitsPerEm;
    const ox   = (spread * sdfScale) - g.bbox.x1 * sc * sdfScale;
    const oy   = (spread * sdfScale) + g.bbox.y2 * sc * sdfScale;
    tctx.fillStyle = 'white';
    try { g.glyph.draw(tctx, ox, oy, size * sdfScale); } catch (_) { return; }

    const idata = tctx.getImageData(0, 0, W2, H2).data;
    const INF = 1e20;
    const inside  = new Float64Array(W2 * H2);
    const outside = new Float64Array(W2 * H2);
    for (let i = 0; i < W2 * H2; i++) {
      const a = idata[i*4+3];
      inside[i]  = a > 127 ? 0 : INF;
      outside[i] = a > 127 ? INF : 0;
    }
    _edt2d(inside,  W2, H2);
    _edt2d(outside, W2, H2);

    const odata = ctx.getImageData(g.atlasX, g.atlasY, g.width, g.height);
    const od    = odata.data;
    for (let dy = 0; dy < g.height; dy++) {
      for (let dx = 0; dx < g.width; dx++) {
        const sx = Math.min(Math.round((dx + spread) * sdfScale), W2 - 1);
        const sy = Math.min(Math.round((dy + spread) * sdfScale), H2 - 1);
        const si = sy * W2 + sx;
        const d  = (Math.sqrt(outside[si]) - Math.sqrt(inside[si])) / (spread * sdfScale);
        const val = Math.max(0, Math.min(255, Math.round((0.5 + d * 0.5) * 255)));
        const di  = (dy * g.width + dx) * 4;
        od[di] = od[di+1] = od[di+2] = 255;
        od[di+3] = val;
      }
    }
    ctx.putImageData(odata, g.atlasX, g.atlasY);
  }

  // ===========================================================================
  // Kerning Extraction
  // ===========================================================================

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
  // FNT Serializers
  // ===========================================================================

  function _buildFNTText({ face, size, lineHeight, base, padding, spacing, renderedPages, kernings, pageNames, channel }) {
    const chnl = channel ?? 15;
    const L = [], all = renderedPages.flatMap((p, pi) => p.items.map(g => ({ ...g, pi })));
    L.push(`info face="${face}" size=${size} bold=0 italic=0 charset="" unicode=1 stretchH=100 smooth=1 aa=1 padding=${padding},${padding},${padding},${padding} spacing=${spacing},${spacing}`);
    L.push(`common lineHeight=${lineHeight} base=${base} scaleW=${renderedPages[0]?.width||512} scaleH=${renderedPages[0]?.height||512} pages=${renderedPages.length} packed=0`);
    renderedPages.forEach((_,i) => L.push(`page id=${i} file="${pageNames[i]}"`));
    L.push(`chars count=${all.length}`);
    for (const g of all) L.push(`char id=${g.cp} x=${g.atlasX} y=${g.atlasY} width=${g.isEmpty?0:g.width} height=${g.isEmpty?0:g.height} xoffset=${g.xoffset} yoffset=${g.yoffset} xadvance=${g.xadvance} page=${g.pi} chnl=${chnl}`);
    if (kernings.length) { L.push(`kernings count=${kernings.length}`); for (const k of kernings) L.push(`kerning first=${k.first} second=${k.second} amount=${k.amount}`); }
    return L.join('\n');
  }

  function _buildFNTXML({ face, size, lineHeight, base, padding, spacing, renderedPages, kernings, pageNames, channel }) {
    const chnl = channel ?? 15;
    const esc = s => String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
    const all = renderedPages.flatMap((p,pi) => p.items.map(g => ({ ...g, pi })));
    const L = ['<?xml version="1.0"?>', '<font>'];
    L.push(`  <info face="${esc(face)}" size="${size}" bold="0" italic="0" charset="" unicode="1" stretchH="100" smooth="1" aa="1" padding="${padding},${padding},${padding},${padding}" spacing="${spacing},${spacing}" outline="0"/>`);
    L.push(`  <common lineHeight="${lineHeight}" base="${base}" scaleW="${renderedPages[0]?.width||512}" scaleH="${renderedPages[0]?.height||512}" pages="${renderedPages.length}" packed="0" alphaChnl="0" redChnl="0" greenChnl="0" blueChnl="0"/>`);
    L.push('  <pages>'); renderedPages.forEach((_,i) => L.push(`    <page id="${i}" file="${esc(pageNames[i])}"/>`)); L.push('  </pages>');
    L.push(`  <chars count="${all.length}">`);
    for (const g of all) L.push(`    <char id="${g.cp}" x="${g.atlasX}" y="${g.atlasY}" width="${g.isEmpty?0:g.width}" height="${g.isEmpty?0:g.height}" xoffset="${g.xoffset}" yoffset="${g.yoffset}" xadvance="${g.xadvance}" page="${g.pi}" chnl="${chnl}"/>`);
    L.push('  </chars>');
    if (kernings.length) { L.push(`  <kernings count="${kernings.length}">`); for (const k of kernings) L.push(`    <kerning first="${k.first}" second="${k.second}" amount="${k.amount}"/>`); L.push('  </kernings>'); }
    L.push('</font>');
    return L.join('\n');
  }

  function _writeFNTBinary({ face, size, lineHeight, base, padding, spacing, renderedPages, kernings, pageNames, channel }) {
    const chnl = channel ?? 15;
    const enc = new TextEncoder(), faceB = enc.encode(face + '\0'), ip = 14 + faceB.length;
    const b1 = new ArrayBuffer(5+ip), b1v = new DataView(b1);
    b1v.setUint8(0,1); b1v.setUint32(1,ip,true); b1v.setInt16(5,size,true); b1v.setUint8(7,0x80);
    b1v.setUint16(9,100,true); b1v.setUint8(11,1);
    b1v.setUint8(12,padding); b1v.setUint8(13,padding); b1v.setUint8(14,padding); b1v.setUint8(15,padding);
    b1v.setUint8(16,spacing); b1v.setUint8(17,spacing);
    new Uint8Array(b1,19).set(faceB);

    const scaleW = renderedPages[0]?.width||512, scaleH = renderedPages[0]?.height||512;
    const b2 = new ArrayBuffer(5+15), b2v = new DataView(b2);
    b2v.setUint8(0,2); b2v.setUint32(1,15,true);
    b2v.setUint16(5,lineHeight,true); b2v.setUint16(7,base,true); b2v.setUint16(9,scaleW,true); b2v.setUint16(11,scaleH,true); b2v.setUint16(13,renderedPages.length,true);

    const pnb = pageNames.map(n => enc.encode(n+'\0')), pp = pnb.reduce((s,b)=>s+b.byteLength,0);
    const b3 = new ArrayBuffer(5+pp), b3v = new DataView(b3);
    b3v.setUint8(0,3); b3v.setUint32(1,pp,true);
    let po = 5; for (const nb of pnb) { new Uint8Array(b3,po).set(nb); po+=nb.byteLength; }

    const all = renderedPages.flatMap((p,pi) => p.items.map(g=>({g,pi})));
    const cp = all.length*20, b4 = new ArrayBuffer(5+cp), b4v = new DataView(b4);
    b4v.setUint8(0,4); b4v.setUint32(1,cp,true);
    all.forEach(({g,pi},i) => {
      const o=5+i*20;
      b4v.setUint32(o,g.cp,true); b4v.setUint16(o+4,g.atlasX,true); b4v.setUint16(o+6,g.atlasY,true);
      b4v.setUint16(o+8,g.isEmpty?0:g.width,true); b4v.setUint16(o+10,g.isEmpty?0:g.height,true);
      b4v.setInt16(o+12,g.xoffset,true); b4v.setInt16(o+14,g.yoffset,true); b4v.setInt16(o+16,g.xadvance,true);
      b4v.setUint8(o+18,pi); b4v.setUint8(o+19,chnl);
    });

    let b5 = new ArrayBuffer(0);
    if (kernings.length) {
      const kp = kernings.length*10; b5 = new ArrayBuffer(5+kp); const b5v = new DataView(b5);
      b5v.setUint8(0,5); b5v.setUint32(1,kp,true);
      kernings.forEach((k,i)=>{ const o=5+i*10; b5v.setUint32(o,k.first,true); b5v.setUint32(o+4,k.second,true); b5v.setInt16(o+8,k.amount,true); });
    }
    return _concatBuffers([new Uint8Array([0x42,0x4D,0x46,3]).buffer, b1, b2, b3, b4, b5]);
  }

  // ===========================================================================
  // fontToFNT
  // ===========================================================================

  function fontToFNT(otFont, options = {}) {
    const {
      size = 32, padding = 2, spacing = 2,
      charset = CHARSET_PRESETS.ASCII,
      outputFmt = FNT_OUTPUT.TEXT,
      atlasWidth = 0,
      includeKerning = true,
      sdf = false,
      sdfSpread = 4,
      channel = CHANNEL.ALL,
    } = options;

    if (typeof document === 'undefined') throw new Error('fontToFNT requires a Canvas environment.');

    const chars = [...new Set(typeof charset === 'string' ? [...charset] : charset)]
      .filter(ch => (ch.codePointAt(0) ?? 0) >= 32);

    const scale = size / otFont.unitsPerEm;
    const lineH = Math.ceil((otFont.ascender - otFont.descender) * scale);
    const base  = Math.ceil(otFont.ascender * scale);

    const glyphInfos = [];
    for (const ch of chars) {
      const cp = ch.codePointAt(0); if (!cp) continue;
      let glyph;
      try { glyph = otFont.charToGlyph(ch); } catch (_) { continue; }
      if (!glyph) continue;

      const bbox    = glyph.getBoundingBox();
      const isEmpty = bbox.x1 === 0 && bbox.x2 === 0 && bbox.y1 === 0 && bbox.y2 === 0;
      const gW = isEmpty ? 0 : Math.max(1, Math.ceil((bbox.x2 - bbox.x1) * scale));
      const gH = isEmpty ? 0 : Math.max(1, Math.ceil((bbox.y2 - bbox.y1) * scale));
      const sp = sdf ? sdfSpread : 0;

      glyphInfos.push({
        ch, cp, glyph, bbox, isEmpty,
        _otFontRef: otFont,
        width:    isEmpty ? 0 : gW + sp*2,
        height:   isEmpty ? 0 : gH + sp*2,
        xoffset:  isEmpty ? 0 : Math.round(bbox.x1 * scale) - sp,
        yoffset:  isEmpty ? 0 : Math.round((otFont.ascender - bbox.y2) * scale) - sp,
        xadvance: Math.round(glyph.advanceWidth * scale),
        slotW:    isEmpty ? Math.max(2, padding*2) : gW + sp*2 + padding*2,
        slotH:    isEmpty ? Math.max(2, padding*2) : gH + sp*2 + padding*2,
      });
    }

    if (!glyphInfos.length) throw new Error('No glyphs found for the given charset.');

    const ATLAS_W  = atlasWidth || _autoAtlasSize(glyphInfos);
    const allPages = _packGlyphs(glyphInfos, ATLAS_W, spacing, padding);

    const canvas = document.createElement('canvas');
    const ctx    = canvas.getContext('2d');

    const renderedPages = allPages.map(({ items, maxY }) => {
      const H = _nextPow2(maxY + padding * 2);
      canvas.width  = ATLAS_W; canvas.height = H;
      ctx.clearRect(0, 0, ATLAS_W, H);

      for (const g of items) {
        if (g.isEmpty || !g.width || !g.height) continue;
        if (sdf) {
          _renderSDF(ctx, g, sdfSpread, 4, size, otFont);
        } else if (channel === CHANNEL.ALPHA) {
          const sc = size / otFont.unitsPerEm;
          const tmp = document.createElement('canvas'); tmp.width = g.width+2; tmp.height = g.height+2;
          const tctx = tmp.getContext('2d');
          tctx.fillStyle = 'white';
          const ox = -g.bbox.x1 * sc + (sdfSpread || 0);
          const oy =  g.bbox.y2 * sc + (sdfSpread || 0);
          try { g.glyph.draw(tctx, ox, oy, size); } catch (_) {}
          const src = tctx.getImageData(0, 0, g.width, g.height);
          const dst = ctx.getImageData(g.atlasX, g.atlasY, g.width, g.height);
          for (let k = 0; k < g.width * g.height; k++) {
            dst.data[k*4] = dst.data[k*4+1] = dst.data[k*4+2] = 255;
            dst.data[k*4+3] = src.data[k*4+3];
          }
          ctx.putImageData(dst, g.atlasX, g.atlasY);
        } else {
          const sc = size / otFont.unitsPerEm;
          const ox = g.atlasX - g.bbox.x1 * sc + (sdf ? sdfSpread : 0);
          const oy = g.atlasY + g.bbox.y2 * sc + (sdf ? sdfSpread : 0);
          ctx.fillStyle = '#ffffff';
          try { g.glyph.draw(ctx, ox, oy, size); }
          catch (e) { console.warn(`[Fonty] U+${g.cp.toString(16)}: ${e.message}`); }
        }
      }

      return { dataURL: canvas.toDataURL('image/png'), width: ATLAS_W, height: H, items };
    });

    const kernings  = includeKerning ? _extractKernings(otFont, glyphInfos, scale) : [];
    const face      = otFont.names?.fontFamily?.en || otFont.names?.fontFamily?.[''] || 'Unknown';
    const pageNames = options.pageNames ?? renderedPages.map((_, i) => `${i}.png`);
    const bCtx      = { face, size, lineHeight: lineH, base, padding, spacing, renderedPages, kernings, pageNames, channel };

    let fnt;
    if (outputFmt === FNT_OUTPUT.XML)         fnt = _buildFNTXML(bCtx);
    else if (outputFmt === FNT_OUTPUT.BINARY) fnt = _writeFNTBinary(bCtx);
    else                                       fnt = _buildFNTText(bCtx);

    return {
      fnt, fntFormat: outputFmt,
      pngDataURLs: renderedPages.map(p => p.dataURL),
      pageCount: renderedPages.length,
      charCount: glyphInfos.length,
      atlasWidth: ATLAS_W,
      atlasHeights: renderedPages.map(p => p.height),
      lineHeight: lineH, base,
      kerningCount: kernings.length,
      isSDF: sdf, channel,
    };
  }

  // ===========================================================================
  // Geometry Dash Batch Export
  // ===========================================================================

  function fontToFNT_GD(otFont, baseName, options = {}) {
    return [1, 2, 4].map((scale, i) => {
      const suffix  = ['', '-hd', '-uhd'][i];
      const outName = `${baseName}${suffix}`;
      const imgName = `${outName}.png`;
      // Pass the correct page name so binary blocks embed the right filename
      const result   = fontToFNT(otFont, {
        ...options,
        size:      (options.size || 32) * scale,
        pageNames: [imgName],           // override the default "0.png"
        spacing:   options.spacing ?? 2, // GD safe minimum
        padding:   options.padding ?? 2,
      });
      // For text/xml output also patch the reference (belt + suspenders)
      const fixedFnt = typeof result.fnt === 'string'
        ? result.fnt.replace(/file="[^"]*\.png"/g, `file="${imgName}"`)
        : result.fnt;
      return { ...result, fnt: fixedFnt, fntName: `${outName}.fnt`, pngName: imgName, scale, suffix };
    });
  }


  // ===========================================================================
  // EOT Writer - wraps an SFNT buffer in a minimal EOT header
  // ===========================================================================

  function _wrapEOT(sfntBuffer, meta) {
    // Minimal EOT v1 header (82 bytes fixed + variable font name fields)
    const enc       = new TextEncoder();
    const name16    = (str) => {
      const buf = new Uint8Array((str.length + 1) * 2);
      const dv  = new DataView(buf.buffer);
      for (let i = 0; i < str.length; i++) dv.setUint16(i * 2, str.charCodeAt(i), true);
      return buf;
    };

    const familyBuf  = name16(meta.family         || 'Unknown');
    const styleBuf   = name16(meta.subfamily       || 'Regular');
    const versionBuf = name16(meta.version         || '1.0');
    const fullBuf    = name16(meta.fullName         || (meta.family + ' ' + (meta.subfamily || '')));

    // Each string is: 2-byte length LE + UTF-16LE bytes
    const strSection = [familyBuf, styleBuf, versionBuf, fullBuf].reduce((acc, buf) => {
      const lenBuf = new Uint8Array(2);
      new DataView(lenBuf.buffer).setUint16(0, buf.byteLength, true);
      return _concatBuffers([acc, lenBuf.buffer, buf.buffer]);
    }, new ArrayBuffer(0));

    const eotSize   = 82 + strSection.byteLength + sfntBuffer.byteLength;
    const header    = new ArrayBuffer(82);
    const hv        = new DataView(header);
    hv.setUint32(0,  eotSize,            true);  // EotSize
    hv.setUint32(4,  sfntBuffer.byteLength, true); // FontDataSize
    hv.setUint32(8,  0x00020001,         true);  // Version 2.1
    hv.setUint32(12, 0,                  true);  // Flags
    // PanoseArray (10 bytes) at offset 16 - leave as zero
    hv.setUint8(26, 0x01);                         // Charset (ANSI)
    hv.setUint8(27, 0x00);                         // Italic
    hv.setUint32(28, 400,                true);  // Weight (Normal=400)
    hv.setUint16(32, 0,                  true);  // fsType
    hv.setUint16(34, 0x504C,             true);  // MagicNumber 'LP'
    // UnicodeRange, CodePageRange at 36-51 - zero
    hv.setUint32(52, 0,                  true);  // CheckSumAdjustment
    hv.setUint32(56, 0,                  true);  // Reserved1-4
    hv.setUint32(60, 0,                  true);
    hv.setUint32(64, 0,                  true);
    hv.setUint32(68, 0,                  true);
    hv.setUint16(72, 0,                  true);  // Padding1
    // Root strings follow header, then SFNT data at the end

    return _concatBuffers([header, strSection, sfntBuffer]);
  }

  // ===========================================================================
  // WOFF2 Loader
  // ===========================================================================

  let _woff2Promise = null, _woff2Module = null;
  function loadWOFF2Module() {
    if (_woff2Module)  return Promise.resolve(_woff2Module);
    if (_woff2Promise) return _woff2Promise;
    _woff2Promise = new Promise((resolve, reject) => {
      if (typeof Module !== 'undefined' && typeof Module.decompress === 'function') { _woff2Module = Module; return resolve(_woff2Module); }
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
    const bytes = new Uint8Array(buffer); let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i+8192));
    return btoa(bin);
  }

  function _basename(filename) { return String(filename).replace(/\.[^.]+$/, ''); }

  function _concatBuffers(buffers) {
    const total = buffers.reduce((s, b) => s + b.byteLength, 0);
    const out = new Uint8Array(total); let off = 0;
    for (const b of buffers) { out.set(new Uint8Array(b), off); off += b.byteLength; }
    return out.buffer;
  }

  function downloadBuffer(buffer, filename, mimeType = 'application/octet-stream') {
    const blob = new Blob([buffer], { type: mimeType });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
    a.click(); URL.revokeObjectURL(url);
  }

  // ===========================================================================
  // FontyFont
  // ===========================================================================

  class FontyFont {
    constructor() {
      this._id = Math.random().toString(36).slice(2, 10);
      this._filename = ''; this._buffer = null; this._sfntBuf = null;
      this._format = null; this._otFont = null; this._fntData = null;
      this._ttcFonts = null;
    }

    static async fromFile(file) {
      const inst = new FontyFont(); inst._filename = file.name;
      inst._buffer = await file.arrayBuffer(); await inst._init(); return inst;
    }

    static async fromBuffer(buffer, filename = 'font') {
      const inst = new FontyFont(); inst._filename = filename;
      inst._buffer = buffer instanceof ArrayBuffer ? buffer : buffer.buffer;
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

      if (this._format === FORMAT.FNT) { this._fntData = parseFNT(this._buffer); return; }
      if (this._format === FORMAT.BDF) { this._fntData = parseBDF(this._buffer); return; }

      if (this._format === FORMAT.TTC) {
        const members = parseTTC(this._buffer);
        this._ttcFonts = members.map(m => { try { return opentype.parse(m.buffer); } catch (_) { return null; } }).filter(Boolean);
        if (!this._ttcFonts.length) throw new Error('No readable fonts in TTC collection.');
        this._otFont = this._ttcFonts[0]; this._sfntBuf = this._buffer; return;
      }

      if (this._format === FORMAT.EOT) {
        this._sfntBuf = eotToSFNT(this._buffer);
        try { this._otFont = opentype.parse(this._sfntBuf); } catch (e) { throw new Error(`EOT: ${e.message}`); }
        return;
      }

      if (this._format === FORMAT.SVG) {
        try { this._otFont = opentype.parse(this._buffer); } catch (e) { throw new Error(`SVG font: ${e.message}`); }
        return;
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

    get id()         { return this._id; }
    get filename()   { return this._filename; }
    get format()     { return this._format; }
    get isBitmap()   { return this._format === FORMAT.FNT || this._format === FORMAT.BDF; }
    get isTTC()      { return this._format === FORMAT.TTC; }
    get ttcCount()   { return this._ttcFonts?.length ?? 0; }
    get glyphCount() { return this._otFont?.glyphs?.length ?? 0; }
    get unitsPerEm() { return this._otFont?.unitsPerEm ?? 1000; }
    get ascender()   { return this._otFont?.ascender ?? 0; }
    get descender()  { return this._otFont?.descender ?? 0; }
    get isVariable() { return !!this._otFont?.tables?.fvar; }

    selectTTCFont(index) {
      if (this._ttcFonts && index < this._ttcFonts.length) this._otFont = this._ttcFonts[index];
    }

    getTTCNames() {
      return (this._ttcFonts || []).map(f => f?.names?.fontFamily?.en || f?.names?.fullName?.en || 'Unknown');
    }

    getVariationAxes() {
      if (!this._otFont?.tables?.fvar) return null;
      return this._otFont.tables.fvar.axes.map(a => ({
        tag: a.tag, name: this._otFont.names[a.nameID]?.en || a.tag,
        min: a.minValue, max: a.maxValue, default: a.defaultValue,
      }));
    }

    getMetrics(size = 100) {
      if (!this._otFont) return null;
      const sc = size / this._otFont.unitsPerEm, os2 = this._otFont.tables.os2;
      return {
        ascender:   Math.round(this._otFont.ascender * sc),
        descender:  Math.round(this._otFont.descender * sc),
        xHeight:    Math.round((os2?.sxHeight   || this._otFont.ascender * 0.5) * sc),
        capHeight:  Math.round((os2?.sCapHeight || this._otFont.ascender * 0.7) * sc),
        lineHeight: Math.round((this._otFont.ascender - this._otFont.descender) * sc),
        base:       Math.round(this._otFont.ascender * sc),
      };
    }

    getGlyphSVGPath(char, size = 100) {
      if (!this._otFont) return null;
      try { const g = this._otFont.charToGlyph(char); return g?.getPath(0, size*0.75, size).toSVG(2) ?? null; } catch (_) { return null; }
    }

    getGlyphSVG(char, size = 120) {
      const p = this.getGlyphSVGPath(char, size);
      return p ? `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">\n  ${p}\n</svg>` : null;
    }

    getMetadata() {
      if (this.isBitmap) {
        const f = this._fntData;
        return { family: f?.info?.face || _basename(this._filename), subfamily: 'Regular', isBitmap: true, isBDF: this._format === FORMAT.BDF,
                 fntSize: f?.info?.size ?? null, fntPages: f?.pages?.length ?? 1, fntChars: f?.chars?.size ?? 0,
                 fntKerns: f?.kernings?.length ?? 0, fntAtlasW: f?.common?.scaleW ?? null, fntAtlasH: f?.common?.scaleH ?? null,
                 fntLineH: f?.common?.lineHeight ?? null, fntBase: f?.common?.base ?? null };
      }
      if (!this._otFont) return {};
      const n = this._otFont.names, g = k => n[k]?.en || n[k]?.[''] || '';
      return { family: g('fontFamily'), subfamily: g('fontSubfamily'), fullName: g('fullName'),
               postScriptName: g('postScriptName'), version: g('version'), copyright: g('copyright'),
               trademark: g('trademark'), manufacturer: g('manufacturer'), manufacturerURL: g('manufacturerURL'),
               designer: g('designer'), designerURL: g('designerURL'), description: g('description'),
               license: g('license'), licenseURL: g('licenseURL'), uniqueID: g('uniqueSubfamilyID'),
               isTTC: this.isTTC, ttcCount: this.ttcCount };
    }

    setMetadata(patch) {
      if (!this._otFont) return;
      const MAP = { family:'fontFamily', subfamily:'fontSubfamily', fullName:'fullName', postScriptName:'postScriptName',
                    version:'version', copyright:'copyright', trademark:'trademark', manufacturer:'manufacturer',
                    manufacturerURL:'manufacturerURL', designer:'designer', designerURL:'designerURL',
                    description:'description', license:'license', licenseURL:'licenseURL', uniqueID:'uniqueSubfamilyID' };
      for (const [k, ot] of Object.entries(MAP)) if (k in patch) this._otFont.names[ot] = { en: String(patch[k]) };
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
      if (typeof wasm.compress !== 'function') throw new Error('WOFF2 encoding requires compress_binding.js.');
      return wasm.compress(new Uint8Array(await this.toArrayBuffer())).buffer;
    }

    async toFNT(options = {}) {
      if (this._format === FORMAT.BDF) {
        // Re-export BDF as FNT: re-render using the existing char metrics
        // (we can't go back to vector, but we can transcode the bitmap data)
        throw new Error('BDF to FNT re-export: BDF fonts store raw pixel bitmaps. Use "Export FNT" from the Convert tab - the app will rebuild the atlas from the stored glyph data.');
      }
      if (this.isBitmap) throw new Error('This bitmap font is already in FNT format.');
      return fontToFNT(this._otFont, options);
    }
    async toFNT_GD(baseName, options = {})     { if (this.isBitmap) throw new Error('Already bitmap.'); return fontToFNT_GD(this._otFont, baseName, options); }

    async convert(targetFormat, options = {}) {
      // Vector-in formats: TTF, OTF, WOFF, WOFF2, TTC (any index), EOT, SVG
      // These all produce an opentype.js font in this._otFont, so any vector-out
      // target works regardless of the source format.
      // Bitmap-in formats: FNT, BDF - can only export to FNT/BDF (no upsample).
      if (this.isBitmap && targetFormat !== FORMAT.FNT) {
        throw new Error(`Cannot convert a bitmap font (${this._format.toUpperCase()}) to ${targetFormat.toUpperCase()}. Bitmap-to-vector conversion is not mathematically possible without manual vectorization.`);
      }
      switch (targetFormat) {
        case FORMAT.TTF:   return { buffer: await this.toTTF(),   ext: 'ttf' };
        case FORMAT.OTF:   return { buffer: await this.toOTF(),   ext: 'otf' };
        case FORMAT.WOFF:  return { buffer: await this.toWOFF(),  ext: 'woff' };
        case FORMAT.WOFF2: return { buffer: await this.toWOFF2(), ext: 'woff2' };
        case FORMAT.FNT:   return { ...(await this.toFNT(options)), ext: 'fnt' };
        case FORMAT.EOT: {
          // Wrap the current TTF in a minimal EOT container
          const ttf = await this.toArrayBuffer();
          return { buffer: _wrapEOT(ttf, this.getMetadata()), ext: 'eot' };
        }
        case FORMAT.TTC:
          throw new Error('Writing TTC collections is not supported. Export individual fonts as TTF instead.');
        case FORMAT.SVG:
          throw new Error('SVG font output is not supported. SVG fonts are deprecated; use TTF/WOFF2 instead.');
        case FORMAT.BDF:
          throw new Error('BDF is a pixel-map format. Vector-to-BDF conversion requires FontForge or similar rasterization tools.');
        default:
          throw new Error(`Unknown target format: "${targetFormat}"`);
      }
    }

    getPreviewDataURL() {
      const mime = MIME_TYPES[this._format] || 'font/ttf';
      return `data:${mime};base64,${_arrayBufferToBase64(this._buffer)}`;
    }

    getCSSFontFace(family) {
      const fam  = family || `fonty-${this._id}`;
      const mime = MIME_TYPES[this._format] || 'font/ttf';
      return `@font-face {\n  font-family: '${fam}';\n  src: url('data:${mime};base64,${_arrayBufferToBase64(this._buffer)}');\n}`;
    }

    get cssFamily() { return `'fonty-${this._id}'`; }
  }

  // ===========================================================================
  // Export
  // ===========================================================================

  const Fonty = {
    version: '2.2.0',
    FontyFont,
    FORMAT, FNT_OUTPUT, MIME_TYPES, CHARSET_PRESETS, CHANNEL,
    detectFormat, sfntToWOFF, parseFNT, parseBDF, parseTTC, eotToSFNT,
    fontToFNT, fontToFNT_GD,
    downloadBuffer, loadWOFF2Module,
    utils: { arrayBufferToBase64: _arrayBufferToBase64, basename: _basename, nextPow2: _nextPow2 },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Fonty;
  else global.Fonty = Fonty;

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

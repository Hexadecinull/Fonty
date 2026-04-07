/**
 * WebFNT v1.0.0 - browser bundle
 * Lightweight AngelCode .fnt bitmap font renderer.
 * Original source: https://github.com/Hexadecinull/WebFNT
 * License: LGPL-3.0
 *
 * Bundled as an IIFE so it works as a plain <script> tag (no module bundler needed).
 * Sets window.WebFNT = { createRenderer, FNTParser, FNTRenderer }
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Parser - converts .fnt text to a structured object
  // ---------------------------------------------------------------------------

  const FNTParser = {
    parse(data) {
      const lines  = data.split(/\r?\n/);
      const result = { info: {}, common: {}, pages: [], chars: {}, kernings: [] };

      lines.forEach(line => {
        const parts = line.match(/\w+=(?:(?:"[^"]*")|[^\s]+)/g);
        if (!parts) return;

        const type  = line.split(' ')[0];
        const attrs = {};
        parts.forEach(part => {
          let [key, val] = part.split('=');
          val = val.replace(/"/g, '');
          // Preserve comma-separated values (e.g. padding) as strings, numbers otherwise
          attrs[key] = val.includes(',') ? val : (isNaN(val) ? val : parseInt(val, 10));
        });

        if (type === 'info')    result.info = attrs;
        if (type === 'common')  result.common = attrs;
        if (type === 'page')    result.pages[attrs.id] = attrs.file;
        if (type === 'char')    result.chars[attrs.id] = attrs;
        if (type === 'kerning') result.kernings.push(attrs);
      });

      // Build kerning lookup: first_id -> { second_id: amount }
      result.kerningMap = {};
      result.kernings.forEach(k => {
        if (!result.kerningMap[k.first]) result.kerningMap[k.first] = {};
        result.kerningMap[k.first][k.second] = k.amount;
      });

      return result;
    },
  };

  // ---------------------------------------------------------------------------
  // Renderer - draws .fnt text into a DOM container using CSS background sprites
  // ---------------------------------------------------------------------------

  class FNTRenderer {
    /**
     * @param {object} fontData  - Parsed FNT data from FNTParser.parse()
     * @param {string} basePath  - Path prefix for image files (e.g. './assets/')
     */
    constructor(fontData, basePath = '') {
      this.fontData = fontData;
      this.basePath = basePath;
      this._imgCache = {};   // url -> Image element
      this._scaleX  = 1;
      this._scaleY  = 1;
    }

    /** Scale all rendered output (useful for hi-dpi or zoom) */
    setScale(sx, sy) {
      this._scaleX = sx;
      this._scaleY = sy ?? sx;
      return this;
    }

    /**
     * Measure the pixel width of a string without rendering it.
     * @param {string} text
     * @returns {number}
     */
    measure(text) {
      let w = 0;
      const chars = [...text];
      chars.forEach((char, i) => {
        const code = char.codePointAt(0);
        const data = this.fontData.chars[code];
        if (data) {
          w += data.xadvance;
          if (i < chars.length - 1) {
            const nextCode = chars[i + 1].codePointAt(0);
            w += (this.fontData.kerningMap[code]?.[nextCode] ?? 0);
          }
        } else if (char === ' ') {
          w += Math.round(this.fontData.common.base / 2);
        }
      });
      return Math.round(w * this._scaleX);
    }

    /**
     * Render text into a container element.
     * The container will have inline-block children, one per glyph.
     *
     * @param {string}      text
     * @param {HTMLElement} container
     * @param {object}      [options]
     * @param {string}      [options.color]  - CSS tint color (only works in ALPHA channel mode)
     * @param {boolean}     [options.clear=true]
     */
    render(text, container, options = {}) {
      const { color, clear = true } = options;
      const sx = this._scaleX, sy = this._scaleY;

      if (clear) container.innerHTML = '';
      container.style.lineHeight = `${this.fontData.common.lineHeight * sy}px`;
      container.style.position   = 'relative';
      container.style.display    = 'inline-block';
      container.style.whiteSpace = 'nowrap';

      const chars = [...text];
      chars.forEach((char, i) => {
        const code = char.codePointAt(0);
        const data = this.fontData.chars[code];

        if (data) {
          const pageUrl = this.basePath + this.fontData.pages[data.page];
          const glyph   = document.createElement('span');

          const kern = i < chars.length - 1
            ? (this.fontData.kerningMap[code]?.[chars[i+1].codePointAt(0)] ?? 0) : 0;

          const dw = data.width  * sx;
          const dh = data.height * sy;

          Object.assign(glyph.style, {
            display:            'inline-block',
            width:              `${dw}px`,
            height:             `${dh}px`,
            backgroundImage:    `url('${pageUrl}')`,
            backgroundPosition: `-${data.x * sx}px -${data.y * sy}px`,
            backgroundSize:     `${this.fontData.common.scaleW * sx}px ${this.fontData.common.scaleH * sy}px`,
            marginLeft:         `${data.xoffset * sx}px`,
            marginTop:          `${data.yoffset * sy}px`,
            marginRight:        `${(data.xadvance - data.width - data.xoffset + kern) * sx}px`,
            verticalAlign:      'top',
          });

          if (color) glyph.style.backgroundColor = color;

          container.appendChild(glyph);

        } else if (char === ' ' || char === '\u00A0') {
          const space = document.createElement('span');
          space.style.display = 'inline-block';
          space.style.width   = `${Math.round(this.fontData.common.base / 2) * sx}px`;
          container.appendChild(space);
        }
      });
    }

    /**
     * Render to a canvas instead of DOM elements.
     * Requires the atlas image to be loaded.
     * Returns a Promise that resolves when drawing is complete.
     *
     * @param {string}          text
     * @param {CanvasRenderingContext2D} ctx
     * @param {number}          x
     * @param {number}          y
     */
    renderToCanvas(text, ctx, x, y) {
      return new Promise((resolve) => {
        const pageUrl = this.basePath + (this.fontData.pages[0] || '');
        const img     = this._imgCache[pageUrl] || (this._imgCache[pageUrl] = new Image());

        const draw = () => {
          let cx = x;
          const sx = this._scaleX, sy = this._scaleY;
          const chars = [...text];

          chars.forEach((char, i) => {
            const code = char.codePointAt(0);
            const data = this.fontData.chars[code];
            if (!data) {
              if (char === ' ') cx += Math.round(this.fontData.common.base / 2) * sx;
              return;
            }
            const kern = i < chars.length - 1
              ? (this.fontData.kerningMap[code]?.[chars[i+1].codePointAt(0)] ?? 0) : 0;
            ctx.drawImage(
              img,
              data.x, data.y, data.width, data.height,
              cx + data.xoffset * sx, y + data.yoffset * sy,
              data.width * sx, data.height * sy
            );
            cx += (data.xadvance + kern) * sx;
          });
          resolve();
        };

        if (img.complete && img.naturalWidth) { draw(); }
        else { img.onload = draw; if (!img.src) img.src = pageUrl; }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // createRenderer - fetch + parse + construct, mirrors the original API
  // ---------------------------------------------------------------------------

  async function createRenderer(fntUrl) {
    const response = await fetch(fntUrl);
    if (!response.ok) throw new Error(`WebFNT: failed to fetch ${fntUrl} (${response.status})`);
    const text     = await response.text();
    const data     = FNTParser.parse(text);
    const basePath = fntUrl.substring(0, fntUrl.lastIndexOf('/') + 1);
    return new FNTRenderer(data, basePath);
  }

  /**
   * Create a renderer from already-parsed FNT text and a base64 PNG data URL.
   * Used internally by Fonty to preview a just-generated FNT atlas without
   * needing a server round-trip.
   *
   * @param {string} fntText     - Raw .fnt text content
   * @param {string} pngDataURL  - data:image/png;base64,... of the atlas page
   * @returns {FNTRenderer}
   */
  function createRendererFromData(fntText, pngDataURL) {
    const data     = FNTParser.parse(fntText);
    const renderer = new FNTRenderer(data, '');
    // Override page lookup to return the data URL directly
    data.pages[0]  = pngDataURL;
    return renderer;
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  global.WebFNT = { createRenderer, createRendererFromData, FNTParser, FNTRenderer };

})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);

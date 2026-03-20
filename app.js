/**
 * Fonty Web App
 * Main application controller — font manager, preview, metadata editor,
 * glyph browser, batch conversion.
 *
 * Depends on: fonty.js (Fonty global), opentype.js, pako.js
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

const state = {
  /** @type {Map<string, { font: Fonty.FontyFont, styleEl: HTMLStyleElement | null }>} */
  fonts:      new Map(),   // id → { font, styleEl }
  activeFontId: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// DOM Refs
// ─────────────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const el = {
  dropZone:       $('drop-zone'),
  main:           $('main'),
  fontList:       $('font-list'),
  fontCount:      $('font-count'),
  fileInput:      $('file-input'),
  fileInputSide:  $('file-input-sidebar'),
  previewSample:  $('preview-sample'),
  previewText:    $('preview-text'),
  sizeSlider:     $('size-slider'),
  sizeLabel:      $('size-label'),
  waterfall:      $('preview-waterfall'),
  metaGrid:       $('meta-grid'),
  btnSaveMeta:    $('btn-save-meta'),
  saveStatus:     $('save-status'),
  singleFormat:   $('single-format'),
  btnConvertSingle: $('btn-convert-single'),
  fntSize:        $('fnt-size'),
  fntPadding:     $('fnt-padding'),
  fntCharset:     $('fnt-charset'),
  fileInfo:       $('file-info'),
  glyphGrid:      $('glyph-grid'),
  glyphSearch:    $('glyph-search'),
  glyphCountLabel: $('glyph-count-label'),
  btnClearAll:    $('btn-clear-all'),
  btnExportAll:   $('btn-export-all'),
  globalFormat:   $('global-format'),
  modalOverlay:   $('modal-overlay'),
  modalClose:     $('modal-close'),
  modalCancel:    $('modal-cancel'),
  modalStart:     $('modal-start'),
  batchFormat:    $('batch-format'),
  batchProgress:  $('batch-progress'),
  progressFill:   $('progress-fill'),
  progressLabel:  $('progress-label'),
  toastStack:     $('toast-stack'),
  tabs:           document.querySelectorAll('.tab'),
  tabContents:    document.querySelectorAll('.tab-content'),
};

// ─────────────────────────────────────────────────────────────────────────────
// Toast Notifications
// ─────────────────────────────────────────────────────────────────────────────

function toast(msg, type = 'info', duration = 3500) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-msg">${msg}</span>`;
  el.toastStack.prepend(t);

  setTimeout(() => {
    t.style.animation = 'toast-out 0.25s ease forwards';
    t.addEventListener('animationend', () => t.remove());
  }, duration);
}

// ─────────────────────────────────────────────────────────────────────────────
// File Loading
// ─────────────────────────────────────────────────────────────────────────────

async function loadFiles(files) {
  const arr = [...files].filter(f => /\.(ttf|otf|woff|woff2|fnt)$/i.test(f.name));
  if (!arr.length) { toast('No supported font files found.', 'error'); return; }

  for (const file of arr) {
    // Show loading placeholder
    const placeholderId = `load-${Math.random().toString(36).slice(2)}`;
    appendFontListItem(placeholderId, file.name, null, true);

    try {
      const font = await Fonty.FontyFont.fromFile(file);
      // Inject @font-face
      let styleEl = null;
      if (!font.isBitmap) {
        styleEl = document.createElement('style');
        styleEl.textContent = font.getCSSFontFace();
        document.head.appendChild(styleEl);
      }
      state.fonts.set(font.id, { font, styleEl });
      removeFontListItem(placeholderId);
      appendFontListItem(font.id, file.name, font);
      updateFontCount();

      if (!state.activeFontId) selectFont(font.id);
    } catch (err) {
      removeFontListItem(placeholderId);
      appendFontListItem(placeholderId, file.name, null, false, true);
      toast(`Failed to load "${file.name}": ${err.message}`, 'error');
      console.error(err);
    }
  }

  showMain();
}

// ─────────────────────────────────────────────────────────────────────────────
// Font List UI
// ─────────────────────────────────────────────────────────────────────────────

function appendFontListItem(id, filename, font, loading = false, error = false) {
  const li = document.createElement('li');
  li.className = `font-item${loading ? ' loading' : ''}${error ? ' error' : ''}`;
  li.dataset.id = id;

  const meta = font ? font.getMetadata() : {};
  const family = meta.family || Fonty.utils.basename(filename);
  const sub    = meta.subfamily || (font ? font.format.toUpperCase() : '…');

  // Mini preview glyph shown in the list
  const previewStyle = font && !font.isBitmap
    ? `font-family: ${font.cssFamily}; font-size: 20px;`
    : '';

  li.innerHTML = `
    <div class="font-item-preview" style="${previewStyle}" aria-hidden="true">Aa</div>
    <div class="font-item-info">
      <div class="font-item-name">${escHtml(family)}</div>
      <div class="font-item-sub">${escHtml(loading ? 'Loading…' : error ? 'Error' : sub)}</div>
    </div>
    <button class="font-item-remove" title="Remove" aria-label="Remove ${escHtml(family)}">✕</button>
  `;

  if (!loading && !error) {
    li.addEventListener('click', e => {
      if (!e.target.classList.contains('font-item-remove')) selectFont(id);
    });
    li.querySelector('.font-item-remove').addEventListener('click', () => removeFont(id));
  }

  el.fontList.appendChild(li);
}

function removeFontListItem(id) {
  const li = el.fontList.querySelector(`[data-id="${id}"]`);
  if (li) li.remove();
}

function updateFontCount() {
  el.fontCount.textContent = state.fonts.size;
}

// ─────────────────────────────────────────────────────────────────────────────
// Font Selection
// ─────────────────────────────────────────────────────────────────────────────

function selectFont(id) {
  state.activeFontId = id;

  // Update sidebar active state
  el.fontList.querySelectorAll('.font-item').forEach(li => {
    li.classList.toggle('active', li.dataset.id === id);
  });

  const { font } = state.fonts.get(id);
  renderPreview(font);
  renderMetaTab(font);
  renderConvertTab(font);
  renderGlyphTab(font);
}

function removeFont(id) {
  const entry = state.fonts.get(id);
  if (!entry) return;
  if (entry.styleEl) entry.styleEl.remove();
  state.fonts.delete(id);
  removeFontListItem(id);
  updateFontCount();

  if (state.activeFontId === id) {
    state.activeFontId = null;
    const first = state.fonts.keys().next().value;
    if (first) selectFont(first);
    else renderEmptyDetail();
  }

  if (state.fonts.size === 0) showDropZone();
}

// ─────────────────────────────────────────────────────────────────────────────
// Preview
// ─────────────────────────────────────────────────────────────────────────────

function renderPreview(font) {
  const size   = parseInt(el.sizeSlider.value, 10);
  const text   = el.previewText.value || 'The quick brown fox';
  const family = font.isBitmap ? 'monospace' : font.cssFamily;

  el.previewSample.style.fontFamily = family;
  el.previewSample.style.fontSize   = size + 'px';
  el.previewSample.textContent      = text;

  // Waterfall sizes
  const SIZES = [10, 14, 20, 28, 38, 52];
  el.waterfall.innerHTML = '';
  SIZES.forEach(s => {
    const span = document.createElement('span');
    span.className = 'waterfall-swatch';
    span.style.fontFamily = family;
    span.style.fontSize   = s + 'px';
    span.textContent = text.split(' ')[0] || 'Abc';
    el.waterfall.appendChild(span);
  });
}

el.previewText.addEventListener('input', () => {
  if (!state.activeFontId) return;
  const { font } = state.fonts.get(state.activeFontId);
  renderPreview(font);
});

el.sizeSlider.addEventListener('input', () => {
  el.sizeLabel.textContent = el.sizeSlider.value + 'px';
  if (!state.activeFontId) return;
  const { font } = state.fonts.get(state.activeFontId);
  renderPreview(font);
});

// ─────────────────────────────────────────────────────────────────────────────
// Metadata Tab
// ─────────────────────────────────────────────────────────────────────────────

const META_FIELDS = [
  { key: 'family',          label: 'Family',            fullWidth: false },
  { key: 'subfamily',       label: 'Subfamily',         fullWidth: false },
  { key: 'fullName',        label: 'Full Name',         fullWidth: false },
  { key: 'postScriptName',  label: 'PostScript Name',   fullWidth: false },
  { key: 'version',         label: 'Version',           fullWidth: false },
  { key: 'designer',        label: 'Designer',          fullWidth: false },
  { key: 'designerURL',     label: 'Designer URL',      fullWidth: false },
  { key: 'manufacturer',    label: 'Manufacturer',      fullWidth: false },
  { key: 'manufacturerURL', label: 'Manufacturer URL',  fullWidth: false },
  { key: 'copyright',       label: 'Copyright',         fullWidth: true  },
  { key: 'description',     label: 'Description',       fullWidth: true  },
  { key: 'license',         label: 'License',           fullWidth: true  },
  { key: 'licenseURL',      label: 'License URL',       fullWidth: true  },
];

function renderMetaTab(font) {
  const meta = font.getMetadata();
  el.metaGrid.innerHTML = '';

  META_FIELDS.forEach(f => {
    const div = document.createElement('div');
    div.className = `meta-field${f.fullWidth ? ' full-width' : ''}`;

    const label = document.createElement('label');
    label.className = 'meta-label';
    label.textContent = f.label;
    label.htmlFor = `meta-${f.key}`;

    const input = document.createElement('input');
    input.type      = 'text';
    input.id        = `meta-${f.key}`;
    input.className = `meta-input${font.isBitmap ? ' readonly' : ''}`;
    input.value     = meta[f.key] || '';
    input.dataset.key = f.key;
    if (font.isBitmap) {
      input.readOnly = true;
      input.title = 'Bitmap fonts are read-only';
    }

    div.appendChild(label);
    div.appendChild(input);
    el.metaGrid.appendChild(div);
  });

  el.btnSaveMeta.disabled = font.isBitmap;
}

el.btnSaveMeta.addEventListener('click', () => {
  if (!state.activeFontId) return;
  const { font } = state.fonts.get(state.activeFontId);
  const patch = {};
  el.metaGrid.querySelectorAll('.meta-input').forEach(inp => {
    if (!inp.readOnly) patch[inp.dataset.key] = inp.value;
  });
  font.setMetadata(patch);

  // Refresh sidebar name
  const li = el.fontList.querySelector(`[data-id="${state.activeFontId}"]`);
  if (li) {
    const nameEl = li.querySelector('.font-item-name');
    if (nameEl) nameEl.textContent = patch.family || nameEl.textContent;
  }

  el.saveStatus.textContent = '✓ Saved';
  el.saveStatus.classList.add('visible');
  setTimeout(() => el.saveStatus.classList.remove('visible'), 2000);
  toast('Metadata saved.', 'success');
});

// ─────────────────────────────────────────────────────────────────────────────
// Convert Tab
// ─────────────────────────────────────────────────────────────────────────────

function renderConvertTab(font) {
  const meta = font.getMetadata();
  const size = font._buffer?.byteLength ?? 0;

  el.fileInfo.innerHTML = `
    <div class="info-row">
      <span class="info-row-label">Format</span>
      <span class="info-row-value">${font.format.toUpperCase()}</span>
    </div>
    <div class="info-row">
      <span class="info-row-label">File Size</span>
      <span class="info-row-value">${formatBytes(size)}</span>
    </div>
    <div class="info-row">
      <span class="info-row-label">Glyphs</span>
      <span class="info-row-value">${font.isBitmap ? '—' : font.glyphCount}</span>
    </div>
    <div class="info-row">
      <span class="info-row-label">Units/EM</span>
      <span class="info-row-value">${font.isBitmap ? '—' : font.unitsPerEm}</span>
    </div>
  `;
}

el.btnConvertSingle.addEventListener('click', async () => {
  if (!state.activeFontId) return;
  const { font } = state.fonts.get(state.activeFontId);
  const fmt  = el.singleFormat.value;
  await convertAndDownload(font, fmt);
});

async function convertAndDownload(font, fmt) {
  if (font.isBitmap && fmt !== 'fnt') {
    toast('Bitmap fonts can only be exported as FNT.', 'error'); return;
  }

  const fntOptions = {
    size:    parseInt(el.fntSize.value, 10)    || 32,
    padding: parseInt(el.fntPadding.value, 10) || 2,
    charset: el.fntCharset.value || undefined,
  };

  try {
    el.btnConvertSingle.textContent = 'Converting…';
    el.btnConvertSingle.disabled    = true;

    const result = await font.convert(fmt, fntOptions);
    const meta   = font.getMetadata();
    const base   = Fonty.utils.basename(font.filename) || meta.family || 'font';

    if (fmt === 'fnt') {
      // Download .fnt text + PNG atlas separately
      const fntBytes = new TextEncoder().encode(result.fnt);
      Fonty.downloadBuffer(fntBytes.buffer, `${base}.fnt`, 'text/plain');
      // Trigger PNG download
      const a = Object.assign(document.createElement('a'), {
        href: result.pngDataURL, download: `${base}-0.png`,
      });
      a.click();
      toast(`Exported "${base}.fnt" + atlas PNG`, 'success');
    } else {
      Fonty.downloadBuffer(result.buffer, `${base}.${result.ext}`, Fonty.MIME_TYPES[result.ext]);
      toast(`Exported "${base}.${result.ext}"`, 'success');
    }
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
    console.error(err);
  } finally {
    el.btnConvertSingle.textContent = 'Export';
    el.btnConvertSingle.disabled    = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Glyph Tab
// ─────────────────────────────────────────────────────────────────────────────

let _glyphData = []; // { char, code } for current font

function renderGlyphTab(font) {
  _glyphData = [];
  el.glyphGrid.innerHTML = '';
  el.glyphSearch.value   = '';

  if (font.isBitmap) {
    // For FNT fonts, show chars from parsed data
    const fnt = font._fntData;
    if (fnt?.chars) {
      fnt.chars.forEach((charData, id) => {
        const ch = String.fromCodePoint(id);
        _glyphData.push({ char: ch, code: id });
      });
    }
  } else if (font._otFont) {
    const otFont = font._otFont;
    const seen   = new Set();
    for (const glyph of otFont.glyphs.glyphs) {
      if (!glyph || !glyph.unicodes?.length) continue;
      for (const cp of glyph.unicodes) {
        if (cp && !seen.has(cp) && cp < 0x10FFFF) {
          seen.add(cp);
          const ch = String.fromCodePoint(cp);
          _glyphData.push({ char: ch, code: cp });
        }
      }
    }
    _glyphData.sort((a, b) => a.code - b.code);
  }

  el.glyphCountLabel.textContent = `${_glyphData.length} glyphs`;
  renderGlyphCells(font, _glyphData);
}

function renderGlyphCells(font, data) {
  el.glyphGrid.innerHTML = '';
  const cssFamily = font.isBitmap ? 'monospace' : font.cssFamily;

  // Render up to 500 glyphs at once to avoid DOM overload
  const visible = data.slice(0, 500);
  const frag    = document.createDocumentFragment();

  visible.forEach(({ char, code }) => {
    const cell = document.createElement('div');
    cell.className = 'glyph-cell';
    cell.title     = `U+${code.toString(16).toUpperCase().padStart(4, '0')} — ${char}`;

    const charEl = document.createElement('span');
    charEl.className    = 'glyph-char';
    charEl.style.fontFamily = cssFamily;
    charEl.textContent  = char;

    const codeEl = document.createElement('span');
    codeEl.className   = 'glyph-code';
    codeEl.textContent = code.toString(16).toUpperCase().padStart(4, '0');

    cell.appendChild(charEl);
    cell.appendChild(codeEl);
    frag.appendChild(cell);
  });

  el.glyphGrid.appendChild(frag);

  if (data.length > 500) {
    const note = document.createElement('p');
    note.style.cssText = 'grid-column:1/-1;font-size:11px;color:var(--text3);text-align:center;padding:8px 0';
    note.textContent   = `Showing 500 of ${data.length} glyphs. Use search to narrow results.`;
    el.glyphGrid.appendChild(note);
  }
}

el.glyphSearch.addEventListener('input', () => {
  if (!state.activeFontId) return;
  const { font } = state.fonts.get(state.activeFontId);
  const q = el.glyphSearch.value.trim().toLowerCase();
  if (!q) {
    renderGlyphCells(font, _glyphData);
    return;
  }
  const filtered = _glyphData.filter(({ char, code }) => {
    const hex = code.toString(16).toLowerCase();
    return char.toLowerCase().includes(q) || hex.includes(q) || ('u+' + hex).includes(q);
  });
  el.glyphCountLabel.textContent = `${filtered.length} of ${_glyphData.length}`;
  renderGlyphCells(font, filtered);
});

// ─────────────────────────────────────────────────────────────────────────────
// Tabs
// ─────────────────────────────────────────────────────────────────────────────

el.tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    el.tabs.forEach(t => t.classList.toggle('active', t === tab));
    el.tabContents.forEach(tc => tc.classList.toggle('active', tc.id === `tab-${target}`));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Batch Export Modal
// ─────────────────────────────────────────────────────────────────────────────

el.btnExportAll.addEventListener('click', () => {
  if (!state.fonts.size) { toast('No fonts loaded.', 'info'); return; }
  el.batchProgress.hidden = true;
  el.progressFill.style.width = '0%';
  el.modalOverlay.hidden = false;
});

function closeModal() { el.modalOverlay.hidden = true; }
el.modalClose.addEventListener('click', closeModal);
el.modalCancel.addEventListener('click', closeModal);
el.modalOverlay.addEventListener('click', e => { if (e.target === el.modalOverlay) closeModal(); });

el.modalStart.addEventListener('click', async () => {
  const fmt    = el.batchFormat.value;
  const fonts  = [...state.fonts.values()].map(e => e.font);
  const total  = fonts.length;

  el.batchProgress.hidden = false;
  el.modalStart.disabled  = true;

  const fntOptions = {
    size:    parseInt(el.fntSize.value, 10)    || 32,
    padding: parseInt(el.fntPadding.value, 10) || 2,
    charset: el.fntCharset.value || undefined,
  };

  let done = 0;
  for (const font of fonts) {
    const base = Fonty.utils.basename(font.filename) || font.getMetadata().family || 'font';
    el.progressLabel.textContent = `Exporting "${base}.${fmt}"…`;

    try {
      if (font.isBitmap && fmt !== 'fnt') {
        done++;
        continue; // skip — can't upscale bitmap
      }
      const result = await font.convert(fmt, fntOptions);
      if (fmt === 'fnt') {
        const fntBytes = new TextEncoder().encode(result.fnt);
        Fonty.downloadBuffer(fntBytes.buffer, `${base}.fnt`, 'text/plain');
        const a = Object.assign(document.createElement('a'), {
          href: result.pngDataURL, download: `${base}-0.png`,
        });
        a.click();
      } else {
        Fonty.downloadBuffer(result.buffer, `${base}.${result.ext}`, Fonty.MIME_TYPES[result.ext]);
      }
    } catch (err) {
      toast(`Skipped "${base}": ${err.message}`, 'error');
    }

    done++;
    el.progressFill.style.width = `${Math.round((done / total) * 100)}%`;
    // Yield to keep UI responsive
    await new Promise(r => setTimeout(r, 30));
  }

  el.progressLabel.textContent = `Done — ${done} of ${total} exported`;
  el.modalStart.disabled = false;
  toast(`Batch export complete (${done}/${total})`, 'success');
});

// ─────────────────────────────────────────────────────────────────────────────
// Clear All
// ─────────────────────────────────────────────────────────────────────────────

el.btnClearAll.addEventListener('click', () => {
  if (!state.fonts.size) return;
  state.fonts.forEach(({ styleEl }) => { if (styleEl) styleEl.remove(); });
  state.fonts.clear();
  state.activeFontId = null;
  el.fontList.innerHTML = '';
  updateFontCount();
  showDropZone();
  toast('All fonts cleared.', 'info');
});

// ─────────────────────────────────────────────────────────────────────────────
// Drop Zone & File Input
// ─────────────────────────────────────────────────────────────────────────────

el.dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  el.dropZone.classList.add('drag-over');
});
el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('drag-over'));
el.dropZone.addEventListener('drop', e => {
  e.preventDefault();
  el.dropZone.classList.remove('drag-over');
  loadFiles(e.dataTransfer.files);
});

// Also accept drop on main app area once fonts loaded
document.body.addEventListener('dragover', e => e.preventDefault());
document.body.addEventListener('drop', e => {
  e.preventDefault();
  if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

el.fileInput.addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
el.fileInputSide.addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });

// ─────────────────────────────────────────────────────────────────────────────
// Layout Toggles
// ─────────────────────────────────────────────────────────────────────────────

function showMain() {
  el.dropZone.hidden = true;
  el.main.hidden     = false;
}

function showDropZone() {
  el.dropZone.hidden = false;
  el.main.hidden     = true;
  renderEmptyDetail();
}

function renderEmptyDetail() {
  const detail = document.getElementById('detail');
  if (!state.activeFontId) {
    detail.innerHTML = `
      <div class="empty-detail">
        <div class="empty-detail-icon">Aa</div>
        <p class="empty-detail-text">Select a font to inspect it</p>
      </div>
    `;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatBytes(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

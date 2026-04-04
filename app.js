'use strict';

// ===========================================================================
// Electron detection
// ===========================================================================

const IS_ELECTRON = typeof window.electronAPI !== 'undefined';
const PLATFORM    = IS_ELECTRON ? window.electronAPI.platform : 'web';

// ===========================================================================
// State
// ===========================================================================

const state = {
  fonts:        new Map(),  // id -> { font, styleEl }
  activeFontId: null,
  varAxisValues: {},        // tag -> value, for current variable font
  metricsVisible: false,
  activeCharset: 'ASCII',
};

// ===========================================================================
// DOM
// ===========================================================================

const $ = id => document.getElementById(id);

const el = {
  titlebar:       $('titlebar'),
  tbMin:          $('tb-min'),
  tbMax:          $('tb-max'),
  tbClose:        $('tb-close'),
  dropZone:       $('drop-zone'),
  fontDetail:     $('font-detail'),
  emptyState:     $('empty-state'),
  fontList:       $('font-list'),
  fontCount:      $('font-count'),
  fileInput:      $('file-input'),
  fileInputSide:  $('file-input-sidebar'),
  sidebarAddLabel:$('sidebar-add-label'),
  browseLabel:    $('browse-label'),
  btnOpenNative:  $('btn-open-native'),
  btnClearAll:    $('btn-clear-all'),
  btnExportAll:   $('btn-export-all'),
  globalFormat:   $('global-format'),
  // preview
  previewText:    $('preview-text'),
  sizeSlider:     $('size-slider'),
  sizeLabel:      $('size-label'),
  btnMetrics:     $('btn-metrics'),
  previewDisplay: $('preview-display'),
  metricLines:    $('metric-lines'),
  previewSample:  $('preview-sample'),
  previewWaterfall: $('preview-waterfall'),
  varAxes:        $('var-axes'),
  varAxesGrid:    $('var-axes-grid'),
  // tabs
  tabs:           document.querySelectorAll('.tab'),
  tabContents:    document.querySelectorAll('.tab-content'),
  // meta
  metaGrid:       $('meta-grid'),
  btnSaveMeta:    $('btn-save-meta'),
  saveStatus:     $('save-status'),
  // convert
  singleFormat:   $('single-format'),
  btnConvertSingle: $('btn-convert-single'),
  fntOptions:     $('fnt-options'),
  fntSize:        $('fnt-size'),
  fntPadding:     $('fnt-padding'),
  fntSpacing:     $('fnt-spacing'),
  fntOutputFmt:   $('fnt-output-fmt'),
  fntAtlasSize:   $('fnt-atlas-size'),
  fntKerning:     $('fnt-kerning'),
  charsetPresets: $('charset-presets'),
  fntCharset:     $('fnt-charset'),
  btnPreviewAtlas: $('btn-preview-atlas'),
  fntStats:       $('fnt-stats'),
  fileInfoTable:  $('file-info-table'),
  // glyphs
  glyphSearch:    $('glyph-search'),
  glyphCountLabel: $('glyph-count-label'),
  glyphGrid:      $('glyph-grid'),
  // css
  snippetFontface: $('snippet-fontface'),
  snippetUsage:   $('snippet-usage'),
  snippetDataURI: $('snippet-datauri'),
  varSnippetBlock: $('var-snippet-block'),
  snippetVarAxes: $('snippet-varaxes'),
  copyFontface:   $('copy-fontface'),
  copyUsage:      $('copy-usage'),
  copyDataURI:    $('copy-datauri'),
  copyVarAxes:    $('copy-varaxes'),
  // atlas modal
  atlasModal:     $('atlas-modal'),
  atlasModalClose: $('atlas-modal-close'),
  atlasMeta:      $('atlas-meta'),
  atlasPages:     $('atlas-pages'),
  // batch modal
  batchModal:     $('batch-modal'),
  batchModalClose: $('batch-modal-close'),
  batchCancel:    $('batch-cancel'),
  batchStart:     $('batch-start'),
  batchFormat:    $('batch-format'),
  batchProgress:  $('batch-progress'),
  progressFill:   $('progress-fill'),
  progressLabel:  $('progress-label'),
  // status
  statusName:     $('status-name'),
  statusSep:      $('status-sep'),
  statusFormat:   $('status-format'),
  statusFormatVal: $('status-format-val'),
  statusGlyphs:   $('status-glyphs'),
  statusGlyphsVal: $('status-glyphs-val'),
  statusSize:     $('status-size'),
  statusSizeVal:  $('status-size-val'),
  // toasts
  toastStack:     $('toast-stack'),
};

// ===========================================================================
// Electron setup
// ===========================================================================

if (IS_ELECTRON) {
  if (PLATFORM !== 'darwin') {
    el.titlebar.classList.add('visible');
    document.body.classList.add('has-titlebar');
  } else {
    // macOS hiddenInset puts traffic lights (close/min/max) in the top-left
    // of the window content area. Push the brand area right so they don't overlap.
    document.body.classList.add('platform-mac');
  }
  el.btnOpenNative.hidden = false;
  el.browseLabel.removeAttribute('for');
  el.browseLabel.addEventListener('click', openNativeFiles);
  el.sidebarAddLabel.removeAttribute('for');
  el.sidebarAddLabel.addEventListener('click', openNativeFiles);

  el.tbMin.addEventListener('click',   () => window.electronAPI.minimize());
  el.tbMax.addEventListener('click',   () => window.electronAPI.maximize());
  el.tbClose.addEventListener('click', () => window.electronAPI.close());

  window.electronAPI.onMenuOpenFiles(() => openNativeFiles());
  window.electronAPI.onMenuClearAll(()  => clearAll());
}

async function openNativeFiles() {
  try {
    const files = await window.electronAPI.openFontFiles();
    if (!files.length) return;
    await loadFileObjects(files.map(f => ({
      name: f.name,
      arrayBuffer: () => Promise.resolve(
        Uint8Array.from(atob(f.data), c => c.charCodeAt(0)).buffer
      ),
    })));
  } catch (err) { toast(`Open failed: ${err.message}`, 'error'); }
}

// ===========================================================================
// Toast
// ===========================================================================

function toast(msg, type = 'info', duration = 3500) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<span class="toast-msg">${escHtml(msg)}</span>`;
  el.toastStack.prepend(t);
  setTimeout(() => {
    t.style.animation = 'toast-out 0.22s ease forwards';
    t.addEventListener('animationend', () => t.remove(), { once: true });
  }, duration);
}

// ===========================================================================
// File loading
// ===========================================================================

async function loadFiles(fileList) {
  const files = [...fileList].filter(f => /\.(ttf|otf|woff|woff2|fnt)$/i.test(f.name));
  if (!files.length) { toast('No supported font files found.', 'error'); return; }
  await loadFileObjects(files);
}

async function loadFileObjects(fileObjects) {
  for (const file of fileObjects) {
    const pid = `ph-${Math.random().toString(36).slice(2)}`;
    addFontListPlaceholder(pid, file.name);
    try {
      const font = await Fonty.FontyFont.fromFile(file);
      let styleEl = null;
      if (!font.isBitmap) {
        styleEl = document.createElement('style');
        styleEl.textContent = font.getCSSFontFace();
        document.head.appendChild(styleEl);
      }
      state.fonts.set(font.id, { font, styleEl });
      removeFontListItem(pid);
      addFontListItem(font.id, font);
      updateFontCount();
      if (!state.activeFontId) selectFont(font.id);
    } catch (err) {
      removeFontListItem(pid);
      toast(`Failed: ${file.name} - ${err.message}`, 'error');
    }
  }
  if (state.fonts.size > 0) hideDropZone();
}

// ===========================================================================
// Font list
// ===========================================================================

function addFontListPlaceholder(id, name) {
  const li = document.createElement('li');
  li.className = 'font-item loading';
  li.dataset.id = id;
  li.innerHTML = `
    <div class="font-item-glyph" style="color:var(--text3)">...</div>
    <div class="font-item-info">
      <div class="font-item-name">${escHtml(name)}</div>
      <div class="font-item-sub">Loading...</div>
    </div>
  `;
  el.fontList.appendChild(li);
}

function addFontListItem(id, font) {
  const meta    = font.getMetadata();
  const family  = meta.family || Fonty.utils.basename(font.filename);
  const sub     = meta.subfamily || 'Regular';
  const preview = font.isBitmap ? '' : `font-family:${font.cssFamily};font-size:18px`;

  const li = document.createElement('li');
  li.className = 'font-item';
  li.dataset.id = id;
  li.innerHTML = `
    <div class="font-item-glyph" style="${preview}">Aa</div>
    <div class="font-item-info">
      <div class="font-item-name">${escHtml(family)}</div>
      <div class="font-item-sub">
        <span class="fmt-pill fmt-${font.format}">${font.format.toUpperCase()}</span>
        ${font.isVariable ? '<span class="fmt-pill fmt-var">VAR</span>' : ''}
        ${escHtml(sub)}
      </div>
    </div>
    <button class="font-item-remove" title="Remove">&#10005;</button>
  `;
  li.addEventListener('click', e => {
    if (!e.target.classList.contains('font-item-remove')) selectFont(id);
  });
  li.querySelector('.font-item-remove').addEventListener('click', e => {
    e.stopPropagation(); removeFont(id);
  });
  el.fontList.appendChild(li);
}

function removeFontListItem(id) {
  el.fontList.querySelector(`[data-id="${id}"]`)?.remove();
}

function updateFontCount() {
  el.fontCount.textContent = state.fonts.size;
}

// ===========================================================================
// Font selection
// ===========================================================================

function selectFont(id) {
  state.activeFontId = id;
  state.varAxisValues = {};

  el.fontList.querySelectorAll('.font-item').forEach(li => {
    li.classList.toggle('active', li.dataset.id === id);
  });

  const { font } = state.fonts.get(id);
  showFontDetail();
  renderPreview(font);
  renderVariableAxes(font);
  renderMetaTab(font);
  renderConvertTab(font);
  renderGlyphTab(font);
  renderCSSTab(font);
  updateStatusBar(font);
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
    const next = state.fonts.keys().next().value;
    if (next) selectFont(next);
    else {
      if (state.fonts.size === 0) showDropZone();
      else showEmptyState();
    }
  }
}

function clearAll() {
  state.fonts.forEach(({ styleEl }) => { if (styleEl) styleEl.remove(); });
  state.fonts.clear();
  state.activeFontId = null;
  el.fontList.innerHTML = '';
  updateFontCount();
  showDropZone();
  clearStatusBar();
  toast('All fonts cleared.', 'info');
}

// ===========================================================================
// Preview
// ===========================================================================

function renderPreview(font) {
  const size   = parseInt(el.sizeSlider.value, 10);
  const text   = el.previewText.value || 'The quick brown fox';
  const family = font.isBitmap ? 'monospace' : font.cssFamily;
  const varSettings = buildVarSettings();

  el.previewSample.style.fontFamily = family;
  el.previewSample.style.fontSize   = size + 'px';
  if (varSettings) {
    el.previewSample.style.fontVariationSettings = varSettings;
  } else {
    el.previewSample.style.removeProperty('font-variation-settings');
  }
  el.previewSample.textContent = text;

  const SIZES = [10, 14, 18, 24, 32, 44];
  el.previewWaterfall.innerHTML = '';
  SIZES.forEach(s => {
    const span = document.createElement('span');
    span.className = 'waterfall-swatch';
    span.style.fontFamily = family;
    span.style.fontSize   = s + 'px';
    if (varSettings) span.style.fontVariationSettings = varSettings;
    span.textContent = (text.split(' ')[0] || 'Abc');
    el.previewWaterfall.appendChild(span);
  });

  if (state.metricsVisible && !font.isBitmap) renderMetricLines(font, size);
  else el.metricLines.hidden = true;
}

function buildVarSettings() {
  const entries = Object.entries(state.varAxisValues);
  if (!entries.length) return null;
  return entries.map(([tag, val]) => `'${tag}' ${val}`).join(', ');
}

function renderVariableAxes(font) {
  if (!font.isVariable) {
    el.varAxes.hidden = true; return;
  }
  const axes = font.getVariationAxes();
  if (!axes?.length) { el.varAxes.hidden = true; return; }

  // Init default values
  state.varAxisValues = {};
  axes.forEach(a => { state.varAxisValues[a.tag] = a.default; });

  el.varAxesGrid.innerHTML = '';
  axes.forEach(axis => {
    const row = document.createElement('div');
    row.className = 'var-axis';
    row.innerHTML = `
      <span class="var-axis-name">${escHtml(axis.name)}<span class="var-axis-tag">${escHtml(axis.tag)}</span></span>
      <input type="range" class="size-slider" style="width:100%"
             min="${axis.min}" max="${axis.max}" step="1" value="${axis.default}" />
      <span class="var-axis-value" id="ax-val-${axis.tag}">${axis.default}</span>
    `;
    const slider = row.querySelector('input');
    slider.addEventListener('input', () => {
      state.varAxisValues[axis.tag] = Number(slider.value);
      $(`ax-val-${axis.tag}`).textContent = slider.value;
      if (state.activeFontId) {
        renderPreview(state.fonts.get(state.activeFontId).font);
      }
    });
    el.varAxesGrid.appendChild(row);
  });

  el.varAxes.hidden = false;
}

function renderMetricLines(font, size) {
  const m = font.getMetrics(size);
  if (!m) return;

  const displayH = el.previewDisplay.offsetHeight;
  const topPad   = (displayH - m.lineHeight) / 2;

  const lines = [
    { cls: 'metric-line-ascender',  top: topPad + m.base - m.ascender,  label: 'ascender' },
    { cls: 'metric-line-cap',       top: topPad + m.base - m.capHeight, label: 'cap' },
    { cls: 'metric-line-xheight',   top: topPad + m.base - m.xHeight,   label: 'x' },
    { cls: 'metric-line-baseline',  top: topPad + m.base,               label: 'base' },
    { cls: 'metric-line-descender', top: topPad + m.base - m.descender, label: 'desc' },
  ];

  el.metricLines.innerHTML = '';
  const colorMap = {
    'metric-line-ascender': 'rgba(100,160,255,.5)',
    'metric-line-cap': 'rgba(100,220,160,.5)',
    'metric-line-xheight': 'rgba(255,200,80,.5)',
    'metric-line-baseline': 'rgba(246,108,108,.6)',
    'metric-line-descender': 'rgba(160,100,255,.5)',
  };
  lines.forEach(({ cls, top, label }) => {
    const div = document.createElement('div');
    div.className = `metric-line ${cls}`;
    div.style.top = `${top}px`;
    const lbl = document.createElement('span');
    lbl.className = 'metric-label';
    lbl.style.top = `${top}px`;
    lbl.style.background = colorMap[cls];
    lbl.textContent = label;
    el.metricLines.appendChild(div);
    el.metricLines.appendChild(lbl);
  });
  el.metricLines.hidden = false;
}

// Metrics toggle
el.btnMetrics.addEventListener('click', () => {
  state.metricsVisible = !state.metricsVisible;
  el.btnMetrics.classList.toggle('active', state.metricsVisible);
  if (state.activeFontId) renderPreview(state.fonts.get(state.activeFontId).font);
});

el.previewText.addEventListener('input', () => {
  if (state.activeFontId) renderPreview(state.fonts.get(state.activeFontId).font);
});

el.sizeSlider.addEventListener('input', () => {
  el.sizeLabel.textContent = el.sizeSlider.value + 'px';
  if (state.activeFontId) renderPreview(state.fonts.get(state.activeFontId).font);
});

// ===========================================================================
// Metadata tab
// ===========================================================================

const META_FIELDS = [
  { key: 'family',         label: 'Family' },
  { key: 'subfamily',      label: 'Subfamily' },
  { key: 'fullName',       label: 'Full name' },
  { key: 'postScriptName', label: 'PostScript name' },
  { key: 'version',        label: 'Version' },
  { key: 'designer',       label: 'Designer' },
  { key: 'designerURL',    label: 'Designer URL' },
  { key: 'manufacturer',   label: 'Manufacturer' },
  { key: 'manufacturerURL',label: 'Manufacturer URL' },
  { key: 'copyright',      label: 'Copyright',    full: true },
  { key: 'description',    label: 'Description',  full: true },
  { key: 'license',        label: 'License',      full: true },
  { key: 'licenseURL',     label: 'License URL',  full: true },
];

function renderMetaTab(font) {
  const meta = font.getMetadata();
  el.metaGrid.innerHTML = '';

  if (font.isBitmap) {
    const bitmapFields = [
      ['Family',       meta.family],
      ['Size',         meta.fntSize != null ? `${meta.fntSize}px` : 'n/a'],
      ['Characters',   meta.fntChars],
      ['Pages',        meta.fntPages],
      ['Atlas',        (meta.fntAtlasW && meta.fntAtlasH) ? `${meta.fntAtlasW} x ${meta.fntAtlasH}` : 'n/a'],
      ['Line height',  meta.fntLineH != null ? `${meta.fntLineH}px` : 'n/a'],
      ['Baseline',     meta.fntBase != null ? `${meta.fntBase}px` : 'n/a'],
      ['Kerning pairs', meta.fntKerns],
    ];
    bitmapFields.forEach(([label, value]) => {
      const div = document.createElement('div');
      div.className = 'meta-field';
      div.innerHTML = `<label class="meta-label">${label}</label>
        <input type="text" class="input input-mono" value="${escHtml(String(value ?? 'n/a'))}" readonly />`;
      el.metaGrid.appendChild(div);
    });
    el.btnSaveMeta.disabled = true;
    return;
  }

  META_FIELDS.forEach(f => {
    const div = document.createElement('div');
    div.className = `meta-field${f.full ? ' full' : ''}`;
    const inp = document.createElement('input');
    inp.type = 'text'; inp.className = 'input'; inp.value = meta[f.key] || '';
    inp.dataset.key = f.key;
    div.innerHTML = `<label class="meta-label">${f.label}</label>`;
    div.appendChild(inp);
    el.metaGrid.appendChild(div);
  });
  el.btnSaveMeta.disabled = false;
}

el.btnSaveMeta.addEventListener('click', () => {
  if (!state.activeFontId) return;
  const { font } = state.fonts.get(state.activeFontId);
  const patch = {};
  el.metaGrid.querySelectorAll('input[data-key]').forEach(i => {
    if (!i.readOnly) patch[i.dataset.key] = i.value;
  });
  font.setMetadata(patch);

  const li = el.fontList.querySelector(`[data-id="${state.activeFontId}"]`);
  if (li && patch.family) li.querySelector('.font-item-name').textContent = patch.family;

  el.saveStatus.classList.add('visible');
  setTimeout(() => el.saveStatus.classList.remove('visible'), 2200);
  toast('Metadata saved.', 'success');
});

// ===========================================================================
// Convert tab
// ===========================================================================

function renderConvertTab(font) {
  const size = font._buffer?.byteLength ?? 0;
  const meta = font.getMetadata();

  // Reset stale FNT stats from a previous font
  el.fntStats.style.display = 'none';
  el.fntStats.innerHTML = '';

  // For bitmap fonts, lock the export format to FNT - you cannot upscale a bitmap
  if (font.isBitmap) {
    el.singleFormat.value = 'fnt';
    // Disable all non-FNT options
    Array.from(el.singleFormat.options).forEach(opt => {
      opt.disabled = opt.value !== 'fnt';
    });
  } else {
    Array.from(el.singleFormat.options).forEach(opt => { opt.disabled = false; });
  }

  const rows = font.isBitmap ? [
    ['Format',       font.format.toUpperCase()],
    ['File size',    formatBytes(size)],
    ['Characters',   meta.fntChars],
    ['Pages',        meta.fntPages],
    ['Atlas',        (meta.fntAtlasW && meta.fntAtlasH) ? `${meta.fntAtlasW} x ${meta.fntAtlasH}px` : 'n/a'],
    ['Line height',  meta.fntLineH != null ? `${meta.fntLineH}px` : 'n/a'],
    ['Kerning pairs', meta.fntKerns],
  ] : [
    ['Format',     font.format.toUpperCase()],
    ['File size',  formatBytes(size)],
    ['Glyphs',     font.glyphCount],
    ['Units/EM',   font.unitsPerEm],
    ['Ascender',   font.ascender],
    ['Descender',  font.descender],
    ['Variable',   font.isVariable ? 'Yes' : 'No'],
  ];

  el.fileInfoTable.innerHTML = rows.map(([k, v]) =>
    `<tr><td>${k}</td><td>${escHtml(String(v))}</td></tr>`
  ).join('');

  updateFNTOptionsVisibility();
}

function updateFNTOptionsVisibility() {
  const isFNT = el.singleFormat.value === 'fnt';
  el.fntOptions.style.display = isFNT ? 'flex' : 'none';
}

el.singleFormat.addEventListener('change', updateFNTOptionsVisibility);

// Charset preset buttons
el.charsetPresets.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    el.charsetPresets.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeCharset = btn.dataset.preset;
    if (state.activeCharset === 'custom') {
      el.fntCharset.style.display = '';
      el.fntCharset.focus();
    } else {
      el.fntCharset.style.display = 'none';
    }
  });
});

function getFNTOptions() {
  const charset = state.activeCharset === 'custom'
    ? el.fntCharset.value
    : (Fonty.CHARSET_PRESETS[state.activeCharset] || Fonty.CHARSET_PRESETS.ASCII);
  return {
    size:           parseInt(el.fntSize.value, 10)       || 32,
    padding:        parseInt(el.fntPadding.value, 10)    || 2,
    spacing:        parseInt(el.fntSpacing.value, 10)    || 1,
    outputFmt:      el.fntOutputFmt.value                || 'text',
    atlasWidth:     parseInt(el.fntAtlasSize.value, 10)  || 0,
    includeKerning: el.fntKerning.value === '1',
    charset,
  };
}

el.btnConvertSingle.addEventListener('click', async () => {
  if (!state.activeFontId) return;
  await convertAndDownload(state.fonts.get(state.activeFontId).font, el.singleFormat.value);
});

// Atlas preview
el.btnPreviewAtlas.addEventListener('click', async () => {
  if (!state.activeFontId) return;
  const { font } = state.fonts.get(state.activeFontId);
  if (font.isBitmap) { toast('Cannot rasterize a bitmap font.', 'error'); return; }

  el.btnPreviewAtlas.textContent = 'Generating...';
  el.btnPreviewAtlas.disabled    = true;
  try {
    const result = await font.toFNT(getFNTOptions());
    showAtlasPreview(result);
    showFNTStats(result);
  } catch (err) {
    toast(`Preview failed: ${err.message}`, 'error');
  } finally {
    el.btnPreviewAtlas.textContent = 'Preview atlas';
    el.btnPreviewAtlas.disabled    = false;
  }
});

function showFNTStats(result) {
  el.fntStats.style.display = 'flex';
  el.fntStats.innerHTML = [
    ['Chars',    result.charCount],
    ['Pages',    result.pageCount],
    ['Atlas',    `${result.atlasWidth} x ${result.atlasHeights[0]}px`],
    ['Kerning',  `${result.kerningCount} pairs`],
    ['Baseline', `${result.base}px`],
    ['Line H',   `${result.lineHeight}px`],
  ].map(([k, v]) => `
    <span class="fnt-stat-item">
      <span class="fnt-stat-label">${k}</span>
      <span class="fnt-stat-value">${v}</span>
    </span>
  `).join('');
}

function showAtlasPreview(result) {
  el.atlasMeta.innerHTML = [
    `${result.charCount} characters`,
    `${result.pageCount} page(s)`,
    `${result.atlasWidth} x ${result.atlasHeights[0]}px`,
    `${result.kerningCount} kerning pairs`,
    `Line height: ${result.lineHeight}px`,
    `Base: ${result.base}px`,
  ].map(t => `<span class="atlas-chip">${t}</span>`).join('');

  el.atlasPages.innerHTML = '';
  result.pngDataURLs.forEach((url, i) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <p class="atlas-page-label">Page ${i} - ${result.atlasWidth} x ${result.atlasHeights[i]}px</p>
      <img class="atlas-img" src="${url}" alt="Atlas page ${i}" />
    `;
    el.atlasPages.appendChild(wrap);
  });

  el.atlasModal.hidden = false;
}

el.atlasModalClose.addEventListener('click', () => { el.atlasModal.hidden = true; });
el.atlasModal.addEventListener('click', e => { if (e.target === el.atlasModal) el.atlasModal.hidden = true; });

// ===========================================================================
// Convert + download
// ===========================================================================

async function convertAndDownload(font, fmt) {
  if (font.isBitmap && fmt !== 'fnt') {
    toast('Bitmap FNT fonts can only be re-exported as FNT.', 'error'); return;
  }
  const label = el.btnConvertSingle;
  label.textContent = 'Exporting...'; label.disabled = true;
  try {
    const result  = await font.convert(fmt, getFNTOptions());
    const base    = Fonty.utils.basename(font.filename) || font.getMetadata().family || 'font';
    if (fmt === 'fnt') {
      await saveFNTResult(result, base);
      if (result.charCount) showFNTStats(result);
    } else {
      await saveSingleBuffer(result.buffer, `${base}.${result.ext}`, Fonty.MIME_TYPES[result.ext]);
      toast(`Exported ${base}.${result.ext}`, 'success');
    }
  } catch (err) {
    toast(`Export failed: ${err.message}`, 'error');
    console.error(err);
  } finally {
    label.textContent = 'Export'; label.disabled = false;
  }
}

async function saveSingleBuffer(buffer, filename, mimeType) {
  if (IS_ELECTRON) {
    const ext = filename.split('.').pop();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
    const fp  = await window.electronAPI.saveFile({ defaultName: filename, ext, data: b64 });
    if (fp) toast(`Saved to ${fp}`, 'success');
    return fp;
  }
  Fonty.downloadBuffer(buffer, filename, mimeType);
  return filename;
}

async function saveFNTResult(result, base) {
  const isBin = result.fntFormat === 'binary';
  if (IS_ELECTRON) {
    const files = [];
    if (isBin) {
      const arr = result.fnt instanceof ArrayBuffer ? new Uint8Array(result.fnt) : new Uint8Array(result.fnt);
      files.push({ name: `${base}.fnt`, data: btoa(String.fromCharCode(...arr)) });
    } else {
      const bytes = new TextEncoder().encode(result.fnt);
      files.push({ name: `${base}.fnt`, data: btoa(String.fromCharCode(...bytes)) });
    }
    result.pngDataURLs.forEach((url, i) => {
      files.push({ name: `${i}.png`, data: url.split(',')[1] });
    });
    const dir = await window.electronAPI.saveFilesToDir(files);
    if (dir) toast(`Saved ${files.length} file(s) to ${dir}`, 'success');
  } else {
    if (isBin) {
      const buf = result.fnt instanceof ArrayBuffer ? result.fnt : result.fnt;
      Fonty.downloadBuffer(buf, `${base}.fnt`, 'application/octet-stream');
    } else {
      Fonty.downloadBuffer(new TextEncoder().encode(result.fnt).buffer, `${base}.fnt`, 'text/plain');
    }
    result.pngDataURLs.forEach((url, i) => {
      const a = Object.assign(document.createElement('a'), { href: url, download: `${i}.png` });
      a.click();
    });
    toast(`Exported ${base}.fnt + ${result.pngDataURLs.length} atlas PNG(s)`, 'success');
  }
}

// ===========================================================================
// Glyphs tab
// ===========================================================================

let _glyphData = [];

function renderGlyphTab(font) {
  _glyphData = [];
  el.glyphGrid.innerHTML = '';
  el.glyphSearch.value   = '';

  if (font.isBitmap) {
    font._fntData?.chars?.forEach((_, id) => {
      // Guard: id must be a valid Unicode scalar value
      if (typeof id !== 'number' || id < 32 || id > 0x10FFFF) return;
      // Skip surrogate pairs (0xD800-0xDFFF) which are invalid in fromCodePoint
      if (id >= 0xD800 && id <= 0xDFFF) return;
      try {
        _glyphData.push({ char: String.fromCodePoint(id), code: id });
      } catch (_) {}
    });
  } else if (font._otFont) {
    const seen = new Set();
    for (const glyph of font._otFont.glyphs.glyphs) {
      if (!glyph?.unicodes?.length) continue;
      for (const cp of glyph.unicodes) {
        if (cp && !seen.has(cp) && cp < 0x10FFFF) {
          seen.add(cp);
          _glyphData.push({ char: String.fromCodePoint(cp), code: cp });
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
  const varSettings = buildVarSettings();
  const visible   = data.slice(0, 600);
  const frag      = document.createDocumentFragment();

  visible.forEach(({ char, code }) => {
    const cell = document.createElement('div');
    cell.className = 'glyph-cell';
    cell.title = `U+${code.toString(16).toUpperCase().padStart(4, '0')} - click to copy`;

    const charEl = document.createElement('span');
    charEl.className = 'glyph-char';
    charEl.style.fontFamily = cssFamily;
    if (varSettings) charEl.style.fontVariationSettings = varSettings;
    charEl.textContent = char;

    const codeEl = document.createElement('span');
    codeEl.className = 'glyph-code';
    codeEl.textContent = code.toString(16).toUpperCase().padStart(4, '0');

    cell.appendChild(charEl); cell.appendChild(codeEl);

    // Click to copy character
    cell.addEventListener('click', () => {
      copyText(char);
      toast(`Copied: ${char} (U+${code.toString(16).toUpperCase().padStart(4,'0')})`, 'success', 1800);
    });

    frag.appendChild(cell);
  });

  el.glyphGrid.appendChild(frag);

  if (data.length > 600) {
    const note = document.createElement('p');
    note.style.cssText = 'grid-column:1/-1;font-size:11px;color:var(--text3);text-align:center;padding:10px 0';
    note.textContent = `Showing 600 of ${data.length}. Use search to filter.`;
    el.glyphGrid.appendChild(note);
  }
}

el.glyphSearch.addEventListener('input', () => {
  if (!state.activeFontId) return;
  const { font } = state.fonts.get(state.activeFontId);
  const q = el.glyphSearch.value.trim().toLowerCase();
  if (!q) { el.glyphCountLabel.textContent = `${_glyphData.length} glyphs`; renderGlyphCells(font, _glyphData); return; }
  const filtered = _glyphData.filter(({ char, code }) => {
    const hex = code.toString(16).toLowerCase();
    return char.toLowerCase().includes(q) || hex.includes(q) || `u+${hex}`.includes(q);
  });
  el.glyphCountLabel.textContent = `${filtered.length} of ${_glyphData.length}`;
  renderGlyphCells(font, filtered);
});

// ===========================================================================
// CSS tab
// ===========================================================================

function renderCSSTab(font) {
  // FNT is a bitmap sprite sheet, not a CSS-loadable font format
  if (font.isBitmap) {
    const msg = 'FNT (AngelCode bitmap) fonts cannot be loaded via CSS.\nThey are sprite sheets used by game engines and custom renderers.\n\nConvert to TTF, OTF, WOFF, or WOFF2 to get a CSS-loadable font.';
    el.snippetFontface.value = msg;
    el.snippetUsage.value    = '';
    el.snippetDataURI.value  = '';
    el.varSnippetBlock.hidden = true;
    el.copyFontface.disabled = true;
    el.copyUsage.disabled    = true;
    el.copyDataURI.disabled  = true;
    return;
  }

  el.copyFontface.disabled = false;
  el.copyUsage.disabled    = false;
  el.copyDataURI.disabled  = false;

  const meta    = font.getMetadata();
  const family  = meta.family || Fonty.utils.basename(font.filename) || 'MyFont';
  const varStr  = font.isVariable ? '\n  font-weight: 100 900;' : '';
  const baseName = Fonty.utils.basename(font.filename);

  el.snippetFontface.value = `@font-face {\n  font-family: '${family}';${varStr}\n  src: url('./fonts/${baseName}.woff2') format('woff2'),\n       url('./fonts/${baseName}.${font.format}') format('${fmtLabel(font.format)}');\n  font-display: swap;\n}`;

  const usageLines = [`/* Apply the font */`, `.my-element {`, `  font-family: '${family}', sans-serif;`];
  if (font.isVariable) {
    const axes = font.getVariationAxes();
    if (axes?.length) {
      usageLines.push(`  font-variation-settings: ${axes.map(a => `'${a.tag}' ${a.default}`).join(', ')};`);
    }
  }
  usageLines.push(`}`);
  el.snippetUsage.value = usageLines.join('\n');

  el.snippetDataURI.value = font.getPreviewDataURL();

  if (font.isVariable) {
    el.varSnippetBlock.hidden = false;
    const axes  = font.getVariationAxes() || [];
    const lines = axes.map(a => `/* ${a.name} (${a.tag}): ${a.min} to ${a.max}, default ${a.default} */`);
    lines.push('', '.my-element {');
    lines.push(`  font-variation-settings: ${axes.map(a => `'${a.tag}' ${a.default}`).join(', ')};`);
    lines.push('}');
    el.snippetVarAxes.value = lines.join('\n');
  } else {
    el.varSnippetBlock.hidden = true;
  }
}

function fmtLabel(fmt) {
  const m = { ttf: 'truetype', otf: 'opentype', woff: 'woff', woff2: 'woff2' };
  return m[fmt] || fmt;
}

// Copy buttons
[
  ['copyFontface', 'snippetFontface'],
  ['copyUsage',    'snippetUsage'],
  ['copyDataURI',  'snippetDataURI'],
  ['copyVarAxes',  'snippetVarAxes'],
].forEach(([btnId, textareaId]) => {
  el[btnId].addEventListener('click', () => {
    copyText(el[textareaId].value);
    const btn = el[btnId];
    btn.textContent = 'Copied!';
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
  });
});

// ===========================================================================
// Tabs
// ===========================================================================

el.tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    el.tabs.forEach(t => t.classList.toggle('active', t === tab));
    el.tabContents.forEach(tc => tc.classList.toggle('active', tc.id === `tab-${target}`));
  });
});

// ===========================================================================
// Batch export
// ===========================================================================

el.btnExportAll.addEventListener('click', () => {
  if (!state.fonts.size) { toast('No fonts loaded.', 'info'); return; }
  el.batchProgress.hidden = true;
  el.progressFill.style.width = '0%';
  el.batchModal.hidden = false;
});

el.batchModalClose.addEventListener('click', () => { el.batchModal.hidden = true; });
el.batchCancel.addEventListener('click', () => { el.batchModal.hidden = true; });
el.batchModal.addEventListener('click', e => { if (e.target === el.batchModal) el.batchModal.hidden = true; });

el.batchStart.addEventListener('click', async () => {
  const fmt   = el.batchFormat.value;
  const fonts = [...state.fonts.values()].map(e => e.font);
  const total = fonts.length;
  el.batchProgress.hidden = false;
  el.batchStart.disabled  = true;

  let done = 0;
  for (const font of fonts) {
    const base = Fonty.utils.basename(font.filename) || font.getMetadata().family || 'font';
    el.progressLabel.textContent = `Exporting ${base}.${fmt}...`;
    try {
      if (font.isBitmap && fmt !== 'fnt') { done++; continue; }
      const result = await font.convert(fmt, getFNTOptions());
      if (fmt === 'fnt') await saveFNTResult(result, base);
      else await saveSingleBuffer(result.buffer, `${base}.${result.ext}`, Fonty.MIME_TYPES[result.ext]);
    } catch (err) {
      toast(`Skipped ${base}: ${err.message}`, 'error');
    }
    done++;
    el.progressFill.style.width = `${Math.round(done / total * 100)}%`;
    await new Promise(r => setTimeout(r, 30));
  }
  el.progressLabel.textContent = `Done - ${done} of ${total} exported.`;
  el.batchStart.disabled = false;
  toast(`Batch export complete. ${done}/${total} fonts.`, 'success');
});

// ===========================================================================
// Status bar
// ===========================================================================

function updateStatusBar(font) {
  const meta = font.getMetadata();
  const family = meta.family || Fonty.utils.basename(font.filename);
  el.statusName.innerHTML = `<span>${escHtml(family)}</span>`;
  el.statusFormatVal.textContent = font.format.toUpperCase() + (font.isVariable ? ' VAR' : '');
  el.statusGlyphsVal.textContent = font.isBitmap ? (font._fntData?.chars?.size ?? '?') : font.glyphCount;
  el.statusSizeVal.textContent   = formatBytes(font._buffer?.byteLength ?? 0);
  el.statusSep.hidden     = false;
  el.statusFormat.hidden  = false;
  el.statusGlyphs.hidden  = false;
  el.statusSize.hidden    = false;
}

function clearStatusBar() {
  el.statusName.innerHTML = '<span>No font loaded</span>';
  el.statusSep.hidden    = true;
  el.statusFormat.hidden = true;
  el.statusGlyphs.hidden = true;
  el.statusSize.hidden   = true;
}

// ===========================================================================
// Layout helpers
// ===========================================================================

function hideDropZone() {
  el.dropZone.hidden = true;
  if (state.activeFontId) showFontDetail();
  else showEmptyState();
}

function showFontDetail() {
  el.dropZone.hidden    = true;
  el.fontDetail.hidden  = false;
  el.emptyState.hidden  = true;
}

function showEmptyState() {
  el.dropZone.hidden    = true;
  el.fontDetail.hidden  = true;
  el.emptyState.hidden  = false;
}

function showDropZone() {
  el.dropZone.hidden    = false;
  el.fontDetail.hidden  = true;
  el.emptyState.hidden  = true;
  clearStatusBar();
}

// ===========================================================================
// Drop zone + file inputs
// ===========================================================================

el.dropZone.addEventListener('dragover', e => {
  e.preventDefault(); el.dropZone.classList.add('drag-over');
});
el.dropZone.addEventListener('dragleave', () => el.dropZone.classList.remove('drag-over'));
el.dropZone.addEventListener('drop', e => {
  e.preventDefault(); el.dropZone.classList.remove('drag-over');
  loadFiles(e.dataTransfer.files);
});
document.body.addEventListener('dragover', e => e.preventDefault());
document.body.addEventListener('drop', e => {
  e.preventDefault(); if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

el.fileInput.addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
el.fileInputSide.addEventListener('change', e => { loadFiles(e.target.files); e.target.value = ''; });
el.btnOpenNative.addEventListener('click', openNativeFiles);
el.btnClearAll.addEventListener('click', clearAll);

// ===========================================================================
// Keyboard shortcuts
// ===========================================================================

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    el.atlasModal.hidden = true;
    el.batchModal.hidden = true;
  }
  if ((e.ctrlKey || e.metaKey) && e.key === 'o' && !IS_ELECTRON) {
    el.fileInput.click();
  }
});

// ===========================================================================
// Utilities
// ===========================================================================

function copyText(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;opacity:0';
  document.body.appendChild(ta); ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatBytes(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, nativeTheme } = require('electron');
const fs   = require('fs');
const path = require('path');

let mainWindow = null;

// ─────────────────────────────────────────────────────────────────────────────
// Window
// ─────────────────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 580,
    backgroundColor: '#0f0f10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: process.platform === 'linux',   // custom frame on Win/Mac
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    show: false,
  });

  mainWindow.loadFile('index.html');

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─────────────────────────────────────────────────────────────────────────────
// Menu
// ─────────────────────────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Font(s)…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu-open-files'),
        },
        { type: 'separator' },
        {
          label: 'Clear All Fonts',
          click: () => mainWindow?.webContents.send('menu-clear-all'),
        },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' }, { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'About Fonty',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'About Fonty',
              message: 'Fonty v2.0',
              detail: 'Font manager, inspector & converter.\nBest-in-class AngelCode FNT bitmap font support.\n\nLicensed MIT.',
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC - File I/O
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open one or more font files via native dialog.
 * Returns array of { name, path, data (base64) }.
 */
ipcMain.handle('open-font-files', async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Font(s)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Font Files', extensions: ['ttf', 'otf', 'woff', 'woff2', 'fnt'] }],
  });
  if (result.canceled) return [];

  return result.filePaths.map(fp => {
    const buf = fs.readFileSync(fp);
    return {
      name: path.basename(fp),
      filePath: fp,
      data: buf.toString('base64'),
    };
  });
});

/**
 * Save a single file via native Save dialog.
 * payload: { defaultName, ext, mimeType, data (base64) }
 */
ipcMain.handle('save-file', async (_, payload) => {
  if (!mainWindow) return null;
  const extMap = {
    ttf: 'TrueType Font', otf: 'OpenType Font',
    woff: 'Web Font', woff2: 'Compressed Web Font',
    fnt: 'AngelCode Bitmap Font', png: 'PNG Image',
    zip: 'ZIP Archive',
  };
  const ext = payload.ext || 'bin';
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: payload.defaultName || `font.${ext}`,
    filters: [
      { name: extMap[ext] || 'File', extensions: [ext] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return null;

  const buf = Buffer.from(payload.data, 'base64');
  fs.writeFileSync(result.filePath, buf);
  return result.filePath;
});

/**
 * Save multiple files to a directory (chosen via dialog).
 * files: [{ name, data (base64) }]
 */
ipcMain.handle('save-files-to-dir', async (_, files) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Output Folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled) return null;

  const dir = result.filePaths[0];
  for (const f of files) {
    const buf = Buffer.from(f.data, 'base64');
    fs.writeFileSync(path.join(dir, f.name), buf);
  }
  return dir;
});

/** Reveal a file/folder in OS file manager */
ipcMain.handle('show-in-folder', async (_, filePath) => {
  shell.showItemInFolder(filePath);
});

/** Window controls (for custom titlebar on Windows) */
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('win-close', () => mainWindow?.close());

// ─────────────────────────────────────────────────────────────────────────────
// App lifecycle
// ─────────────────────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

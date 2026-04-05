'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const fs   = require('fs');
const path = require('path');

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 580,
    backgroundColor: '#0b0b0e',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    frame: process.platform === 'linux',
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
    },
    show: false,
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';

  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Font(s)...',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu-open-files'),
        },
        { type: 'separator' },
        { label: 'Clear All Fonts', click: () => mainWindow?.webContents.send('menu-clear-all') },
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
              message: 'Fonty v2.1',
              detail: 'Font manager, inspector and converter.\nBest-in-class AngelCode FNT bitmap font support.\n\nhttps://github.com/Hexadecinull/Fonty\n\nLicensed under GPL-3.0.',
            });
          },
        },
        {
          label: 'View on GitHub',
          click: () => shell.openExternal('https://github.com/Hexadecinull/Fonty'),
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

ipcMain.handle('open-font-files', async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Font(s)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Font Files', extensions: ['ttf', 'otf', 'woff', 'woff2', 'fnt'] }],
  });
  if (result.canceled) return [];
  return result.filePaths.map(fp => ({
    name: path.basename(fp),
    filePath: fp,
    data: fs.readFileSync(fp).toString('base64'),
  }));
});

ipcMain.handle('save-file', async (_, payload) => {
  if (!mainWindow) return null;
  const extMap = {
    ttf: 'TrueType Font', otf: 'OpenType Font',
    woff: 'Web Font', woff2: 'Compressed Web Font',
    fnt: 'AngelCode Bitmap Font', png: 'PNG Image',
  };
  const ext    = payload.ext || 'bin';
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: payload.defaultName || `font.${ext}`,
    filters: [
      { name: extMap[ext] || 'File', extensions: [ext] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled) return null;
  fs.writeFileSync(result.filePath, Buffer.from(payload.data, 'base64'));
  return result.filePath;
});

ipcMain.handle('save-files-to-dir', async (_, files) => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose Output Folder',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled) return null;
  const dir = result.filePaths[0];
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f.name), Buffer.from(f.data, 'base64'));
  }
  return dir;
});

ipcMain.handle('show-in-folder', async (_, filePath) => shell.showItemInFolder(filePath));

ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('win-close', () => mainWindow?.close());

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

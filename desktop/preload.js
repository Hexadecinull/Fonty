'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: process.platform,

  // File I/O
  openFontFiles:    ()       => ipcRenderer.invoke('open-font-files'),
  saveFile:         payload  => ipcRenderer.invoke('save-file', payload),
  saveFilesToDir:   files    => ipcRenderer.invoke('save-files-to-dir', files),
  showInFolder:     filePath => ipcRenderer.invoke('show-in-folder', filePath),

  // Menu → renderer
  onMenuOpenFiles: cb => ipcRenderer.on('menu-open-files', cb),
  onMenuClearAll:  cb => ipcRenderer.on('menu-clear-all',  cb),

  // Window controls (custom titlebar on Win/Linux)
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close:    () => ipcRenderer.send('win-close'),
});

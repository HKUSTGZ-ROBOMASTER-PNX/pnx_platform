const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('PNXDesktop', {
  chooseFolder: () => ipcRenderer.invoke('pnx:choose-folder'),
  openToolDownload: tool => ipcRenderer.invoke('pnx:tool-download', tool),
});

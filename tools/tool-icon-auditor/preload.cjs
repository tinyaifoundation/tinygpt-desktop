const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('auditApp', {
  load: () => ipcRenderer.invoke('audit:load'),
  refresh: () => ipcRenderer.invoke('audit:refresh'),
  record: value => ipcRenderer.invoke('audit:record', value),
  remove: tool => ipcRenderer.invoke('audit:remove', tool),
  showFile: () => ipcRenderer.invoke('audit:show-file'),
  copyRequest: () => ipcRenderer.invoke('audit:copy-request'),
});

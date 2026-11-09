import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('tinygptSetup', Object.freeze({
  stop: () => ipcRenderer.send('tinygpt:model-setup-stop'),
}));

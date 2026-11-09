const { app, ipcMain } = require('electron');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const profile = resolve(process.env.TINYGPT_TOOLS_PROFILE);
mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
app.setAppPath(resolve(__dirname, '..'));
const register = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => register(channel, (event, input) => {
  if (['tinygpt:chat-return', 'tinygpt:window-control'].includes(channel)) process.stderr.write(`Window action ${channel} ${JSON.stringify(input)} from ${event.sender.getURL()}\n`);
  return listener(event, input);
});
app.on('browser-window-created', (_event, window) => {
  window.hide(); window.show = () => {}; window.focus = () => {};
  window.on('close', () => process.stderr.write(`Closing fixture window ${window.webContents.getURL()}\n`));
});
require('../out/main/index.js');

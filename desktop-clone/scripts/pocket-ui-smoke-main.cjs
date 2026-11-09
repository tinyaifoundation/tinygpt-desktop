const { app, ipcMain } = require('electron');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const profile = resolve(process.env.TINYGPT_VOICE_PROFILE); mkdirSync(profile, { recursive: true }); app.setPath('userData', profile); app.setPath('sessionData', profile);
app.setAppPath(resolve(__dirname, '..'));
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Use real stock-voice playback; voice cloning is no longer exposed.
app.on('browser-window-created', (_event, window) => { window.hide(); window.webContents.setAudioMuted(true); window.webContents.setBackgroundThrottling(false); });
require('../out/main/index.js');

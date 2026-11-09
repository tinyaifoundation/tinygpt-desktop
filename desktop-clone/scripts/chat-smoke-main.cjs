const { app } = require('electron');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const profile = resolve(process.env.TINYGPT_CHAT_PROFILE || resolve(__dirname, '../.chat-smoke-profile'));
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.on('browser-window-created', (_event, window) => window.hide());
require(process.env.TINYGPT_SMOKE_ASAR ? resolve(process.env.TINYGPT_SMOKE_ASAR, 'out/main/index.js') : '../out/main/index.js');

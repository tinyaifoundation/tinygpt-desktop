const { app } = require('electron');
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');

const profile = resolve(__dirname, '../.smoke-profile');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.on('browser-window-created', (_event, window) => window.hide());
require('../out/main/index.js');

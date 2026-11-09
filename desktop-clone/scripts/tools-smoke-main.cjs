const { app } = require('electron');
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
process.on('unhandledRejection', error => { console.error(error); app.exit(1); });
const { mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const profile = resolve(process.env.TINYGPT_TOOLS_PROFILE || '.tools-smoke-profile');
mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
// The current entry point owns this profile setting; keep legacy UI fixtures
// isolated when it initializes userData and acquires its instance lock.
process.env.TINYGPT_VOICE_PROFILE = profile;
app.on('browser-window-created', (_event, window) => window.hide());
require(process.env.TINYGPT_SMOKE_ASAR ? resolve(process.env.TINYGPT_SMOKE_ASAR,'out/main/index.js') : '../out/main/index.js');

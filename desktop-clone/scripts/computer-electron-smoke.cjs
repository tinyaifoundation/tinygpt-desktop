const { app } = require('electron');
const { join, resolve } = require('node:path');
const { main } = require('./computer-native-smoke.cjs');
app.setPath('userData', resolve(__dirname, '../.test-profile/computer-electron'));
app.whenReady().then(main).then(() => app.quit(), error => { console.error(error); app.exit(1); });

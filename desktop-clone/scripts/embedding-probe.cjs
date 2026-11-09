const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const processHandle = spawn(resolve('node_modules/electron/dist/electron.exe'), [resolve('scripts/embedding-probe-main.cjs')], { env, stdio: 'inherit', windowsHide: true });
processHandle.on('exit', code => { process.exitCode = code ?? 1; });

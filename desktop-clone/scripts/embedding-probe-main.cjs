const { app, utilityProcess } = require('electron');
const { resolve } = require('node:path');
app.whenReady().then(() => {
  const download = process.env.TINYGPT_EMBEDDING_DOWNLOAD === '1';
  const env = {}; for (const key of ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) if (typeof process.env[key] === 'string') env[key] = process.env[key];
  const worker = utilityProcess.fork(resolve(download ? 'out/main/embedding-worker.js' : 'scripts/embedding-offline-worker.cjs'), [], { env, stdio: 'pipe', serviceName: 'TinyGPT embedding verification' });
  let stderr = ''; worker.stderr.on('data', bytes => { stderr += bytes.toString(); });
  const timer = setTimeout(() => { console.error('Embedding probe timed out', stderr); worker.kill(); app.exit(1); }, 180000);
  worker.on('message', message => {
    if (message.ready) worker.postMessage({ id: 1, type: 'load', download, cacheDir: resolve(process.env.TINYGPT_EMBEDDING_CACHE || '.tools-smoke-profile/memory-retrieval/memory-models') });
    else if (!message.ok) { console.error(JSON.stringify({ message, stderr })); clearTimeout(timer); worker.kill(); app.exit(1); }
    else if (message.id === 1) worker.postMessage({ id: 2, type: 'embed', texts: ['Two maintainers must authorize production deployment.', 'Who needs to sign off before we ship?'], download: false });
    else { console.log(JSON.stringify({ dimensions: message.vectors.map(vector => vector.length), download, offlineNetworkBlocked: !download })); clearTimeout(timer); worker.kill(); app.quit(); }
  });
});

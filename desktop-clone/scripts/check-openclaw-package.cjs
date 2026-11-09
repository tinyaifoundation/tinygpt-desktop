const { readFile, access } = require('node:fs/promises');
const { join } = require('node:path');
module.exports = async context => {
  const runtimeTarget = `${context.electronPlatformName}-${context.arch === 1 ? 'x64' : context.arch === 3 ? 'arm64' : context.arch}`;
  const rag = require('../src/shared/rag-models.json');
  const ragRoot = join(context.packager.projectDir, 'runtimes', 'rag');
  const preparedRag = JSON.parse(await readFile(join(ragRoot, 'manifest.json'), 'utf8'));
  if (JSON.stringify(preparedRag) !== JSON.stringify(rag)) throw new Error('Prepare the pinned retrieval models before packaging: npm run runtime:rag.');
  for (const [name, model] of Object.entries(rag)) for (const file of model.files) {
    const path = join(ragRoot, name, file.path);
    const hash = require('node:crypto').createHash('sha256');
    for await (const bytes of require('node:fs').createReadStream(path)) hash.update(bytes);
    if (hash.digest('hex') !== file.sha256) throw new Error(`Bundled retrieval model is incomplete: ${name}/${file.path}`);
  }
  const voiceRoot=join(context.packager.projectDir,'runtimes/voice');
  const verify=async(file,pin)=>{const h=require('node:crypto').createHash('sha256');for await(const b of require('node:fs').createReadStream(file))h.update(b);if(h.digest('hex')!==pin.sha256)throw Error('Bundled voice asset checksum mismatch: '+file);};
  const voicePin=require('./voice-assets.lock.json');await verify(join(voiceRoot,'models/MiniCPM5-2B-Q4_K_M.gguf'),voicePin.model);for(const file of voicePin.speech)await verify(join(voiceRoot,'moonshine-model',file.name),file);
  const visionPin = require('../src/shared/vision-model.json'), visionRoot = join(context.packager.projectDir, 'runtimes/vision');
  if (JSON.stringify(JSON.parse(await readFile(join(visionRoot, 'manifest.json'), 'utf8'))) !== JSON.stringify(visionPin)) throw Error('Prepare the pinned vision resources before packaging: npm run runtime:vision.');
  for (const file of visionPin.files) await verify(join(visionRoot, file.name), file);
  const pocketPin = require('./pocket-assets.lock.json'), pocketRoot = join(voiceRoot, 'pocket-tts');
  const pocketPrepared = JSON.parse(await readFile(join(pocketRoot, 'prepared.json'), 'utf8'));
  if (pocketPrepared.release !== pocketPin.release || pocketPrepared.target !== runtimeTarget || pocketPrepared.archiveSha256 !== pocketPin.binaries[runtimeTarget]?.sha256) throw Error('Prepare the matching Pocket TTS runtime before packaging: npm run runtime:voice.');
  await verify(join(pocketRoot, runtimeTarget.startsWith('win32-') ? 'pocket-tts.exe' : 'pocket-tts'), { sha256: pocketPrepared.executableSha256 });
  for (const file of pocketPin.files) await verify(join(pocketRoot, file.name), file);
  const root = join(context.packager.projectDir, 'runtimes', 'openclaw');
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  if (Object.entries(lock.packages).some(([path, entry]) => path && (!path.startsWith('node_modules/') || entry.link))) throw new Error('The private OpenClaw lockfile must not link external project directories.');
  const prepared = JSON.parse(await readFile(join(root, 'prepared.json'), 'utf8').catch(() => { throw new Error('Prepare the pinned OpenClaw resource before packaging: npm run runtime:openclaw.'); }));
  const arch = require('builder-util').Arch[context.arch];
  const target = `${context.electronPlatformName}-${arch}`;
  if (prepared.openclaw !== '2026.9.9' || prepared.node !== '24.19.0' || prepared.target !== target) throw new Error(`OpenClaw resource targets ${prepared.target}; build ${target} on a matching native runner and prepare its runtime first.`);
  const installed = JSON.parse(await readFile(join(root, 'node_modules/openclaw/package.json'), 'utf8'));
  if (installed.version !== prepared.openclaw) throw new Error('OpenClaw resource version does not match its preparation record.');
  for (const path of ['host.mjs', 'tinygpt-bridge/index.mjs', 'tinygpt-bridge/openclaw.plugin.json', 'tinygpt-bridge/package.json', 'node_modules/openclaw/LICENSE', 'node/LICENSE', target.startsWith('win32-') ? 'node/node.exe' : 'node/bin/node']) await access(join(root, path));
};

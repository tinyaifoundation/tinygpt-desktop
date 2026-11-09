const { mkdir, cp, readFile, writeFile, access, readdir } = require('node:fs/promises');
const { join, resolve, dirname } = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
async function main() {
  const staging = resolve('artifacts/rag-proof-app'); await mkdir(staging, { recursive: true });
  await cp(resolve('out/main'), join(staging, 'out/main'), { recursive: true });
  await cp(resolve('scripts/rag-package-proof-main.cjs'), join(staging, 'main.cjs'));
  const deps = { '@huggingface/transformers': '4.3.1', 'sqlite-vec': '0.1.9', 'pdfjs-dist': '6.4.299', 'jszip':'3.10.2', 'exceljs':'4.4.0', 'tesseract.js':'6.0.1', '@tesseract.js-data/eng':'1.0.0', '@napi-rs/canvas':'1.0.10' };
  const copied = new Set();
  async function copyPackage(name, origin) {
    if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(name)) throw new Error('Invalid package name.');
    let folder = origin; let source;
    while (folder.startsWith(resolve('.'))) {
      const candidate = join(folder, 'node_modules', name);
      try { await access(join(candidate, 'package.json')); source = candidate; break; } catch {}
      const parent = dirname(folder); if (parent === folder) break; folder = parent;
    }
    if (!source || copied.has(name)) return; copied.add(name);
    const data = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
    const cached = process.argv.includes('--reuse-stage') && JSON.parse(await readFile(join(staging, 'node_modules', name, 'package.json'), 'utf8').catch(() => '{}')).version === data.version;
    if (!cached) await cp(source, join(staging, 'node_modules', name), { recursive: true });
    for (const child of Object.keys({ ...data.dependencies, ...data.optionalDependencies })) await copyPackage(child, source);
  }
  for (const name of Object.keys(deps)) await copyPackage(name, resolve('.'));
  await writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'tinygpt-rag-proof', version: '0.1.0', main: 'main.cjs', description: 'Bundled local retrieval and document-worker packaging proof', dependencies: deps }, null, 2));
  const fixtureName = (await readdir('.tools-smoke-profile')).filter(name=>name.startsWith('uploads-')).sort().at(-1);
  if (!fixtureName) throw Error('Run upload-library-smoke first to create document fixtures.');
  const fixtureRoot = resolve('.tools-smoke-profile',fixtureName,'fixtures');
  const config = resolve('artifacts/rag-proof-builder.cjs');
  await writeFile(config, 'module.exports=' + JSON.stringify({ appId: 'com.tinygpt.ragproof', productName: 'TinyGPT RAG Proof', electronVersion: require('electron/package.json').version, directories: { app: staging, output: resolve('release/rag-proof') }, asar: true, asarUnpack: ['node_modules/onnxruntime-node/bin/**/*', 'node_modules/sqlite-vec-*/**/*', 'node_modules/tesseract.js/**/*', 'node_modules/tesseract.js-core/**/*', 'node_modules/{bmp-js,is-url,regenerator-runtime,wasm-feature-detect}/**/*', 'node_modules/@tesseract.js-data/**/*', 'node_modules/@napi-rs/canvas*/**/*'], extraResources: [{ from: resolve('runtimes/rag'), to: 'rag' },{from:fixtureRoot,to:'document-fixtures'}], win: { target: [{ target: 'dir', arch: ['x64'] }], signAndEditExecutable: false } }) + ';\n');
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, [resolve('node_modules/electron-builder/out/cli/cli.js'), '--win', '--x64', '--dir', '--config', config], { stdio: 'inherit', windowsHide: true });
    child.once('error', reject); child.once('exit', code => code ? reject(new Error(`Packaging exited ${code}`)) : done());
  });
  const profiles = (await readdir('.tools-smoke-profile')).filter(name => name.startsWith('memory-run-')).sort();
  const profile = resolve('artifacts', `rag-packaged-profile-${Date.now()}`); await mkdir(profile, { recursive: true });
  // Make a consistent SQLite snapshot, including any uncheckpointed WAL data.
  const source = new (require('node:sqlite').DatabaseSync)(resolve('.tools-smoke-profile', profiles.at(-1), 'library.sqlite'), { readOnly: true });
  source.prepare('VACUUM INTO ?').run(join(profile, 'library.sqlite')); source.close();
  const exe = resolve('release/rag-proof/win-unpacked/TinyGPT RAG Proof.exe');
  await new Promise((done, reject) => {
    const env = { ...process.env, TINYGPT_RAG_PROOF_PROFILE: profile }; delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(exe, [], { env, stdio: 'ignore', windowsHide: true }); child.once('error', reject); child.once('exit', code => code ? reject(new Error(`Packaged worker test exited ${code}`)) : done());
  });
  const proof = JSON.parse(await readFile(join(profile, 'proof.json'), 'utf8')); assert.equal(proof.packaged, true); assert.deepEqual(proof.errors, []);
  await writeFile(resolve('artifacts/rag-packaged-proof.json'), JSON.stringify(proof, null, 2));
  console.log('Packaged RAG proof passed: ASAR native extension, bundled models, native retrieval, reranking and PDF worker.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

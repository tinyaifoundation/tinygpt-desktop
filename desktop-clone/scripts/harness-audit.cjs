// Uses a fresh Electron profile; the existing profile is read only for its selected key.
const { build } = require('esbuild');
const { spawn, spawnSync } = require('node:child_process');
const { resolve, join } = require('node:path');
const { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } = require('node:fs');
const { createHash } = require('node:crypto');

(async () => {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/harness-audit.cjs [--live] [--model z-ai/glm-5.3-flash] [--profile PATH] [--cases id,id] [--repeat 1] [--max-usd 1] [--max-requests 100] [--timeout-seconds 120] [--context-tokens 64000] [--output-tokens 4096] [--effort low] [--reuse-build] [--list]'); return;
  }
  const flags = ['--live', '--list', '--reuse-build'];
  const allowed = new Set([...flags, '--model', '--profile', '--cases', '--repeat', '--max-usd', '--max-requests', '--timeout-seconds', '--context-tokens', '--output-tokens', '--effort']);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i])) throw Error('Unknown option: ' + args[i]);
    const name = args[i]; options[name.slice(2)] = flags.includes(name) ? true : args[++i];
    if (options[name.slice(2)] === undefined) throw Error('Missing option value: ' + name);
  }
  const root = resolve(__dirname, '..');
  const output = join(root, 'artifacts', 'harness-audit', new Date().toISOString().replace(/[:.]/g, '-') + '-' + (options.live ? 'live' : 'fixture'));
  mkdirSync(output, { recursive: true }); mkdirSync(join(root, '.tools-smoke-profile'), { recursive: true });
  const profile = mkdtempSync(join(root, '.tools-smoke-profile', 'harness-audit-'));
  const source = resolve(options.profile || join(process.env.APPDATA || '', 'TinyGPT Voice Clone'));
  if (options.live && existsSync(join(source, 'Local State'))) {
    const state = JSON.parse(readFileSync(join(source, 'Local State'), 'utf8'));
    writeFileSync(join(profile, 'Local State'), JSON.stringify({ os_crypt: state.os_crypt }));
  }
  const main = join(root, 'out/main/harness-audit.cjs');
  const hash = createHash('sha256');
  // Hash the actual runtime dependency graph. Unrelated remote/UI work can
  // continue without invalidating a frozen Chat/Work audit build.
  const graph = await build({ absWorkingDir: root, entryPoints: ['scripts/harness-audit-main.ts', 'src/main/chat-worker.ts'], outdir: join(root, 'out/main/audit-dependencies'), bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.png': 'file', '.ico': 'file' }, external: ['electron'], write: false, metafile: true });
  const sourceFiles = [...new Set(Object.keys(graph.metafile.inputs).map(file => file.replace(/\?.*$/, '')))].sort();
  for (const file of sourceFiles) { hash.update(file); hash.update(readFileSync(resolve(root, file))); }
  for (const name of ['package.json', 'package-lock.json', 'electron.vite.config.ts']) hash.update(readFileSync(join(root, name)));
  const sourceFingerprint = hash.digest('hex');
  const stampPath = join(root, 'out/main/harness-audit-build.json');
  const git = (...args) => spawnSync('git', args, { cwd: root, windowsHide: true, encoding: 'utf8' }).stdout?.trim();
  options.buildProof = { sourceFingerprint, sourceScope: 'Dependency graph of audit main and Chat worker, plus dependency/build configuration; unrelated app modules excluded', sourceFiles, commit: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), dirty: !!git('status', '--porcelain'), builtAt: new Date().toISOString() };
  // Compile the current worker, avoiding stale production build output.
  if (!options.list) {
    if (options['reuse-build']) {
      if (!existsSync(stampPath) || JSON.parse(readFileSync(stampPath, 'utf8')).sourceFingerprint !== sourceFingerprint) throw Error('Build fingerprint differs from current source. Run once without --reuse-build.');
      options.buildProof = JSON.parse(readFileSync(stampPath, 'utf8'));
    } else {
    const built = spawn(process.execPath, [join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'build'], { cwd: root, windowsHide: true, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'production' } });
    const code = await new Promise(resolve => built.on('exit', resolve));
    if (code !== 0) throw Error('Current application build failed: ' + code);
    writeFileSync(stampPath, JSON.stringify(options.buildProof, null, 2));
    }
  }
  await build({ absWorkingDir: root, entryPoints: ['scripts/harness-audit-main.ts'], outfile: main, bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.png': 'file', '.ico': 'file' }, external: ['electron'] });
  const env = { ...process.env, TINYGPT_AUDIT_OPTIONS: JSON.stringify({ ...options, output, profile, source }) };
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  const child = spawn(require('electron'), [main], { cwd: root, env, windowsHide: true, stdio: 'inherit' });
  const watchdog = setTimeout(() => { child.kill(); }, 45 * 60 * 1000);
  process.exitCode = await new Promise(resolve => { child.once('error', error => { console.error(error.message); resolve(1); }); child.once('exit', code => resolve(code ?? 1)); });
  clearTimeout(watchdog); console.log('Audit artifacts: ' + output);
})().catch(error => { console.error(error.message); process.exitCode = 1; });

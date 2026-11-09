const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process'), { randomUUID } = require('node:crypto'), { buildSync } = require('esbuild');
const root = path.resolve(__dirname, '..'), stage = fs.mkdtempSync(path.join(root, '.test-profile/wait-native-'));
async function main() {
  if (process.platform !== 'win32') throw Error('Run native desktop verification on Windows.');
  const binary = path.join(stage, 'computer-fixture.exe'), state = path.join(stage, 'state.json'); let fixture, service;
  try {
    execFileSync(path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', `/out:${binary}`, path.join(root, 'tests/fixtures/computer-window.cs')], { windowsHide: true });
    fixture = spawn(binary, [state, '--minimized'], { windowsHide: true, stdio: 'ignore' });
    for (let i = 0; i < 100 && !fs.existsSync(state); i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(state));
    const entry = path.join(stage, 'native.cjs');
    buildSync({ stdin: { contents: "export {ComputerService} from './src/main/computer-service';export {CuaDriverFactory} from './src/main/computer-driver';export {computerExecutable} from './src/main/computer-process';export {defaultSettings} from './src/shared/config';", resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', packages: 'external', outfile: entry });
    const { ComputerService, CuaDriverFactory, computerExecutable, defaultSettings } = require(entry);
    const settings = structuredClone(defaultSettings), native = new CuaDriverFactory(path.join(root, 'runtimes/computer'), path.join(stage, 'manifests'));
    const factory = { available: () => native.available(), open: async resource => {
      if (resource && path.resolve(resource.executable || '').toLowerCase() !== binary.toLowerCase()) throw Error('Only the disposable fixture is allowed');
      const driver = await native.open(resource);
      return { close: () => driver.close(), call: async (name, args, signal) => { const value = await driver.call(name, args, signal); return name === 'list_windows' ? { ...value, windows: value.windows.filter(window => window.pid === fixture.pid) } : value; } };
    } };
    service = new ComputerService(factory, () => settings, computerExecutable);
    const context = { conversationId: randomUUID(), runId: randomUUID(), signal: new AbortController().signal };
    const call = (name, input) => service.execute({ ...context, operationId: randomUUID() }, name, input, async () => true);
    const windows = await call('computer_list_windows', { app: 'TinyGPT Computer Fixture' }); assert.equal(windows.windows.length, 1); const windowId = windows.windows[0].id;
    assert.equal(windows.windows[0].minimized, true);
    const restored = await call('computer_activate_window', { windowId }); assert.equal(restored.restored, true); assert.equal(restored.verified, true); assert.ok(restored.snapshot.elements.some(element => element.label === 'Connect'));
    const capture = await call('computer_screenshot', { windowId });
    assert.ok(capture.image.startsWith('data:image/png;base64,'));
    const image = Buffer.from(capture.image.split(',')[1], 'base64'); assert.deepEqual([...image.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true }); fs.writeFileSync(path.join(root, 'artifacts/native-window-vision.png'), image);
    const negative = await call('computer_read_window', { windowId, waitUntil: { text: 'Connected', timeoutMs: 2000 } }); assert.equal(negative.wait.matched, false); assert.equal(negative.wait.timedOut, true);
    const before = await call('computer_read_window', { windowId }); const connect = before.elements.find(element => element.label === 'Connect'); assert.ok(connect);
    const action = await call('computer_click', { windowId, elementId: connect.id, waitUntil: { text: 'Connected', timeoutMs: 10000 } }); assert.equal(action.actionDispatched, true); assert.equal(action.verified, true); assert.ok(action.wait.polls > 1);
    const connected = await call('computer_read_window', { windowId, waitUntil: { text: 'Connected', timeoutMs: 10000 } });
    assert.equal(connected.wait.matched, true); assert.equal(connected.wait.evidence, 'Connected');
    console.log(JSON.stringify({ desktopWait: 'passed', clickPostcondition: true, disconnectedRejected: true, delayedConnectionConfirmed: true, recoveryAfterTimeout: true, polls: action.wait.polls }));
  } finally { await service?.shutdown(); if (fixture && fixture.exitCode === null) { fixture.kill(); await new Promise(resolve => fixture.once('exit', resolve)); } }
  const browserEntry = path.join(stage, 'browser-main.cjs');
  buildSync({ entryPoints: [path.join(root, 'scripts/wait-until-browser-smoke-main.ts')], bundle: true, platform: 'node', format: 'cjs', packages: 'external', loader: { '.png': 'dataurl', '.ico': 'dataurl' }, outfile: browserEntry });
  const env = { ...process.env, TINYGPT_TOOLS_PROFILE: path.join(stage, 'browser-profile') }; delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
  await new Promise((resolve, reject) => { const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [browserEntry], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); const timer = setTimeout(() => { child.kill(); reject(Error('Browser fixture timed out')); }, 30000); child.stdout.on('data', bytes => process.stdout.write(bytes)); child.stderr.on('data', bytes => process.stderr.write(bytes)); child.once('error', reject); child.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(Error(`Browser fixture exited ${code}`)); }); });
}
main().catch(error => { console.error(error); process.exitCode = 1; });

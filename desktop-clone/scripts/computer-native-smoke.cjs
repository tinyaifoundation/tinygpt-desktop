/* Windows-only integration test. Uses a disposable native form and app-owned state. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { buildSync } = require('esbuild');

async function main() {
  if (process.platform !== 'win32') throw Error('Run this native fixture on Windows. Mac needs separate native validation.');
  const root = path.resolve(__dirname, '..');
  const stage = fs.mkdtempSync(path.join(root, '.tmp-computer-smoke-'));
  const binary = path.join(stage, 'computer-fixture.exe'), state = path.join(stage, 'state.json');
  let fixture, service;
  const launchedPids = [];
  try {
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    execFileSync(compiler, ['/nologo', '/target:winexe', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', `/out:${binary}`, path.join(root, 'tests/fixtures/computer-window.cs')], { windowsHide: true, stdio: 'pipe' });
    fixture = spawn(binary, [state], { windowsHide: true, stdio: 'ignore' });
    fixture.on('error', error => { console.error(error.message); });
    for (let n = 0; n < 100 && !fs.existsSync(state); n++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(state), 'Native fixture started');
    const initialVisibleCuaTerminals = JSON.parse(fs.readFileSync(state, 'utf8')).maxVisibleCuaTerminals;
    const entry = path.join(stage, 'service.cjs');
    buildSync({ stdin: { contents: `export { ComputerService } from './src/main/computer-service'; export { CuaDriverFactory, ComputerFailure } from './src/main/computer-driver'; export { computerExecutable } from './src/main/computer-process'; export { defaultSettings } from './src/shared/config'; export { ChatService } from './src/main/chat-service'; export { ToolBroker } from './src/main/tool-broker'; export { HistoryStore } from './src/main/history'; export { ProjectFiles } from './src/main/files'; export { runLibreChat } from './src/core/librechat'; export { isComputerTool } from './src/shared/computer';`, resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: entry, packages: 'external', loader: { '.png': 'dataurl', '.ico': 'dataurl' } });
    const { ComputerService, CuaDriverFactory, computerExecutable, defaultSettings, ChatService, ToolBroker, HistoryStore, ProjectFiles, runLibreChat, isComputerTool } = require(entry);
    const settings = structuredClone(defaultSettings);
    const nativeFactory = new CuaDriverFactory(path.join(root, 'runtimes/computer'), path.join(stage, 'manifests'));
    // Exercise the native ceiling independently of ComputerService's allowlist.
    const stdioEntry = path.join(stage, 'stdio.cjs');
    buildSync({ entryPoints: [path.join(root, 'src/main/computer-stdio.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: stdioEntry, packages: 'external' });
    const { openHiddenComputerDriver } = require(stdioEntry);
    const ceiling = path.join(stage, 'metadata-only.json');
    fs.writeFileSync(ceiling, JSON.stringify({ version: 3, expires_after: '15m', idle_timeout: '5m', allow: { tools: ['list_windows'] }, resources: { apps: [], desktop: { display: true } } }));
    const ceilingClient = await openHiddenComputerDriver(path.join(root, 'runtimes/computer/cua-driver.exe'), ceiling, 'com.tinygpt.voice.clone');
    try {
      const denied = await ceilingClient.callTool('get_window_state', JSON.stringify({ pid: fixture.pid, include_screenshot: false, include_accessibility_tree: true }), { signal: AbortSignal.timeout(10000) });
      assert.equal(denied.isError, true, 'Native metadata worker refuses document reads even if the host allowlist is bypassed');
      assert.equal(denied.errorCode, 'permission_denied', 'Native capability ceiling reports a permission refusal');
    } finally { await ceilingClient.shutdown(); }
    const factory = { available: () => nativeFactory.available(), open: async resource => {
      if (resource && (resource.launchOnly || path.resolve(resource.executable || '').toLowerCase() !== binary.toLowerCase())) throw Error('Outside the isolated native fixture');
      const driver = await nativeFactory.open(resource);
      return { close: () => driver.close(), call: async (name, args, signal) => { const value = await driver.call(name, args, signal); return name === 'list_windows' ? { ...value, windows: value.windows.filter(window => window.pid === fixture.pid) } : value; } };
    } };
    service = new ComputerService(factory, () => settings, computerExecutable);
    const runId = randomUUID(), conversationId = randomUUID(), signal = new AbortController().signal;
    const approvals = [];
    const call = (name, input) => service.execute({ conversationId, runId, signal, operationId: randomUUID() }, name, input, async request => { approvals.push(request); return true; });
    const listing = await call('computer_list_windows', { app: 'TinyGPT Computer Fixture' });
    assert.equal(listing.windows.length, 1, 'Only the isolated fixture was selected');
    const windowId = listing.windows[0].id;
    const snapshot = await call('computer_read_window', { windowId });
    assert.ok(snapshot.text.includes('Count: 0'), 'Non-interactive text is readable as well as controls');
    const field = snapshot.elements.find(element => element.label === 'Draft');
    assert.ok(field, 'Draft text field is accessible');
    assert.equal(JSON.stringify(snapshot).includes('fixture-secret'), false, 'Password content never reaches the model');
    const written = await call('computer_type', { windowId, elementId: field.id, text: 'Tuesday afternoon works for me.' });
    assert.equal(written.verified, true, 'Fresh accessibility state verifies the exact field value');
    for (let n = 0; n < 40 && JSON.parse(fs.readFileSync(state, 'utf8')).draft !== 'Tuesday afternoon works for me.'; n++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).draft, 'Tuesday afternoon works for me.', 'Application-owned state independently confirms the write');
    const replaced = await call('computer_type', { windowId, elementId: written.snapshot.elements.find(element => element.label === 'Draft').id, text: 'Replacement, not an append.' });
    assert.equal(replaced.verified, true, 'Replacement works when the original field is nonempty');
    for (let n = 0; n < 40 && JSON.parse(fs.readFileSync(state, 'utf8')).draft !== 'Replacement, not an append.'; n++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).draft, 'Replacement, not an append.', 'Application sees a replacement with no duplicated prefix');
    const increment = replaced.snapshot.elements.find(element => element.label === 'Increment');
    assert.ok(increment, 'Increment button is accessible');
    const clicked = await call('computer_click', { windowId, elementId: increment.id });
    assert.ok(clicked.snapshot.text.includes('Count: 1'), 'Fresh observed text confirms the button outcome');
    for (let n = 0; n < 20 && JSON.parse(fs.readFileSync(state, 'utf8')).clicks !== 1; n++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).clicks, 1, 'Native click reached the application');
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).sends, 0, 'Send was never invoked');
    // The app opened by a launch-only helper must survive that helper's shutdown.
    const launcher = await nativeFactory.open({ executable: binary, launchOnly: true });
    try {
      const launched = await launcher.call('launch_app', { path: binary, creates_new_application_instance: true }, new AbortController().signal);
      assert.ok(Number.isInteger(launched.pid) && launched.pid !== fixture.pid, 'Native launcher returned the new fixture process');
      launchedPids.push(launched.pid);
    } finally { await launcher.close(); }
    for (let n = 0; n < 40 && !fs.existsSync(path.join(stage, `launch-${launchedPids[0]}.json`)); n++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(path.join(stage, `launch-${launchedPids[0]}.json`)), 'Launched app survives the private launcher lifecycle');
    assert.equal(JSON.parse(fs.readFileSync(state, 'utf8')).maxVisibleCuaTerminals, initialVisibleCuaTerminals, 'No visible Cua terminal opened while the native helpers ran');
    service.endRun(runId);
    const followupRun = randomUUID();
    const followup = await service.execute({ conversationId, runId: followupRun, signal, operationId: randomUUID() }, 'computer_read_window', { windowId }, async () => true);
    assert.equal(followup.windowId, windowId, 'A follow-up reads the same window reference without rediscovery');
    assert.equal(followup.elements.find(element => element.label === 'Draft').value, 'Replacement, not an append.', 'Follow-up observes the actual original window');
    service.endRun(followupRun);
    if (process.argv.includes('--model')) {
      service.endRun(runId); await service.shutdown();
      // Reuse the running bundled model; no second model allocation or profile
      // change. The loopback key stays in memory and is never logged or saved.
      const profile = path.join(process.env.APPDATA, 'TinyGPT Voice Clone');
      const saved = JSON.parse(fs.readFileSync(path.join(profile, 'settings.json'), 'utf8'));
      const endpoint = new URL(saved.local.endpoint);
      assert.ok(['127.0.0.1', 'localhost'].includes(endpoint.hostname) && saved.local.model === 'MiniCPM5-2B', 'Use the running local MiniCPM connection');
      const key = fs.readFileSync(path.join(profile, 'local-models/minicpm5-2b/server.key'), 'utf8').trim();
      settings.local = { ...saved.local, tools: true, images: false, contextWindowTokens: 65536 }; settings.route = 'local';
      settings.toolPermissions = { ...settings.toolPermissions, desktop: 'allow', desktopInteract: 'allow', send: 'deny', purchase: 'deny', write: 'deny', execute: 'deny' };
      const unsupported = process.argv.includes('--unsupported');
      const liveStatus = process.argv.includes('--live-status'); let statusReads = 0;
      const largeTree = process.argv.includes('--large-tree'); let deepReads = 0;
      assert.ok([unsupported, liveStatus, largeTree].filter(Boolean).length <= 1, 'Choose one model scenario at a time');
      const { ComputerFailure } = require(entry); let rejectedWrites = 0;
      const guardedFactory = { available: () => factory.available(), open: async resource => {
        if (resource && path.resolve(resource.executable || '').toLowerCase() !== binary.toLowerCase()) throw Error('Outside the test fixture');
        const driver = await factory.open(resource);
        return { close: () => driver.close(), call: async (name, args, signal) => {
          if (unsupported && name === 'set_value') { rejectedWrites++; throw new ComputerFailure('COMPUTER_TEXT_WRITE_UNSUPPORTED', 'This editor could not confirm a direct text replacement. Read it once to check the contents, then offer the user a draft to paste manually. Do not retry this write or switch input tools.'); }
          const result = await driver.call(name, args, signal);
          if (largeTree && name === 'get_window_state') {
            if (args.max_elements === 5000) deepReads++;
            const prefix = result.elements[0].element_token.split(':')[0];
            const sidebar = Array.from({ length: 2200 }, (_, i) => ({ element_token: `${prefix}:${10000 + i}`, role: 'Button', label: `Sidebar chat ${i}` }));
            const all = [...sidebar, ...result.elements], limit = Number(args.max_elements);
            return { ...result, elements: all.slice(0, limit), elements_complete: all.length <= limit, truncated: all.length > limit };
          }
          // Reproduce indexed WinUI status-label churn from the saved VPN turn.
          // Only the passive status is synthetic; buttons, reads, dispatch and
          // application-owned click counts still exercise the real native app.
          if (liveStatus && name === 'get_window_state') return { ...result, elements: [...result.elements, { element_token: result.elements[0].element_token.split(':')[0] + ':999999', role: 'Text', label: `${++statusReads} KB/s` }] };
          return name === 'list_windows' ? { ...result, windows: result.windows.filter(window => window.pid === fixture.pid) } : result;
        } };
      } };
      service = new ComputerService(guardedFactory, () => settings, pid => pid === fixture.pid ? computerExecutable(pid) : undefined);
      const history = new HistoryStore(':memory:');
      const browser = { handoffs: () => [], tasks: () => [], shutdown: () => {} };
      const broker = new ToolBroker(history, () => settings, browser, new ProjectFiles(history.sources), () => {}); broker.computer = service;
      const execution = { run: (input, signal, delta, onTool, reasoning, response, context, trace, _nativeCode, steering) => runLibreChat(input, signal, delta, request => isComputerTool(request.name) ? onTool(request) : Promise.resolve(JSON.stringify({ error: 'Only the isolated computer_* fixture tools are available in this evaluation.' })), reasoning, response, context, undefined, trace, steering) };
      const chat = new ChatService(history, () => settings, () => key, execution, () => {}, broker);
      const conversation = history.createConversation(null, 'chat');
      const began = Date.now();
      try {
        chat.send(conversation.id, liveStatus ? 'Find the TinyGPT Computer Fixture window. Click Increment exactly once. Leave Draft and Send untouched. Use the computer tools and report the observed Count.' : 'Find the TinyGPT Computer Fixture window. Replace its Draft field with exactly: Hello from MiniCPM. Leave Send untouched. Use the computer tools and report the observed Draft value.');
        while (chat.isActive(conversation.id) && Date.now() - began < 180000) await new Promise(resolve => setTimeout(resolve, 100));
        if (chat.isActive(conversation.id)) { await chat.cancel(conversation.id); throw Error('The model evaluation reached its time limit.'); }
        const result = history.conversation(conversation.id);
        const observed = JSON.parse(fs.readFileSync(state, 'utf8'));
        console.log(JSON.stringify({ modelEvaluation: { model: settings.local.model, milliseconds: Date.now() - began, tools: result.tools.map(tool => ({ name: tool.name, status: tool.status, ...(tool.status === 'error' ? { error: tool.result } : {}) })), answer: result.messages.at(-1)?.text?.slice(0, 500), error: result.messages.at(-1)?.error, fieldMatches: observed.draft === 'Hello from MiniCPM.', sends: observed.sends } }, null, 2));
        if (liveStatus) {
          assert.ok(statusReads >= 3, 'Passive telemetry changed between the model read, preflight and post-action read');
          assert.equal(observed.clicks, 2, 'The model performs exactly one native click despite changing status text');
          assert.equal(observed.draft, 'Replacement, not an append.', 'The model leaves the existing draft alone');
          assert.ok(result.tools.length <= 5 && !result.messages.at(-1)?.error, 'The live-window task completes without stale-reference loops');
        } else if (unsupported) {
          assert.equal(rejectedWrites, 1, 'Unsupported native editor is never written to twice');
          assert.equal(observed.draft, 'Replacement, not an append.', 'Unsupported write leaves the fixture content alone');
          assert.ok(result.tools.length <= 6 && !result.messages.at(-1)?.error, 'The model ends with a manual draft instead of a read/retry loop');
          assert.match(result.messages.at(-1)?.text ?? '', /Hello from MiniCPM/);
        } else {
          assert.equal(observed.draft, 'Hello from MiniCPM.', 'Real MiniCPM completed the native desktop task through ordinary Chat');
          if (largeTree) { assert.ok(deepReads >= 3, 'Model discovers the input beyond the first native scan and preflight retains that scope'); assert.ok(result.tools.length <= 7 && !result.messages.at(-1)?.error, 'No repeated broad-read or truncation loop'); }
        }
        assert.equal(observed.sends, 0, 'Model did not send');
      } finally { await chat.shutdown(); await broker.shutdown(); history.close(); }
    }
    service.stop();
    await assert.rejects(() => call('computer_list_windows', {}), /off or stopped/);
    console.log(JSON.stringify({ result: 'passed', nativeWrite: true, nativeClick: true, independentAppState: true, passwordRedacted: true, noVisibleCuaTerminal: true, stop: true, approvals: approvals.map(request => ({ permission: request.permission, forceOnce: !!request.forceOnce })) }, null, 2));
  } finally {
    await service?.shutdown();
    for (const pid of launchedPids) { try { const { computerExecutable } = require(path.join(stage, 'service.cjs')); if (computerExecutable(pid)?.toLowerCase() === binary.toLowerCase()) process.kill(pid); } catch {} }
    if (fixture && fixture.exitCode === null) { fixture.kill(); await new Promise(resolve => fixture.once('exit', resolve)); }
    if (path.dirname(stage) !== root || !path.basename(stage).startsWith('.tmp-computer-smoke-')) throw Error('Unexpected fixture directory.');
    fs.rmSync(stage, { recursive: true, force: true });
  }
}
module.exports = { main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });

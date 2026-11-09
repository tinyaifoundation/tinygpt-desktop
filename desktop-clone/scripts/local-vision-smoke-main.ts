import { app, BrowserWindow, safeStorage } from 'electron';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { LocalVisionService } from '../src/main/local-vision';
import { HistoryStore } from '../src/main/history';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
import { imageReference } from '../src/shared/vision';
import { createServer } from 'node:http';
import { BrowserController as NativeBrowser } from '../src/main/browser';
import { execFileSync } from 'node:child_process';
import { ChatService } from '../src/main/chat-service';
import { chatExecution, closeChatRuntime } from '../src/main/chat-execution';

app.setPath('userData', process.env.TINYGPT_VISION_TEST_PROFILE!);
app.whenReady().then(async () => {
  await mkdir('artifacts', { recursive: true });
  const profile = app.getPath('userData');
  const service = new LocalVisionService({ modelRoot: resolve('runtimes/vision'), runtimeRoot: resolve('runtimes/voice/llama'), stateRoot: join(profile, 'sessions'), idleMs: 500 });
  const history = new HistoryStore(join(profile, 'library.sqlite'));
  const window = new BrowserWindow({ width: 768, height: 512, show: false });
  const browser = new NativeBrowser(() => {}, () => window);
  const circleHtml = '<html><body style="margin:0;background:white;display:flex;align-items:center;justify-content:center;height:100vh"><div style="width:240px;height:240px;background:red;border-radius:50%"></div></body></html>';
  const statusHtml = '<html><body style="margin:0;background:white;font-family:Arial;padding:48px"><h1 style="font-size:48px">TASK COMPLETE</h1><div style="font-size:40px">42 Mbps</div></body></html>';
  const fixture = createServer((request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end(request.url === '/status' ? statusHtml : circleHtml));
  await new Promise<void>(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + (fixture.address() as { port: number }).port;
  try {
    assert.equal(service.available(), true); assert.equal(service.status().loaded, false);
    const chat = history.createConversation(null, 'chat');
    const opened = await browser.open(chat.id, 'persist:vision-fixture', url, new AbortController().signal, randomUUID());
    const png = Buffer.from((await browser.capture(chat.id, opened.tabId)).split(',')[1], 'base64'); await writeFile('artifacts/vision-circle.png', png);
    const source = history.sources.add(chat.id, { kind: 'image', title: 'Circle.png', text: '', image: 'data:image/png;base64,' + png.toString('base64'), originalImage: png });
    const settings = structuredClone(defaultSettings); settings.toolPermissions.read = 'allow'; settings.toolPermissions.browser = 'allow';
    const broker = new ToolBroker(history, () => settings, browser, new ProjectFiles(history.sources), () => {});
    broker.localVision = service;
    const context = { conversationId: chat.id, runId: randomUUID(), signal: new AbortController().signal, vision: false };
    const call = async (name: 'view_image' | 'browser_screenshot', input: Record<string, unknown>) => JSON.parse(await broker.execute(context, { id: randomUUID(), name, input }));
    const start = performance.now();
    const result = await call('view_image', { image: imageReference(source.id), question: 'What color is the large circle? Answer in a few words.' });
    const coldMs = Math.round(performance.now() - start), pid = service.status().processId;
    const peakWorkingSetBytes = process.platform === 'win32' && pid ? Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).PeakWorkingSet64`], { windowsHide: true, timeout: 10000, encoding: 'utf8' }).trim()) : undefined;
    console.log(JSON.stringify({ stage: 'cold', elapsedMs: coldMs, peakWorkingSetBytes, result }));
    assert.equal(result.type, 'tinygpt-vision-result'); assert.match(result.observation, /red/i); assert.equal(result.incomplete, false); assert.ok(!JSON.stringify(result).includes('base64'));
    const cached = await call('view_image', { image: imageReference(source.id), question: 'What color is the large circle? Answer in a few words.' }); assert.equal(cached.observation, result.observation);
    const shot = await call('browser_screenshot', { tabId: opened.tabId });
    const shape = await call('view_image', { image: shot.imageReference, question: 'Name the large geometric shape. Answer in a few words.' }); assert.match(shape.observation, /circle|circular|round/i);
    await browser.navigateAgent(chat.id, opened.tabId, url + '/status', context.signal);
    const textPng = Buffer.from((await browser.capture(chat.id, opened.tabId)).split(',')[1], 'base64'); await writeFile('artifacts/vision-status.png', textPng);
    const text = history.sources.add(chat.id, { kind: 'image', title: 'Status.png', text: '', image: 'data:image/png;base64,' + textPng.toString('base64'), originalImage: textPng });
    const reading = await call('view_image', { image: imageReference(text.id), question: 'Read the large heading and speed shown. Do not guess.' });
    console.log(JSON.stringify({ stage: 'readability', result: reading }));
    const cropped = await call('view_image', { image: imageReference(text.id), question: 'Read the large heading only.', crop: { x: 0, y: 0, width: 1000, height: 300 } });
    console.log(JSON.stringify({ stage: 'cropped-heading', result: cropped })); assert.match(cropped.observation, /complete/i);
    assert.ok(!history.conversation(chat.id).tools.some(tool => tool.result?.includes('base64')));
    await new Promise(resolve => setTimeout(resolve, 800)); assert.equal(service.status().loaded, false);
    const coldAgain = await call('view_image', { image: imageReference(text.id), question: 'Is the large heading TASK COMPLETE? Answer briefly.' }); assert.match(coldAgain.observation, /complete|yes/i);
    let liveMain: { verified: boolean; answer: string; tools: string[] } | undefined;
    if (process.env.TINYGPT_VISION_LIVE_PROFILE) {
      const profile = process.env.TINYGPT_VISION_LIVE_PROFILE;
      const registry = JSON.parse(await readFile(join(profile, 'inference-connections.json'), 'utf8'));
      const connection = registry.connections.find((value: any) => value.id === registry.selected.local);
      assert.ok(connection && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connection.config.endpoint).hostname), 'Use only the selected loopback model');
      settings.route = 'local'; settings.local = { ...connection.config, tools: true, images: false, modelCapabilities: undefined };
      settings.toolPermissions = { ...settings.toolPermissions, read: 'allow', write: 'deny', execute: 'deny', browser: 'deny', desktop: 'deny', desktopInteract: 'deny' };
      const credentials = JSON.parse(await readFile(join(profile, 'credentials.json'), 'utf8'));
      const encrypted = credentials['connection:' + registry.selected.local] ?? credentials.local;
      const secret = encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : undefined;
      const chatService = new ChatService(history, () => settings, () => secret, chatExecution, () => {}, broker);
      try {
        const live = history.createConversation(null, 'chat');
        const attachment = history.sources.add(live.id, { kind: 'image', title: 'Fixture.png', text: '', image: 'data:image/png;base64,' + png.toString('base64'), originalImage: png });
        chatService.start(live.id, 'Inspect the attached image using view_image. What color is the large shape? Answer briefly.', [attachment.id]);
        const deadline = Date.now() + 100000;
        while (chatService.isActive(live.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        assert.equal(chatService.isActive(live.id), false, 'The live model must finish');
        const result = history.conversation(live.id), answer = result.messages.at(-1)!;
        console.log(JSON.stringify({ stage: 'live-text-main', status: answer.status, answer: answer.text, tools: result.tools.map(tool => ({ name: tool.name, status: tool.status })) }));
        assert.equal(answer.status, 'complete'); assert.match(answer.text, /red/i); assert.ok(result.tools.some(tool => tool.name === 'view_image' && tool.status === 'success'));
        liveMain = { verified: true, answer: answer.text, tools: result.tools.map(tool => tool.name) };
      } finally { await chatService.shutdown(); closeChatRuntime(); }
    }
    const raw = 'data:image/png;base64,' + png.toString('base64');
    await service.analyze(raw, 'Name the circle color only.', new AbortController().signal);
    const oldPid = service.status().processId!, cancellation = new AbortController();
    const interrupted = service.analyze(raw, 'Describe the large shape and all visible details.', cancellation.signal);
    const abortTimer = setTimeout(() => cancellation.abort(Error('Fixture cancellation')), 100);
    try { await assert.rejects(interrupted, /Fixture cancellation/); } finally { clearTimeout(abortTimer); }
    const recovered = await service.analyze(raw, 'What is the color of this circle? Answer briefly.', new AbortController().signal); assert.match(recovered.observation, /red/i);
    assert.throws(() => process.kill(oldPid, 0), 'The canceled generation process must be gone');
    await writeFile('artifacts/local-vision-proof.json', JSON.stringify({ verified: true, model: result.model, modelBytes: 278824384, nativeMainVision: false, coldMs, peakWorkingSetBytes, observation: result.observation, screenshotObservation: shape.observation, readability: reading.observation, croppedHeading: cropped.observation, readabilityExact: /42/.test(reading.observation) && /complete/i.test(cropped.observation), idleUnload: true, reloaded: true, cancellationRecovery: true, metadataOnly: true, liveMain }, null, 2));
    console.log('PASS: real SmolVLM, text-only tool result, attachment and screenshot inspection, idle unload and reload.');
  } finally { browser.shutdown(); window.destroy(); fixture.closeAllConnections(); fixture.close(); await service.close(); history.close(); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });

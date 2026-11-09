import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { LocalVisionService, VisionFailure, type VisionEngine } from '../src/main/local-vision';
import { HistoryStore } from '../src/main/history';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { defaultSettings } from '../src/shared/config';
import { imageReference, imageToolResult } from '../src/shared/vision';
import { ChatService } from '../src/main/chat-service';
import { runLibreChat } from '../src/core/librechat';
import { ImageTools } from '../src/main/image-tools';
import type { BrowserController } from '../src/main/browser';
import type { ChatWorkerInput } from '../src/shared/chat';

const pixels = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';
const services: LocalVisionService[] = [], histories: HistoryStore[] = [], servers: Server[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); histories.splice(0).forEach(history => history.close()); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); vi.restoreAllMocks(); vi.useRealTimers(); });
function service(engine?: Partial<VisionEngine>, idleMs = 100) {
  const instance = { analyze: vi.fn(async () => ({ observation: 'A red circle.', incomplete: false })), close: vi.fn(async () => {}), ...engine };
  const load = vi.fn(async (_signal: AbortSignal) => instance);
  const vision = new LocalVisionService({ modelRoot: 'unused', runtimeRoot: 'unused', stateRoot: 'unused', load, idleMs }); services.push(vision);
  return { vision, engine: instance, load };
}
function store() { const h = new HistoryStore(':memory:'); histories.push(h); return h; }
const signal = () => new AbortController().signal;

it.each([
  ['browser_screenshot', undefined], ['computer_screenshot', undefined],
  ['browser_screenshot', 'pro'], ['computer_screenshot', 'pro'],
] as const)('captures and inspects %s using the selected %s image route', async (captureTool, imageModel) => {
  const history = store(), chat = history.createConversation(null), { vision, engine } = service();
  const settings = structuredClone(defaultSettings); settings.toolPermissions.read = 'allow'; settings.toolPermissions.browser = 'allow';
  const capture = vi.fn(async () => pixels);
  const browser = { partition: () => 'fixture', capture } as unknown as BrowserController;
  const broker = new ToolBroker(history, () => settings, browser, new ProjectFiles(history.sources), () => {});
  broker.localVision = vision;
  const proAnalyze = vi.fn(async () => ({ observation: 'Pro inspected the screenshot.', incomplete: false }));
  broker.proVision = { available: () => true, analyze: proAnalyze };
  broker.computer = { execute: async () => ({ image: pixels }), retainCapture() {} } as unknown as NonNullable<ToolBroker['computer']>;
  const images = new ImageTools(history, browser, () => ({ image: pixels, mime: 'image/png', size: 68, width: 1, height: 1 }));
  vi.spyOn(broker.images, 'saveCapture').mockImplementation((...args) => images.saveCapture(...args));
  vi.spyOn(broker.images, 'view').mockImplementation((...args) => images.view(...args));
  const context = { conversationId: chat.id, runId: randomUUID(), signal: signal(), vision: false, imageModel };
  const saved = JSON.parse(await broker.execute(context, { id: randomUUID(), name: captureTool, input: captureTool === 'browser_screenshot' ? { tabId: randomUUID() } : { windowId: 'window-1-abcd' } }));
  expect(saved.imageReference).toMatch(/^tinygpt-image:/); expect(saved).not.toHaveProperty('image');
  const viewed = JSON.parse(await broker.execute(context, { id: randomUUID(), name: 'view_image', input: { image: saved.imageReference, question: 'What is visible?' } }));
  expect(viewed).toMatchObject({ type: 'tinygpt-vision-result', model: imageModel === 'pro' ? 'TinyGPT Pro' : 'SmolVLM-256M-Instruct', incomplete: false });
  expect(imageModel === 'pro' ? proAnalyze : engine.analyze).toHaveBeenCalledOnce();
  expect(imageModel === 'pro' ? engine.analyze : proAnalyze).not.toHaveBeenCalled();
  expect(JSON.stringify(history.conversation(chat.id).tools)).not.toContain('base64');
});

it('captures the Pro image route for the reply even if the current model selection changes', async () => {
  const history = store(), chat = history.createConversation(null), { vision, engine } = service();
  const settings = structuredClone(defaultSettings); settings.route = 'local'; settings.mode = 'chat'; settings.local.model = 'tinygpt-pro'; settings.local.tools = true; settings.toolPermissions.read = 'allow';
  const broker = new ToolBroker(history, () => settings, { partition: () => 'fixture', handoffs: () => [], tasks: () => [], endRun() {} } as unknown as BrowserController, new ProjectFiles(history.sources), () => {});
  broker.localVision = vision;
  const analyze = vi.fn(async () => ({ observation: 'Pro sees the image.', incomplete: false })); broker.proVision = { available: () => true, analyze };
  vi.spyOn(broker.images, 'view').mockResolvedValue({ metadata: { title: 'Image', imageReference: imageReference(randomUUID()), width: 1, height: 1 }, transport: { type: 'tinygpt-image-result', text: '', image: pixels } });
  let captured!: ChatWorkerInput, result = '';
  const chatService = new ChatService(history, () => settings, () => undefined, { async run(input, _signal, delta, onTool) {
    captured = input; settings.local.model = 'tinygpt-included';
    result = await onTool!({ id: randomUUID(), name: 'view_image', input: { image: 'fixture.png', question: 'Describe it.' } }); delta('Done');
  } }, () => {}, broker);
  try {
    chatService.start(chat.id, 'Inspect an image');
    for (let i = 0; i < 200 && chatService.isActive(chat.id); i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(captured.imageTools).toBe(true); expect(captured.instructions).toContain('selected Pro model');
    expect(JSON.parse(result)).toMatchObject({ model: 'TinyGPT Pro', observation: 'Pro sees the image.' });
    expect(analyze).toHaveBeenCalledTimes(1); expect(engine.analyze).not.toHaveBeenCalled();
  } finally { await chatService.shutdown(); }
});

it('routes Pro image tools exclusively to Pro and keeps the lightweight helper for other models', async () => {
  const history = store(), chat = history.createConversation(null), { vision, engine } = service();
  const settings = structuredClone(defaultSettings); settings.toolPermissions.read = 'allow';
  const broker = new ToolBroker(history, () => settings, { partition: () => 'fixture' } as unknown as BrowserController, new ProjectFiles(history.sources), () => {});
  broker.localVision = vision;
  const analyze = vi.fn(async () => ({ observation: 'Pro image observation.', incomplete: false }));
  broker.proVision = { available: () => true, analyze };
  vi.spyOn(broker.images, 'view').mockResolvedValue({ metadata: { title: 'Image', imageReference: imageReference(randomUUID()), width: 1, height: 1 }, transport: { type: 'tinygpt-image-result', text: '', image: pixels } });
  const context = { conversationId: chat.id, runId: randomUUID(), signal: signal(), vision: false, imageModel: 'pro' as const };
  const request = () => ({ id: randomUUID(), name: 'view_image' as const, input: { image: 'fixture.png', question: 'Color?' } });
  expect(JSON.parse(await broker.execute(context, request()))).toMatchObject({ model: 'TinyGPT Pro', observation: 'Pro image observation.' });
  expect(engine.analyze).not.toHaveBeenCalled();
  broker.proVision.available = () => false;
  expect(JSON.parse(await broker.execute(context, request()))).toMatchObject({ code: 'VISION_UNAVAILABLE' });
  expect(engine.analyze).not.toHaveBeenCalled();
  broker.proVision.available = () => true; settings.toolPermissions.read = 'deny';
  expect(JSON.parse(await broker.execute(context, request())).error).toContain('blocked'); expect(analyze).toHaveBeenCalledTimes(1);
  settings.toolPermissions.read = 'allow';
  expect(JSON.parse(await broker.execute({ ...context, imageModel: undefined }, request()))).toMatchObject({ model: 'SmolVLM-256M-Instruct' });
});

it('loads lazily, caches only matching image/question pairs, and unloads/reloads after idle', async () => {
  vi.useFakeTimers(); const { vision, engine, load } = service();
  expect(vision.status()).toMatchObject({ loaded: false, phase: 'idle' }); expect(load).not.toHaveBeenCalled();
  await vision.analyze(pixels, 'Color?', signal()); await vision.analyze(pixels, 'Color?', signal()); expect(engine.analyze).toHaveBeenCalledTimes(1);
  await vision.analyze(pixels, 'Shape?', signal()); expect(engine.analyze).toHaveBeenCalledTimes(2); expect(load).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(110); expect(engine.close).toHaveBeenCalledOnce(); expect(vision.status().loaded).toBe(false);
  await vision.analyze(pixels, 'Color?', signal()); expect(load).toHaveBeenCalledOnce(); // The immutable observation can survive model unloading.
  await vision.analyze(pixels, 'Other?', signal()); expect(load).toHaveBeenCalledTimes(2);
});

it('serializes concurrent requests and shares one model load', async () => {
  let release!: () => void, active = 0, peak = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { vision, load } = service({ analyze: vi.fn(async (_image, question) => { peak = Math.max(peak, ++active); await gate; active--; return { observation: question, incomplete: false }; }) });
  const first = vision.analyze(pixels, 'First', signal()), second = vision.analyze(pixels, 'Second', signal());
  await vi.waitFor(() => expect(load).toHaveBeenCalledOnce()); release();
  expect((await Promise.all([first, second])).map(value => value.observation)).toEqual(['First', 'Second']); expect(peak).toBe(1); expect(load).toHaveBeenCalledOnce();
});

it('cancels a queued request without canceling the current image', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const { vision, engine } = service({ analyze: vi.fn(async () => { await gate; return { observation: 'Done', incomplete: false }; }) });
  const first = vision.analyze(pixels, 'First', signal()), controller = new AbortController();
  const second = vision.analyze(pixels, 'Second', controller.signal); const rejected = expect(second).rejects.toThrow('Canceled'); controller.abort(Error('Canceled'));
  await rejected; release(); await first; expect(engine.analyze).toHaveBeenCalledOnce();
});

it('closes an aborted generation and restarts for the next request', async () => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const analyze = vi.fn(async (_image: string, question: string, request: AbortSignal) => {
    if (question === 'Abort') { started(); await new Promise((_, reject) => request.addEventListener('abort', () => reject(request.reason), { once: true })); }
    return { observation: 'Visible', incomplete: false };
  });
  const { vision, load, engine } = service({ analyze }); const controller = new AbortController();
  const first = vision.analyze(pixels, 'Abort', controller.signal); await ready;
  const rejected = expect(first).rejects.toThrow('Canceled'); controller.abort(Error('Canceled')); await rejected;
  await vision.analyze(pixels, 'Next', signal()); expect(engine.close).toHaveBeenCalledOnce(); expect(load).toHaveBeenCalledTimes(2);
});

it('never caches truncated observations and rejects empty analyses', async () => {
  const analyze = vi.fn().mockResolvedValueOnce({ observation: 'Partial', incomplete: true }).mockResolvedValueOnce({ observation: 'Full', incomplete: false }).mockResolvedValueOnce({ observation: '', incomplete: false });
  const { vision } = service({ analyze });
  expect((await vision.analyze(pixels, 'Same', signal())).incomplete).toBe(true); expect((await vision.analyze(pixels, 'Same', signal())).observation).toBe('Full');
  await expect(vision.analyze(pixels, 'Empty', signal())).rejects.toMatchObject({ code: 'VISION_EMPTY' });
});

it('does not load a model for invalid input or a canceled request', async () => {
  const { vision, load } = service();
  await expect(vision.analyze('https://example.org/image.png', 'Read', signal())).rejects.toBeInstanceOf(VisionFailure);
  await expect(vision.analyze(pixels, '', signal())).rejects.toBeInstanceOf(VisionFailure);
  const canceled = new AbortController(); canceled.abort(Error('Stop')); await expect(vision.analyze(pixels, 'Read', canceled.signal)).rejects.toThrow('Stop');
  expect(load).not.toHaveBeenCalled();
});

it('keeps original pixels immutable and private captures scoped to their conversation, including within a Project', () => {
  const history = store(), project = history.createProject('Images', ''), chat = history.createConversation(project.id), other = history.createConversation(project.id);
  const original = Buffer.from('original pixels'), source = history.sources.add(chat.id, { kind: 'project-file', title: 'Window screenshot', text: 'Private screenshot fixture', image: pixels, originalImage: original, privateImage: true });
  original.fill(0); expect(history.sources.originalImage(chat.id, source.id)?.toString()).toBe('original pixels');
  expect(history.sources.list(other.id).some(item => item.id === source.id)).toBe(false); expect(() => history.sources.originalImage(other.id, source.id)).toThrow('Source not found');
  expect(history.sources.search(chat.id, 'Private screenshot').some(item => item.sourceId === source.id)).toBe(true);
  expect(history.sources.search(other.id, 'Private screenshot').some(item => item.sourceId === source.id)).toBe(false);
  history.sources.remove(chat.id, source.id); expect(() => history.sources.originalImage(chat.id, source.id)).toThrow();
});

it('passes preserved originals and crop options into decoding without changing old image references', async () => {
  const history = store(), chat = history.createConversation(null);
  const source = history.sources.add(chat.id, { kind: 'image', title: 'Photo', text: '', image: pixels, originalImage: Buffer.from('original') });
  const normalize = vi.fn(() => ({ image: pixels, mime: 'image/png', size: 68, width: 10, height: 10, originalWidth: 100, originalHeight: 100 }));
  const images = new ImageTools(history, {} as BrowserController, normalize), crop = { x: 20, y: 20, width: 10, height: 10 };
  const result = await images.view(chat.id, imageReference(source.id), signal(), crop);
  expect(normalize).toHaveBeenCalledWith(Buffer.from('original'), crop); expect(result.metadata).toMatchObject({ imageReference: imageReference(source.id), crop, originalWidth: 100 });
});

it('allows the local helper with a text-only main model, honors denial first, and saves observations without pixels', async () => {
  const history = store(), chat = history.createConversation(null), { vision, load } = service();
  const settings = structuredClone(defaultSettings); settings.toolPermissions.read = 'deny';
  const broker = new ToolBroker(history, () => settings, { partition: () => 'fixture' } as unknown as BrowserController, new ProjectFiles(history.sources), () => {}); broker.localVision = vision;
  vi.spyOn(broker.images, 'view').mockResolvedValue({ metadata: { title: 'Image', imageReference: imageReference(randomUUID()), width: 1, height: 1 }, transport: { type: 'tinygpt-image-result', text: '', image: pixels } });
  const context = { conversationId: chat.id, runId: randomUUID(), signal: signal(), vision: false }, request = () => ({ id: randomUUID(), name: 'view_image' as const, input: { image: 'fixture.png', question: 'Color?' } });
  const inspect = vi.fn();
  broker.imageUnderstanding = { analyze: inspect } as unknown as NonNullable<ToolBroker['imageUnderstanding']>;
  expect(JSON.parse(await broker.execute(context, request())).error).toContain('blocked'); expect(load).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled();
  broker.imageUnderstanding = undefined;
  settings.toolPermissions.read = 'allow'; const result = await broker.execute(context, request());
  expect(JSON.parse(result)).toMatchObject({ type: 'tinygpt-vision-result', observation: 'A red circle.', model: 'SmolVLM-256M-Instruct' });
  expect(imageToolResult('view_image', result)).toBeNull(); expect(result).not.toContain('base64'); expect(history.conversation(chat.id).tools.at(-1)?.result).not.toContain('base64');
});

it('stores desktop captures as private image references and removes pixels from tool history and operation retention', async () => {
  const history = store(), chat = history.createConversation(null), settings = structuredClone(defaultSettings), { vision } = service();
  const browser = { partition: () => 'fixture' } as unknown as BrowserController;
  const broker = new ToolBroker(history, () => settings, browser, new ProjectFiles(history.sources), () => {}); broker.localVision = vision;
  const retainCapture = vi.fn(); broker.computer = { execute: async () => ({ image: pixels }), retainCapture } as unknown as NonNullable<ToolBroker['computer']>;
  const images = new ImageTools(history, browser, () => ({ image: pixels, mime: 'image/png', size: 68, width: 1, height: 1 }));
  vi.spyOn(broker.images, 'saveCapture').mockImplementation((...args) => images.saveCapture(...args));
  const context = { conversationId: chat.id, runId: randomUUID(), signal: signal(), vision: false }, operationId = randomUUID();
  const result = JSON.parse(await broker.execute(context, { id: operationId, name: 'computer_screenshot', input: { windowId: 'window-1-abcd' } }));
  expect(result.imageReference).toMatch(/^tinygpt-image:/); expect(result.windowId).toBe('window-1-abcd');
  expect(retainCapture).toHaveBeenCalledWith(context.runId, operationId, result);
  expect(JSON.stringify(history.conversation(chat.id).tools)).not.toContain('base64');
  expect(history.sources.originalImage(chat.id, result.imageReference.slice('tinygpt-image:'.length))).toEqual(Buffer.from(pixels.split(',')[1], 'base64'));
});

it('advertises image tools separately from native vision on the normal Chat service path', async () => {
  const history = store(), chat = history.createConversation(null), { vision } = service();
  const settings = structuredClone(defaultSettings); settings.local = { ...settings.local, model: 'text-only', images: false, tools: true };
  const broker = new ToolBroker(history, () => settings, { handoffs: () => [], tasks: () => [], endRun() {} } as unknown as BrowserController, new ProjectFiles(history.sources), () => {}); broker.localVision = vision;
  let captured!: ChatWorkerInput;
  const chatService = new ChatService(history, () => settings, () => undefined, { async run(input, _signal, delta) { captured = input; delta('Done'); } }, () => {}, broker);
  const source = history.sources.add(chat.id, { kind: 'image', title: 'Image', text: '', image: pixels });
  chatService.start(chat.id, 'Inspect this image', [source.id]);
  for (let i = 0; i < 100 && chatService.isActive(chat.id); i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(captured.vision).toBe(false); expect(captured.imageTools).toBe(true); expect(captured.instructions).toContain('bundled local image assistant');
  expect(JSON.stringify(captured.messages)).not.toContain('base64'); expect(JSON.stringify(captured.messages)).toContain(imageReference(source.id));
});

it('keeps image payloads out of a text-only main provider request through the real shared graph', async () => {
  const bodies: any[] = [], { vision } = service();
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw); bodies.push(body);
    const action = bodies.length === 1 ? { name: 'load_tools', arguments: '{"group":"images","query":"view_image"}' } : { name: 'view_image', arguments: JSON.stringify({ image: 'fixture.png', question: 'Color?' }) };
    const delta = bodies.length <= 2 ? { tool_calls: [{ index: 0, id: 'view-' + bodies.length, type: 'function', function: action }] } : { content: 'The circle is red.' };
    const chunk = (delta: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'fixture-' + bodies.length, object: 'chat.completion.chunk', model: 'text', choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(chunk({ role: 'assistant', ...delta }, null) + chunk({}, bodies.length <= 2 ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let answer = '';
  await runLibreChat({ runId: randomUUID(), route: 'local', provider: 'local', protocol: 'openai-compatible', endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, mode: 'chat', model: 'text', vision: false, imageTools: true, tools: true, contextWindowTokens: 64000, instructions: 'Inspect the image using the tool.', messages: [{ role: 'user', text: 'Inspect fixture.png' }] }, signal(), text => { answer += text; }, async request => { if (request.validationError) throw Error(request.validationError); return request.name === 'load_tools' ? '{"enabled":"images","query":"view_image"}' : JSON.stringify({ type: 'tinygpt-vision-result', ...await vision.analyze(pixels, 'Color?', signal()) }); });
  expect(answer).toContain('red'); expect(bodies).toHaveLength(3); expect(bodies[0].tools.some((tool: any) => tool.function.name === 'view_image')).toBe(false); expect(bodies[1].tools.some((tool: any) => tool.function.name === 'view_image')).toBe(true);
  expect(JSON.stringify(bodies)).not.toContain('data:image'); expect(JSON.stringify(bodies[2])).toContain('A red circle.');
}, 20_000);

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { HistoryStore } from '../src/main/history';
import { ImageTools } from '../src/main/image-tools';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import type { BrowserController } from '../src/main/browser';
import { defaultSettings } from '../src/shared/config';
import { imageMcpContent, imageReference, imageToolResult, supportsVision } from '../src/shared/vision';
import { ChatService } from '../src/main/chat-service';
import type { ChatWorkerInput } from '../src/shared/chat';
import { visionEvidenceFetch } from '../src/core/vision-evidence';
import { runLibreChat } from '../src/core/librechat';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==';
const stores: HistoryStore[] = [], servers: Server[] = [];
const store = () => { const history = new HistoryStore(':memory:'); stores.push(history); return history; };
const signal = () => new AbortController().signal;
afterEach(async () => { stores.splice(0).forEach(history => history.close()); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); vi.restoreAllMocks(); });
const normalize = vi.fn(() => ({ image, mime: 'image/png', size: 68, width: 1, height: 1 }));

describe('on-demand vision', () => {
  it.each(['openai-compatible', 'openai-responses', 'anthropic'])('uses native image content for %s, retains it for later tool rounds, and omits it from summaries', async protocol => {
    const requests: any[] = []; const transport = vi.fn(async (_url, options) => { requests.push(JSON.parse(options.body)); return new Response('{}'); });
    let compacting = false;
    const fetch = visionEvidenceFetch(transport as typeof globalThis.fetch, protocol, () => [{ text: 'Saved evidence', image }], () => compacting);
    const body = protocol === 'openai-responses' ? { input: [{ role: 'user', content: 'Read image' }] } : { messages: [{ role: 'user', content: 'Read image' }] };
    await fetch('http://127.0.0.1/v1', { method: 'POST', body: JSON.stringify(body) });
    await fetch('http://127.0.0.1/v1', { method: 'POST', body: JSON.stringify(body) });
    compacting = true; await fetch('http://127.0.0.1/v1', { method: 'POST', body: JSON.stringify(body) });
    for (const request of requests.slice(0, 2)) {
      const content = (request.input ?? request.messages).at(-1).content;
      expect(content[0].text).toContain('untrusted');
      expect(content[1].type).toBe(protocol === 'anthropic' ? 'image' : protocol === 'openai-responses' ? 'input_image' : 'image_url');
      expect(JSON.stringify(content[1])).toContain(image.split(',')[1]);
    }
    expect(JSON.stringify(requests[2])).not.toContain('base64');
  });
  it('respects selected-model metadata and explicit support for custom connections', () => {
    expect(supportsVision({ model: 'text', images: true, modelCapabilities: { model: 'text', images: false } })).toBe(false);
    expect(supportsVision({ model: 'vision', images: true, modelCapabilities: { model: 'vision', images: true } })).toBe(true);
    expect(supportsVision({ model: 'local', images: true })).toBe(true);
    expect(supportsVision({ model: 'vision', images: false })).toBe(false);
  });
  it('views scoped attachments, rejects cross-conversation references, and preserves repository snapshots', async () => {
    const history = store(); const root = await realpath(await mkdtemp(join(tmpdir(), 'tinygpt-images-')));
    const project = history.createProject('Images', '', false, root);
    const conversation = history.createConversation(project.id), other = history.createConversation(null);
    const attached = history.sources.add(conversation.id, { kind: 'image', title: 'upload.png', text: '', image, mime: 'image/png' });
    const tools = new ImageTools(history, {} as BrowserController, normalize);
    expect((await tools.view(conversation.id, imageReference(attached.id), signal())).transport.image).toBe(image);
    await expect(tools.view(other.id, imageReference(attached.id), signal())).rejects.toThrow('Source not found');
    await expect(tools.view(conversation.id, '../outside.png', signal())).rejects.toThrow('outside');
    await expect(tools.view(conversation.id, 'https://example.test/image.png', signal())).rejects.toThrow('relative path');
    await writeFile(join(root, 'design.png'), Buffer.from('first'));
    const first = await tools.view(conversation.id, 'design.png', signal());
    await writeFile(join(root, 'design.png'), Buffer.from('second'));
    const second = await tools.view(conversation.id, 'design.png', signal());
    expect(first.metadata.imageReference).not.toBe(second.metadata.imageReference);
    expect((await tools.view(conversation.id, first.metadata.imageReference, signal())).transport.image).toBe(image);
  });
  it('saves quiet screenshots as reusable references without making them composer drafts', async () => {
    const history = store(); const conversation = history.createConversation(null);
    const capture = vi.fn(async () => image);
    const tools = new ImageTools(history, { capture } as unknown as BrowserController, normalize);
    const screenshot = await tools.screenshot(conversation.id, randomUUID(), signal());
    expect(capture).toHaveBeenCalledOnce(); expect(screenshot).not.toHaveProperty('image');
    expect(history.sources.list(conversation.id)[0].kind).toBe('project-file');
    expect((await tools.view(conversation.id, screenshot.imageReference, signal())).transport.image).toBe(image);
  });
  it('enforces capability and permission at the broker, persisting metadata rather than base64 tool output', async () => {
    const history = store(); const conversation = history.createConversation(null);
    const settings = { ...defaultSettings, toolPermissions: { ...defaultSettings.toolPermissions, read: 'allow' as const } };
    const broker = new ToolBroker(history, () => settings, { partition: () => 'fixture' } as unknown as BrowserController, new ProjectFiles(history.sources), () => {});
    const viewed = vi.spyOn(broker.images, 'view').mockResolvedValue({ metadata: { title: 'image.png', imageReference: imageReference(randomUUID()), width: 1, height: 1 }, transport: { type: 'tinygpt-image-result', text: 'Image evidence', image } });
    const context = { conversationId: conversation.id, runId: randomUUID(), signal: signal(), vision: false };
    const request = { id: randomUUID(), name: 'view_image' as const, input: { image: 'image.png' } };
    expect(JSON.parse(await broker.execute(context, request)).error).toContain('vision-capable'); expect(viewed).not.toHaveBeenCalled();
    settings.toolPermissions.read = 'deny' as any;
    await broker.execute({ ...context, vision: true }, { ...request, id: randomUUID() }); expect(viewed).not.toHaveBeenCalled();
    settings.toolPermissions.read = 'allow';
    const result = await broker.execute({ ...context, vision: true }, { ...request, id: randomUUID() });
    expect(imageToolResult('view_image', result)?.image).toBe(image);
    expect(history.conversation(conversation.id).tools.at(-1)?.result).not.toContain('base64');
    expect(imageToolResult('ext_faked', result)).toBeNull();
    expect(imageMcpContent('view_image', result)[1]).toMatchObject({ type: 'image', mimeType: 'image/png', data: image.split(',')[1] });
  });
  it('supplies attachment references on the initial prompt and later turns, with no eager pixels', async () => {
    const history = store(); const conversation = history.createConversation(null); const inputs: ChatWorkerInput[] = [];
    const chat = new ChatService(history, () => ({ ...defaultSettings, local: { ...defaultSettings.local, model: 'fixture', images: true } }), () => undefined,
      { async run(input, _signal, delta) { inputs.push(input); delta('Done'); } }, () => {});
    const attached = history.sources.add(conversation.id, { kind: 'image', title: 'uploaded.png', text: '', image });
    chat.start(conversation.id, 'Describe this', [attached.id]);
    while (chat.isActive(conversation.id)) await new Promise(resolve => setTimeout(resolve, 5));
    chat.start(conversation.id, 'Look again');
    while (chat.isActive(conversation.id)) await new Promise(resolve => setTimeout(resolve, 5));
    for (const input of inputs) { expect(input.vision).toBe(true); expect(JSON.stringify(input.messages)).toContain(imageReference(attached.id)); expect(JSON.stringify(input.messages)).not.toContain('base64'); }
  });
  it.each([{ vision: false, batch: 0 }, { vision: true, batch: 1 }, { vision: true, batch: 5 }])('gates vision tools and safely delivers image batches ($vision, $batch)', async ({ vision, batch }) => {
    let calls = 0, toolCalls = 0; const bodies: any[] = [];
    const server = createServer(async (request, response) => {
      let raw = ''; for await (const part of request) raw += part; const body = JSON.parse(raw); bodies.push(body); calls++;
      const tool = vision && calls <= 2;
      const delta = vision && calls === 1 ? { role: 'assistant', tool_calls: [{ index: 0, id: 'load-images', type: 'function', function: { name: 'load_tools', arguments: '{"group":"images"}' } }] } : vision && calls === 2 ? { role: 'assistant', tool_calls: Array.from({ length: batch }, (_, index) => ({ index, id: 'view_' + index, type: 'function', function: { name: 'view_image', arguments: JSON.stringify({ image: 'design' + index + '.png' }) } })) } : { role: 'assistant', content: 'Done.' };
      const frame = (delta: unknown, finish_reason: string | null) => ({ id: `chatcmpl-vision-${calls}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
      response.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`data: ${JSON.stringify(frame(delta, null))}\n\ndata: ${JSON.stringify(frame({}, tool ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
    }); servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as any).port}/v1`;
    await runLibreChat({ runId: randomUUID(), route: 'local', provider: 'local', protocol: 'openai-compatible', endpoint, model: 'fixture', tools: true, vision, contextWindowTokens: 131072, instructions: 'Inspect images only as needed.', messages: [{ role: 'user', text: 'Inspect design.png' }] }, signal(), () => {}, async request => { if (request.validationError) throw Error(request.validationError); if (request.name === 'load_tools') return '{"enabled":"images"}'; toolCalls++; return JSON.stringify({ type: 'tinygpt-image-result', text: 'Image evidence', image }); });
    for (const [index, body] of bodies.entries()) { const names = body.tools?.map((tool: any) => tool.function.name) ?? []; expect(names.includes('view_image')).toBe(vision && index > 0); expect(names.includes('browser_screenshot')).toBe(false); expect(body.messages.filter((message: any) => message.role === 'tool').every((message: any) => !message.content.includes('base64'))).toBe(true); }
    expect(JSON.stringify(bodies[0].messages)).not.toContain('base64');
    if (vision) expect(bodies[2].messages.some((message: any) => Array.isArray(message.content) && message.content.some((part: any) => part.type === 'image_url' && part.image_url?.url === image))).toBe(true);
    expect(calls).toBe(vision ? 3 : 1); expect(toolCalls).toBe(vision ? Math.min(batch, 4) : 0);
    if (batch > 4) expect(JSON.stringify(bodies[2].messages)).toContain('Review the current image results');
  }, 30000);
});

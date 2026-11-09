import { app } from 'electron';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { chatExecution, closeChatRuntime } from '../src/main/chat-execution';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { defaultSettings, type Settings } from '../src/shared/config';
import { builtInModelInfo } from '../src/shared/managed-local';
import type { BrowserController } from '../src/main/browser';
import { ManagedLocalModel } from '../src/main/managed-local';

app.setPath('userData', process.env.TINYGPT_BUILT_IN_TEST_PROFILE!);
app.whenReady().then(async () => {
  const cache = resolve('.tools-smoke-profile', 'builtins');
  const managed = new ManagedLocalModel(join(cache, 'pro'), undefined, 'pro', join(cache, 'runtime'));
  assert.ok((await managed.installedStatus()).installed, 'First cache the weights with built-in-model-smoke.cjs --download-pro.');
  const { endpoint, key } = await managed.start(process.env.TINYGPT_TEST_MTP === '1');
  const model = builtInModelInfo('pro');
  const settings: Settings = { ...defaultSettings, route: 'local', mode: 'chat', effort: { chat: 'instant', code: 'max' },
    local: { ...defaultSettings.local, endpoint, model: model.id, tools: true, images: false, contextWindowTokens: model.contextWindowTokens, maxOutputTokens: model.maxOutputTokens, modelCapabilities: { model: model.id, name: model.name, images: false, reasoning: model.reasoning } },
    toolPermissions: { ...defaultSettings.toolPermissions, read: 'allow', write: 'deny', execute: 'deny', browser: 'deny', interact: 'deny', desktop: 'deny', desktopInteract: 'deny' } };
  const history = new HistoryStore(join(app.getPath('userData'), 'library.sqlite'));
  const browser = { partition: () => 'fixture', handoffs: () => [], tasks: () => [], endRun() {}, shutdown() {} } as unknown as BrowserController;
  const broker = new ToolBroker(history, () => settings, browser, new ProjectFiles(history.sources), () => {});
  const service = new ChatService(history, () => settings, () => key, chatExecution, () => {}, broker);
  const proof: Record<string, unknown> = { model: model.name, realWorker: true, mtp: process.env.TINYGPT_TEST_MTP === '1' };
  async function idle(id: string) {
    const deadline = Date.now() + 240000; let last = '';
    while (service.isActive(id) && Date.now() < deadline) {
      const state = service.update(id).conversation.tools.map(tool => `${tool.name}:${tool.status}`).join(', ');
      if (state && state !== last) { last = state; console.log(state); }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (service.isActive(id)) { await service.cancel(id); throw Error('Live harness check timed out.'); }
    const result = service.update(id).conversation, reply = result.messages.at(-1)!;
    assert.equal(reply.status, 'complete', reply.error || 'Reply did not complete.');
    return { result, reply };
  }
  try {
    const chat = history.createConversation(null, 'chat');
    service.start(chat.id, 'Reply with exactly CHAT_PRO_OK. Do not call tools.');
    const chatResult = await idle(chat.id);
    assert.match(chatResult.reply.text, /CHAT_PRO_OK/);
    proof.chat = { status: chatResult.reply.status, answer: chatResult.reply.text };
    console.log('Chat completed.');
    settings.mode = 'code';
    const work = history.createConversation(null, 'code');
    const files = join(history.generatedFilesRoot, work.id, 'inputs');
    await mkdir(files, { recursive: true }); await writeFile(join(files, 'probe.txt'), 'PRO_WORK_CHECK_42');
    service.start(work.id, 'Read inputs/probe.txt in the managed workspace and report its exact contents as an output named Probe. Verify it by actually reading the file. This is an information request, so no asynchronous completion condition is needed. Do not change files, run commands, browse, or ask questions.');
    const workResult = await idle(work.id);
    assert.equal(workResult.reply.workTask?.status, 'completed');
    assert.match(workResult.reply.text, /PRO_WORK_CHECK_42/);
    assert.ok(workResult.result.tools.some(tool => ['read_file', 'read_project_file'].includes(tool.name) && tool.status === 'success'));
    proof.work = { effort: 'max', status: workResult.reply.workTask?.status, answer: workResult.reply.text, tools: workResult.result.tools.map(tool => ({ name: tool.name, status: tool.status })) };
    await mkdir(resolve('artifacts'), { recursive: true });
    await writeFile(resolve('artifacts/built-in-harness-proof.json'), JSON.stringify(proof, null, 2));
    console.log(JSON.stringify(proof, null, 2));
  } finally { await service.shutdown(); await broker.shutdown(); closeChatRuntime(); history.close(); await managed.stop(); }
}).then(() => app.quit(), error => { console.error(error.message); app.exit(1); });

import { app, safeStorage } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { chatExecution, closeChatRuntime } from '../src/main/chat-execution';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
app.setPath('userData', process.env.TINYGPT_PRO_TEST_PROFILE!);
app.whenReady().then(async () => {
  const profile = process.env.TINYGPT_PRO_LIVE_PROFILE!, stage = app.getPath('userData');
  const registry = JSON.parse(await readFile(join(profile, 'inference-connections.json'), 'utf8'));
  const connection = registry.connections.find((c: any) => c.config.model === 'tinygpt-pro');
  assert.ok(connection && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connection.config.endpoint).hostname));
  const credentials = JSON.parse(await readFile(join(profile, 'credentials.json'), 'utf8'));
  const encrypted = credentials['connection:' + connection.id] ?? credentials.local;
  const secret = encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : '';
  const endpoint = connection.config.endpoint.replace(/\/+$/, '');
  const history = new HistoryStore(join(stage, 'library.sqlite'));
  const settings = structuredClone(defaultSettings); settings.route = 'local'; settings.mode = 'code'; settings.effort.code = 'max'; settings.local = { ...connection.config, endpoint, tools: true, images: false };
  settings.toolPermissions = { ...settings.toolPermissions, read: 'allow', write: 'allow', execute: 'deny', browser: 'deny', desktop: 'deny', desktopInteract: 'deny' };
  const browser = { partition: () => 'fixture', handoffs: () => [], tasks: () => [], endRun() {}, shutdown() {} } as unknown as BrowserController;
  const broker = new ToolBroker(history, () => settings, browser, new ProjectFiles(history.sources), () => {});
  const service = new ChatService(history, () => settings, () => secret, chatExecution, () => {}, broker);
  try {
    const chat = history.createConversation(null, 'code'), start = Date.now();
    service.start(chat.id, 'Create index.html containing exactly <h1>Pro work verified</h1> in the managed workspace. Read it back to verify the exact content and finish the task. Do not research, run commands or install anything.');
    const deadline = Date.now() + 300000;
    while (service.isActive(chat.id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    if (service.isActive(chat.id)) { await service.cancel(chat.id); throw Error('The live Work fixture exceeded five minutes.'); }
    const result = service.update(chat.id).conversation, last = result.messages.at(-1)!;
    const proof = { lifecycle: 'model-tools-final', mode: 'Pro Max Work', elapsedMs: Date.now() - start, status: last.status, taskStatus: last.workTask?.status, tools: result.tools.map(t => ({ name: t.name, status: t.status })), progress: last.workTask?.proProgress };
    await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/pro-work-live-proof.json', JSON.stringify(proof, null, 2)); console.log(JSON.stringify(proof));
    assert.equal(last.status, 'complete'); assert.equal(last.workTask?.status, 'completed');
    assert.equal(await readFile(join(history.generatedFilesRoot, chat.id, 'index.html'), 'utf8'), '<h1>Pro work verified</h1>');
    assert.ok(result.tools.some(t => t.name === 'read_file' && t.status === 'success'));
    console.log('PASS: ordinary Pro Work task through the shared worker.');
  } finally { await service.shutdown(); await broker.shutdown(); closeChatRuntime(); history.close(); }
}).then(() => app.exit(0)).catch(error => { console.error(error instanceof Error ? error.message : 'Pro verification failed.'); app.exit(1); });

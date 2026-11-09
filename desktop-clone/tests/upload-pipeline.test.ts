import { afterEach, expect, it, vi } from 'vitest';
import { HistoryStore } from '../src/main/history';
import { FileIngestion } from '../src/main/file-ingestion';
import { sourceManifest } from '../src/core/source-manifest';
import { importRemoteAttachment } from '../src/main/remote-attachments';
import { ModelResidency } from '../src/main/model-residency';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { defaultSettings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
import { randomUUID } from 'node:crypto';
import { invoiceImage } from './fixtures/document-fixtures';
const stores: HistoryStore[] = [], queues: FileIngestion[] = [];
afterEach(async () => { await Promise.all(queues.splice(0).map(queue => queue.close())); stores.splice(0).forEach(store => store.close()); });
function fixture(extract: ConstructorParameters<typeof FileIngestion>[1]) {
  const history = new HistoryStore(':memory:'); stores.push(history);
  const chat = history.createConversation(null), changed = vi.fn();
  const ingestion = new FileIngestion(history.sources, extract, changed); queues.push(ingestion);
  return { history, chat, ingestion, changed };
}
const signal = () => new AbortController().signal;
it('commits originals at attach, shows preparation on sent messages, then makes tail passages searchable without embedding', async () => {
  let finish!: (value: { text: string; status: 'ready' }) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const source = f.ingestion.upload(f.chat.id, 'report.pdf', Buffer.from('original PDF bytes'));
  expect(f.history.sources.originalFile(f.chat.id, source.id).bytes.toString()).toBe('original PDF bytes');
  const turn = f.history.startTurn(f.chat.id, 'Find the tail', 'local', [source.id]);
  expect(f.history.sources.messageSources(f.chat.id, turn.conversation.messages[0].id)[0].processing?.status).toBe('preparing');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); finish({ text: 'first section\n'.repeat(800) + 'NEBULA tail finding', status: 'ready' });
  await f.ingestion.wait([source.id], signal());
  expect(f.history.sources.search(f.chat.id, 'NEBULA')[0].text).toContain('tail finding');
  const detail = f.history.sources.detail(f.chat.id, source.id);
  expect(detail.processing?.status).toBe('ready');
  const manifest = sourceManifest([detail]); expect(manifest).toContain(source.id); expect(manifest).not.toContain('first section'); expect(manifest.length).toBeLessThan(1000);
  expect(f.history.outputs().find(row => row.sourceId === source.id)).toMatchObject({ origin: 'upload', processing: { status: 'ready' } });
});
it('cancels a Send wait without cancelling the shared ingestion or losing its original', async () => {
  let finish!: (value: { text: string; status: 'partial'; notice: string }) => void;
  const f = fixture(() => new Promise(resolve => { finish = resolve; })), source = f.ingestion.upload(f.chat.id, 'scan.pdf', Buffer.from('scan'));
  const cancel = new AbortController(), waiting = f.ingestion.wait([source.id], cancel.signal);
  cancel.abort(Error('stop waiting')); await expect(waiting).rejects.toThrow('stop waiting');
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); finish({ text: 'Readable page', status: 'partial', notice: 'Page 2 unreadable.' });
  await f.ingestion.wait([source.id], signal()); expect(f.history.sources.detail(f.chat.id, source.id).processing).toMatchObject({ status: 'partial', notice: 'Page 2 unreadable.' });
});
it('keeps failed originals and permits retry, without resurrecting deleted sources', async () => {
  const extract = vi.fn().mockRejectedValueOnce(Error('bad parser')).mockResolvedValue({ text: 'RECOVERED', status: 'ready' });
  const f = fixture(extract), source = f.ingestion.upload(f.chat.id, 'broken.docx', Buffer.from('bytes'));
  await f.ingestion.wait([source.id], signal()); expect(f.history.sources.fileStatus(source.id)?.status).toBe('failed');
  f.ingestion.retry(f.chat.id, source.id); await f.ingestion.wait([source.id], signal());
  expect(f.history.sources.detail(f.chat.id, source.id).text).toBe('RECOVERED');
  const removed = f.ingestion.upload(f.chat.id, 'removed.txt', Buffer.from('deleted')); f.history.sources.remove(f.chat.id, removed.id);
  await f.ingestion.wait([removed.id], signal()); expect(() => f.history.sources.detail(f.chat.id, removed.id)).toThrow();
});
it('survives chat deletion during extraction and continues processing other chats', async () => {
  let finish!: (value: { text: string; status: 'ready' }) => void;
  const extract = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ text: 'next document', status: 'ready' });
  const f = fixture(extract), source = f.ingestion.upload(f.chat.id, 'first.txt', Buffer.from('first'));
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); f.history.deleteConversation(f.chat.id); finish({ text: 'deleted document', status: 'ready' });
  await expect(f.ingestion.wait([source.id], signal())).resolves.toBeUndefined(); expect(f.changed).toHaveBeenCalledTimes(1);
  const next = f.history.createConversation(null), upload = f.ingestion.upload(next.id, 'next.txt', Buffer.from('next'));
  await f.ingestion.wait([upload.id], signal()); expect(f.history.sources.detail(next.id, upload.id).text).toBe('next document');
});
it('enforces the mobile draft limit before starting background ingestion', async () => {
  const f = fixture(async () => ({ text: 'ready', status: 'ready' }));
  for (let i = 0; i < 8; i++) f.ingestion.upload(f.chat.id, `${i}.txt`, Buffer.from('bytes'));
  await expect(importRemoteAttachment(f.history, () => {}, f.chat.id, 'ninth.txt', Buffer.from('bytes'))).rejects.toThrow('eight');
  expect(f.history.sources.list(f.chat.id, false)).toHaveLength(8);
});
it('bounds document reads, pins versions, reports extraction failure and enforces source scope/exclusion', async () => {
  const f = fixture(async () => ({ text: 'z'.repeat(12000), status: 'ready' }));
  const source = f.ingestion.upload(f.chat.id, 'long.txt', Buffer.from('bytes')); await f.ingestion.wait([source.id], signal());
  const settings = { ...defaultSettings, toolPermissions: { ...defaultSettings.toolPermissions, read: 'allow' as const } };
  const broker = new ToolBroker(f.history, () => settings, { partition: () => 'fixture' } as unknown as BrowserController, new ProjectFiles(f.history.sources), () => {});
  const read = async (input: object, conversationId = f.chat.id) => JSON.parse(await broker.execute({ conversationId, runId: randomUUID(), signal: signal() }, { id: randomUUID(), name: 'read_source', input }));
  const first = await read({ sourceId: source.id }); expect(first).toMatchObject({ sourceId: source.id }); expect(first.text).toHaveLength(4000); expect(first.nextOffset).toBe(4000);
  expect((await read({ sourceId: source.id, version: 'old' })).code).toBe('SOURCE_CHANGED');
  expect((await read({ sourceId: source.id }, f.history.createConversation(null).id)).error).toBeTruthy();
  f.history.sources.setExcluded(f.chat.id, source.id, true); expect((await read({ sourceId: source.id })).code).toBe('SOURCE_EXCLUDED');
  expect(f.history.sources.search(f.chat.id, 'zzzz')).toEqual([]); expect(f.history.sources.originalFile(f.chat.id, source.id).bytes.toString()).toBe('bytes');
  f.history.sources.setExcluded(f.chat.id, source.id, false); expect((await read({ sourceId: source.id, offset: 8000 })).text).toHaveLength(4000);
  f.history.sources.database.prepare("UPDATE source_files SET status='failed' WHERE source_id=?").run(source.id); expect((await read({ sourceId: source.id })).code).toBe('FILE_FAILED');
});
it('identifies OCR-derived image text and exposes a scoped visual-verification reference',async()=>{
  const f=fixture(async()=>({text:'Two uncertain columns',status:'partial',notice:'Verify column ownership visually.'}));
  const bytes=invoiceImage().toBuffer('image/png');
  const source=f.ingestion.upload(f.chat.id,'plans.png',bytes,{image:'data:image/png;base64,'+bytes.toString('base64'),mime:'image/png'});await f.ingestion.wait([source.id],signal());
  const settings={...defaultSettings,toolPermissions:{...defaultSettings.toolPermissions,read:'allow' as const}};
  const broker=new ToolBroker(f.history,()=>settings,{partition:()=> 'fixture'} as unknown as BrowserController,new ProjectFiles(f.history.sources),()=>{});
  const result=JSON.parse(await broker.execute({conversationId:f.chat.id,runId:randomUUID(),signal:signal()},{id:randomUUID(),name:'read_source',input:{sourceId:source.id}}));
  expect(result).toMatchObject({extraction:'ocr',imageReference:'tinygpt-image:'+source.id,visualVerification:{recommended:true},processing:{status:'partial'}});
  expect(result.visualVerification.guidance).toContain('view_image');
});
it('unloads idle models, protects active/mobile work, honors keep loaded, and waits for unload before reuse', async () => {
  let now = 0, busy = false, keepLoaded = false, release!: () => void;
  const unload = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
  const residency = new ModelResidency({ chat: { loaded: () => true, busy: () => busy, unload } }, () => ({ idleMinutes: 10, keepLoaded }), () => now);
  await residency.tick(); now = 600000; busy = true; await residency.tick(); expect(unload).not.toHaveBeenCalled();
  busy = false; now += 599999; await residency.tick(); expect(unload).not.toHaveBeenCalled();
  keepLoaded = true; now += 600001; await residency.tick(); expect(unload).not.toHaveBeenCalled();
  keepLoaded = false; now += 600000; const tick = residency.tick(); let ready = false; const wait = residency.ready('chat').then(() => { ready = true; });
  await Promise.resolve(); expect(ready).toBe(false); expect(unload).toHaveBeenCalledTimes(1); release(); await Promise.all([tick, wait]); expect(ready).toBe(true);
});

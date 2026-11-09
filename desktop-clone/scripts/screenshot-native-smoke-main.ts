import { app, BrowserWindow, nativeImage } from 'electron';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { BrowserController } from '../src/main/browser';
import { HistoryStore } from '../src/main/history';
import { ImageTools } from '../src/main/image-tools';
app.setPath('userData', process.env.TINYGPT_TOOLS_PROFILE!);
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-lcd-text');
app.whenReady().then(async () => {
  const server = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Native screenshot fixture</title><style>html{background:#155ac3}body{margin:0;height:3000px}h1{color:white}</style><h1>Real browser pixels</h1>'));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const history = new HistoryStore(':memory:'); const chat = history.createConversation(null);
  const owner = new BrowserWindow({ show: false, width: 1000, height: 800 });
  const browser = new BrowserController(() => {}, () => owner); const tools = new ImageTools(history, browser);
  const signal = () => new AbortController().signal;
  try {
    const url = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    const opened = await browser.open(chat.id, 'persist:screenshot-fixture', url, signal(), randomUUID());
    const capture = await tools.screenshot(chat.id, opened.tabId, signal());
    const viewed = await tools.view(chat.id, capture.imageReference, signal());
    const image = nativeImage.createFromDataURL(viewed.transport.image);
    assert.equal(image.isEmpty(), false); assert.ok(image.getSize().height < 3000, 'Capture stays within viewport');
    const bitmap = image.toBitmap(), offset = (100 * image.getSize().width + 100) * 4;
    assert.deepEqual([...bitmap.subarray(offset, offset + 4)], [195, 90, 21, 255], 'Capture includes actual page pixels');
    const contents = browser.contents(chat.id, opened.tabId), original = contents.capturePage.bind(contents);
    let captures = 0;
    contents.capturePage = async (...args) => { captures++; return original(...args); };
    const simultaneous = await Promise.all(Array.from({ length: 5 }, () => browser.capture(chat.id, opened.tabId)));
    assert.ok(simultaneous.every(data => data.startsWith('data:image/png;base64,'))); assert.equal(captures, 1, 'Preview and tool captures share one in-flight frame');
    // Park after presenting in the main pane, then capture the older of two tabs.
    browser.setLayout({ conversationId: chat.id, tabId: opened.tabId, bounds: { x: 20, y: 100, width: 700, height: 400 } });
    await browser.capture(chat.id, opened.tabId);
    browser.setLayout({ conversationId: chat.id, tabId: null, bounds: null });
    await browser.open(chat.id, 'persist:screenshot-fixture', url + '/second', signal(), randomUUID());
    await tools.screenshot(chat.id, opened.tabId, signal());
    // Deterministic transient failure also verifies the recovery and retry limit.
    let attempts = 0;
    contents.capturePage = async (...args) => { if (++attempts === 1) throw Error('Current display surface not available for capture'); return original(...args); };
    await browser.capture(chat.id, opened.tabId); assert.equal(attempts, 2);
    attempts = 0; contents.capturePage = async () => { attempts++; throw Error('UnknownVizError'); };
    await assert.rejects(browser.capture(chat.id, opened.tabId), /The browser could not capture this page/); assert.equal(attempts, 3);
    contents.capturePage = async () => new Promise(() => {});
    await assert.rejects(browser.capture(chat.id, opened.tabId), /The browser screenshot timed out/);
    contents.capturePage = original;
    await browser.capture(chat.id, opened.tabId);
    const other = history.createConversation(null);
    await assert.rejects(browser.capture(other.id, opened.tabId), /not available to the conversation/);
    assert.ok(BrowserWindow.getAllWindows().every(window => !window.isVisible()), 'Captures never show a window');
    assert.ok(history.conversation(chat.id).sources.every(source => source.kind === 'project-file'), 'Screenshots are saved references, not composer drafts');
    console.log(JSON.stringify({ checks: ['Normal Electron launch without debugger', 'Real page pixels and viewport dimensions', 'Reusable screenshot references', 'Coalesced preview/tool capture', 'Attached and parked views', 'Background tab capture', 'Surface recovery', 'Bounded failures and timeout recovery', 'Conversation ownership', 'No visible window'], errors: [] }));
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { history.close(); server.closeAllConnections(); server.close(); app.exit(Number(process.exitCode ?? 0)); }
});

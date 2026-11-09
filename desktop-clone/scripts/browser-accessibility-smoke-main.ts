import { app, BrowserWindow, ipcMain, webContents, session } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserController } from '../src/main/browser';
import { browserToolResult } from '../src/core/browser-snapshot';

// Isolated Electron host for the local accessibility fixture; never uses the user's profile.
const profile = process.env.TINYGPT_TOOLS_PROFILE!;
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
let browser: BrowserController;

app.whenReady().then(async () => {
  const main = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: join(__dirname, 'browser-accessibility-preload.cjs'),
      sandbox: true, contextIsolation: true, nodeIntegration: false,
    },
  });
  main.setPosition(-10000, -10000); main.showInactive();
  let reveals = 0;
  browser = new BrowserController(() => {}, () => main, () => {}, (conversationId, tabId) => {
    reveals++;
    browser.setLayout({ conversationId, tabId, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  });
  ipcMain.handle('fixture:operation', async (event, data) => {
    if (event.sender !== main.webContents || event.senderFrame !== main.webContents.mainFrame) {
      return { ok: false, error: 'Fixture only' };
    }
    try {
      const signal = new AbortController().signal;
      let value;
      switch (data.method) {
        case 'page': value = await browser.page(data.conversationId, 'persist:accessibility-fixture', data.url ?? data.origin + '/form', signal, data.runId); break;
        case 'open': value = await browser.open(data.conversationId, 'persist:accessibility-fixture', data.url ?? data.origin + '/form', signal, data.runId); break;
        case 'manual': value = browser.newWorkspaceTab(data.conversationId, 'persist:accessibility-fixture'); break;
        case 'reveal': browser.reveal(data.conversationId, data.tabId); value = true; break;
        case 'end': browser.endRun(data.runId); value = true; break;
        case 'close': browser.closeTab(data.conversationId, data.tabId); value = true; break;
        case 'navigate': value = await browser.navigateAgent(data.conversationId, data.tabId, data.url, signal); break;
        case 'scroll': value = await browser.scrollAgent(data.conversationId, data.tabId, data.direction ?? 'down', data.pixels ?? 600, signal); break;
        case 'hover': value = await browser.hover(data.conversationId, data.tabId, data.elementId, signal); break;
        case 'key': value = await browser.pressKey(data.conversationId, data.tabId, data.key, signal); break;
        case 'search': {
          session.fromPartition('persist:accessibility-fixture').webRequest.onBeforeRequest({ urls: ['https://duckduckgo.com/*'] }, (_details, callback) => callback({ redirectURL: data.origin + '/search' }));
          try { value = await browser.search(data.conversationId, 'persist:accessibility-fixture', 'duckduckgo', 'fixture', signal, data.runId); }
          finally { session.fromPartition('persist:accessibility-fixture').webRequest.onBeforeRequest(null); }
          break;
        }
        case 'count': value = webContents.getAllWebContents().filter(contents => contents.getURL().startsWith(data.origin)).length; break;
        case 'evaluate': value = await browser.contents(data.conversationId, data.tabId).executeJavaScript(data.code); break;
        case 'abort': { const controller = new AbortController(); controller.abort(); value = await browser.page(data.conversationId, 'persist:accessibility-fixture', data.origin + '/aborted', controller.signal, data.runId); break; }
        case 'read': value = await browser.snapshot(data.conversationId, data.tabId, signal, data.options); break;
        case 'describe': value = await browser.describe(data.conversationId, data.tabId, data.elementId); break;
        case 'click': value = await browser.click(data.conversationId, data.tabId, data.elementId, signal, data.expected); break;
        case 'type': value = await browser.type(data.conversationId, data.tabId, data.elementId, data.text, signal); break;
        case 'state': value = { state: browser.workspaceState(data.conversationId), reveals, attached: main.contentView.children.length }; break;
        case 'hide': browser.hideWindow(); value = true; break;
        case 'cursor': value = await browser.contents(data.conversationId, data.tabId).executeJavaScriptInIsolatedWorld(1001, [{code: '(()=>{const state=globalThis.__tinygptAgentCursor;return state ? {visible:state.cursor.style.opacity,position:state.cursor.style.transform,hidden:state.host.getAttribute("aria-hidden"),interactive:getComputedStyle(state.host).pointerEvents}:null})()'}]); break;
        case 'capture': writeFileSync(join(__dirname, 'browser-agent-cursor.png'), (await browser.contents(data.conversationId, data.tabId).capturePage()).toPNG()); value = true; break;
        case 'mutate': {
          const page = webContents.getAllWebContents().find(contents => contents.getURL().split('#')[0] === data.origin + '/form');
          if (!page) throw new Error('Local fixture page is missing');
          value = await page.executeJavaScript(data.code);
          break;
        }
        default: throw new Error('Unknown fixture operation');
      }
      return { ok: true, value: data.model ? JSON.parse(browserToolResult(JSON.stringify(value))) : value };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  });
  await main.loadURL('about:blank');
});
app.on('before-quit', () => browser?.shutdown());

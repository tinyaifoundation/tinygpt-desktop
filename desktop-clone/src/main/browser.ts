import { windowIcon } from './app-icon';
import { passwordPrivacy } from './password-privacy';
import { WAIT_EVIDENCE, type WithWaitEvidence } from '../core/wait-until';
import { app, BrowserWindow, Menu, session, shell, View, WebContentsView } from 'electron';
import type { BrowserProfiles } from './browser-profiles';
import type { BrowserPreferences } from '../shared/config';
import { browserLinkDestination } from '../core/browser-privacy';
import { browserCursor } from './browser-cursor';
import { agentCursorSvg } from '../core/agent-cursor';
import { browserPageChrome, browserPageScroll } from './browser-scroll';
import type { BrowserScroll } from '../shared/workspace';
import { basename, join } from 'node:path';
import type { BrowserLayout, BrowserState } from '../shared/workspace';
import { randomUUID } from 'node:crypto';
import { cleanSearchResults, pageDocument, resultDocument, searchAddress } from '../core/browser-pages';
import { accessibilityOutlineDetail, safeBrowserHref, axName, axProperty, axRole, interactiveAXNodes, type AXNode } from '../core/browser-accessibility';
import { BrowserActionError, browserPageError } from '../core/browser-errors';
import { pageUrlSchema, type BrowserHandoff, type PageSnapshot, type SearchEngine, type WebSearch } from '../shared/tools';
import { browserTargetPage, type BrowserSnapshotOptions } from '../core/browser-snapshot';
import { serveBrowserPreview } from './browser-preview';

interface Tab { partition: string; id: string; conversationId: string; view: WebContentsView; floating: BrowserWindow | null; manual: boolean; interactive: boolean; watched: boolean; runs: Set<string>; busy: number; favicon: string; error: string; touched: number; references: Map<string, BrowserReference>; nextReference: number; epoch: number; documentUrl: string; httpStatus?: number; cursor?: { x: number; y: number }; chromeCss?: string; installingChrome?: boolean; preview?: { workspace: string; path: string; url: string; close: () => Promise<void> } }
export interface BrowserTarget { url: string; label: string; role: string; type: string | null; backendNodeId: number; referenceId: string; name: string; href: string; tagName: string; disabled: boolean; readonly: boolean; editable: boolean }
interface BrowserReference extends BrowserTarget { axNodeId: string }
interface DOMNode { backendNodeId: number; nodeName: string; attributes?: string[] }
const staleTarget = () => new Error('The element changed. Read a new browser snapshot.');
function documentAddress(url: string): string { const address = new URL(url); address.hash = ''; return address.href; }
export const BROWSER_CAPTURE_UNAVAILABLE = 'The browser could not capture this page. Reload the tab and try again.';
export const BROWSER_CAPTURE_TIMEOUT = 'The browser screenshot timed out. Reload the tab and try again.';
export class BrowserController {
  private tabs = new Map<string, Tab>();
  private captures = new Map<string, Promise<string>>();
  private waiting = new Map<string, { handoff: BrowserHandoff; resolve: () => void; reject: (error: Error) => void }>();
  private configured = new Set<string>();
  private pool: BrowserWindow | null = null;
  private active = new Map<string, string>();
  private layout: BrowserLayout | null = null;
  private attached: Tab | null = null;
  private focusOnAttach?: string;
  private stopping = false;
  private roundedFrame: View | null = null;
  private frameOwner: BrowserWindow | null = null;
  private observedWindows = new WeakSet<BrowserWindow>();
  constructor(private changed: (conversationId: string) => void, private host: () => BrowserWindow | null = () => null, private workspaceChanged: (state: BrowserState) => void = () => {}, private focusWorkspace: (conversationId: string, tabId: string) => void = () => {}, private profiles?: BrowserProfiles, private preferences?: () => BrowserPreferences) {}
  handoffs(): BrowserHandoff[] { return [...this.waiting.values()].map(value => value.handoff); }
  tasks(): { conversationId: string; tabId: string; title: string; url: string }[] { return [...this.tabs.values()].filter(tab => tab.interactive && tab.runs.size && !this.waiting.has(tab.id) && !tab.view.webContents.isDestroyed()).map(tab => ({ conversationId: tab.conversationId, tabId: tab.id, title: tab.view.webContents.getTitle() || 'Browser', url: tab.view.webContents.getURL() })); }
  partition(projectId: string | null, isolated: boolean): string { return isolated && projectId ? `persist:tinygpt-browser-${projectId}` : 'persist:tinygpt-browser'; }
  listTabs(conversationId: string, partition: string, { offset = 0, limit = 12 }: { offset?: number; limit?: number } = {}) {
    const profile = session.fromPartition(partition);
    const listed = [...this.tabs.values()].filter(tab => tab.conversationId === conversationId && !tab.view.webContents.isDestroyed() && tab.view.webContents.session === profile).map(tab => ({
      tabId: tab.id, title: tab.view.webContents.getTitle().slice(0,200) || 'New tab', url: tab.view.webContents.getURL().slice(0,4096),
      loading: tab.view.webContents.isLoading(), active: this.active.get(conversationId) === tab.id, waitingForUser: this.waiting.has(tab.id),
    }));
    const tabs: typeof listed = [];
    for (const tab of listed.slice(offset,offset+limit)) { if (tabs.length && JSON.stringify([...tabs,tab]).length > 5200) break; tabs.push(tab); }
    return { tabs, total: listed.length, ...(offset+tabs.length < listed.length ? { nextOffset: offset+tabs.length } : {}), note: 'Use browser_snapshot with a returned tabId before acting, or browser_navigate to continue in it. Only this conversation’s current browser profile is listed. Follow nextOffset with browser_tabs to list more.' };
  }
  private create(conversationId: string, partition: string, manual = false, runId?: string): Tab {
    if (this.tabs.size >= 24) {
      const oldest = [...this.tabs.values()].filter(tab => !tab.manual && !tab.interactive && !tab.watched && !tab.busy && !tab.view.webContents.isLoading() && !this.waiting.has(tab.id) && tab !== this.attached && !tab.floating?.isVisible()).sort((a, b) => a.touched - b.touched)[0];
      if (!oldest) throw new Error('Close a browser window before opening another page.');
      this.destroyTab(oldest);
    }
    const browserSession = session.fromPartition(partition);
    if (!this.configured.has(partition)) {
      this.profiles?.configure(partition);
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      browserSession.setPermissionCheckHandler(() => false);
      browserSession.on('will-download', (event, item, contents) => {
        const tab = [...this.tabs.values()].find(tab => tab.view.webContents === contents);
        if (!tab || (tab !== this.attached && !tab.floating?.isVisible())) { event.preventDefault(); return; }
        item.setSaveDialogOptions({ title: 'Save browser download', defaultPath: join(app.getPath('downloads'), basename(item.getFilename())) });
      }); this.configured.add(partition);
    }
    const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false } });
    view.setBackgroundColor('#00000000');
    const tab: Tab = { partition, id: randomUUID(), conversationId, view, floating: null, manual, interactive: false, watched: manual, runs: new Set(runId ? [runId] : []), busy: 0, favicon: '', error: '', touched: Date.now(), references: new Map(), nextReference: 0, epoch: 0, documentUrl: 'about:blank' }; this.tabs.set(tab.id, tab);
    this.park(tab);
    view.webContents.on('did-start-navigation', details => {
      if (!details.isMainFrame) return;
      if (!details.isSameDocument) tab.chromeCss = undefined;
      tab.error = '';
      // Scrollspy/anchor changes keep the same document and backend nodes. A
      // reload or SPA route/query change must still invalidate every reference.
      if (!details.isSameDocument || documentAddress(details.url) !== documentAddress(tab.documentUrl)) { tab.references.clear(); tab.epoch++; }
      tab.documentUrl = details.url;
    });
    view.webContents.debugger.on('detach', () => { tab.references.clear(); tab.epoch++; });
    view.webContents.setWindowOpenHandler(details => {
      // User popups become owned tabs, never a privileged renderer window.
      if (details.disposition !== 'other' && (tab === this.attached || tab.floating?.isVisible()) && pageUrlSchema.safeParse(details.url).success) {
        if (this.preferences && browserLinkDestination(details.url, this.preferences()) === 'system') { void shell.openExternal(details.url).catch(() => {}); return { action: 'deny' }; }
        const child = this.create(conversationId, partition, true); this.activate(conversationId, child.id); void child.view.webContents.loadURL(details.url).catch(() => {});
      }
      return { action: 'deny' };
    });
    view.webContents.on('will-navigate', (event, url) => { if (!pageUrlSchema.safeParse(url).success) event.preventDefault(); });
    view.webContents.on('will-redirect', (event, url) => { if (!pageUrlSchema.safeParse(url).success) event.preventDefault(); });
    const notify = () => { if (!this.stopping) { if (tab === this.attached) void this.installChrome(tab); this.workspaceChanged(this.workspaceState(conversationId)); } };
    view.webContents.on('dom-ready', () => { if (tab === this.attached) void this.installChrome(tab); });
    view.webContents.on('did-start-loading', notify); view.webContents.on('did-stop-loading', notify);
    view.webContents.on('did-navigate', notify); view.webContents.on('did-navigate-in-page', notify); view.webContents.on('page-title-updated', notify);
    view.webContents.on('did-navigate', (_event, url, status) => { tab.httpStatus = status; if (!this.stopping) this.profiles?.record(partition, url, view.webContents.getTitle()); });
    view.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (!this.stopping && isMainFrame) this.profiles?.record(partition, url, view.webContents.getTitle()); });
    view.webContents.on('page-title-updated', (_event, title) => { if (!this.stopping) this.profiles?.title(partition, view.webContents.getURL(), title); });
    view.webContents.on('page-favicon-updated', (_event, urls) => { tab.favicon = urls.find(url => pageUrlSchema.safeParse(url).success) ?? ''; notify(); });
    view.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) { tab.error = 'This page could not be loaded. Check the address and connection.'; notify(); } });
    view.webContents.on('destroyed', () => { void tab.preview?.close().catch(() => {}); this.waiting.get(tab.id)?.reject(new Error('The browser window was closed.')); this.waiting.delete(tab.id); this.tabs.delete(tab.id); if (this.active.get(conversationId) === tab.id) this.active.delete(conversationId); if (!this.stopping) this.changed(conversationId); notify(); });
    notify();
    return tab;
  }
  private park(tab: Tab): void {
    if (!this.pool || this.pool.isDestroyed()) { this.pool = new BrowserWindow({ show: false, width: 1100, height: 780, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }); this.pool.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); }
    const previous = tab.view.getBounds(); this.pool.contentView.addChildView(tab.view); tab.view.setBorderRadius(0); tab.view.setBounds({ x: 0, y: 0, width: previous.width || 1100, height: previous.height || 780 });
    this.activity(tab);
  }
  private activity(tab: Tab): void {
    if (tab.view.webContents.isDestroyed()) return;
    const owner = this.host();
    const awake = tab === this.attached && !!owner && !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized() || !!tab.floating && !tab.floating.isDestroyed() && tab.floating.isVisible() && !tab.floating.isMinimized() || tab.runs.size > 0 || tab.busy > 0 || this.waiting.has(tab.id) || tab.view.webContents.isLoading();
    tab.view.setVisible(awake); tab.view.webContents.setBackgroundThrottling(!awake);
  }
  private observeWindow(window: BrowserWindow) {
    if (this.observedWindows.has(window)) return; this.observedWindows.add(window);
    const refresh = () => { for (const tab of this.tabs.values()) this.activity(tab); };
    window.on('minimize', refresh); window.on('restore', refresh); window.on('hide', refresh); window.on('show', refresh);
  }
  private detach(): void {
    if (this.roundedFrame) { this.roundedFrame.setVisible(false); if (this.frameOwner && !this.frameOwner.isDestroyed()) this.frameOwner.contentView.removeChildView(this.roundedFrame); this.frameOwner = null; }
    if (this.attached) { const tab = this.attached; this.attached = null; if (!tab.view.webContents.isDestroyed() && !tab.floating?.isVisible()) this.park(tab); }
  }
  private destroyTab(tab: Tab): void { if (tab === this.attached) this.detach(); tab.view.webContents.close(); if (tab.floating && !tab.floating.isDestroyed()) tab.floating.destroy(); }
  workspaceState(conversationId: string): BrowserState { return { conversationId, activeId: this.active.get(conversationId) ?? null, tabs: [...this.tabs.values()].filter(tab => tab.conversationId === conversationId && (tab.manual || tab.interactive || tab.watched) && !tab.view.webContents.isDestroyed()).map(tab => { const contents = tab.view.webContents; return { id: tab.id, title: contents.getTitle() || 'New tab', url: contents.getURL() === 'about:blank' ? '' : contents.getURL(), favicon: tab.favicon, loading: contents.isLoading(), error: tab.error, canGoBack: contents.navigationHistory.canGoBack(), canGoForward: contents.navigationHistory.canGoForward(), zoom: Math.round(contents.getZoomFactor() * 100), tool: !tab.manual }; }) }; }
  newWorkspaceTab(conversationId: string, partition: string): string { const tab = this.create(conversationId, partition, true); this.activate(conversationId, tab.id); return tab.id; }
  activate(conversationId: string, tabId: string, userInitiated = true): void { const tab = this.owned(conversationId, tabId); if (userInitiated) tab.watched = true; this.active.set(conversationId, tabId); this.workspaceChanged(this.workspaceState(conversationId)); }
  closeTab(conversationId: string, tabId: string): void { const tab = this.owned(conversationId, tabId); const remaining = [...this.tabs.values()].filter(item => item.conversationId === conversationId && item.id !== tabId && (item.manual || item.interactive || item.watched) && !item.view.webContents.isDestroyed()); if (this.active.get(conversationId) === tabId) { this.active.delete(conversationId); if (remaining.length) this.active.set(conversationId, remaining.at(-1)!.id); } this.destroyTab(tab); this.workspaceChanged(this.workspaceState(conversationId)); }
  contents(conversationId: string, tabId: string): Electron.WebContents { passwordPrivacy.assert(); return this.owned(conversationId, tabId).view.webContents; }
  passwordContext(conversationId: string, tabId: string): { url: string; partition: string } {
    const contents = this.contents(conversationId,tabId);
    if (contents.isLoadingMainFrame()) throw Error('Wait for this page to finish loading before opening passwords.');
    return {url:contents.getURL(),partition:this.owned(conversationId,tabId).partition};
  }
  async navigateWorkspace(conversationId: string, tabId: string, url: string): Promise<void> { pageUrlSchema.parse(url); const tab = this.owned(conversationId, tabId); tab.error = ''; tab.busy++; this.activity(tab); try { await tab.view.webContents.loadURL(url).catch(error => { if ((error as { errno?: number }).errno !== -3) throw new Error('The page did not load. Check internet access and try again.'); }); } finally { tab.busy--; this.activity(tab); } }
  setLayout(layout: BrowserLayout, sender?: BrowserWindow): void {
    const owner = this.host();
    // Late cleanup from a former chat/window must not detach the current page.
    if (sender && sender !== owner || !layout.tabId && this.layout && this.layout.conversationId !== layout.conversationId) return;
    this.layout = layout;
    if (!owner || owner.isDestroyed() || !layout.tabId || !layout.bounds) { this.detach(); return; }
    this.observeWindow(owner);
    const tab = this.owned(layout.conversationId, layout.tabId); if (tab.floating?.isVisible()) { this.detach(); return; }
    const zoom = owner.webContents.getZoomFactor(); const [width, height] = owner.getContentSize(); const x = Math.max(0, Math.round(layout.bounds.x * zoom)); const y = Math.max(42, Math.round(layout.bounds.y * zoom));
    const bounds = { x, y, width: Math.max(0, Math.min(Math.round(layout.bounds.width * zoom), width - x - 1)), height: Math.max(0, Math.min(Math.round(layout.bounds.height * zoom), height - y - 1)) };
    if (bounds.width < 1 || bounds.height < 1) { this.detach(); return; }
    const switching = this.attached !== tab || this.frameOwner !== owner;
    if (switching) this.detach();
    // Extend the clipping frame upward behind the toolbar. Its rounded top
    // corners sit above the page, leaving only the page's bottom corners curved.
    const radius = Math.round((layout.cornerRadius ?? 13) * zoom); this.roundedFrame ??= new View();
    this.roundedFrame.setBorderRadius(radius); this.roundedFrame.setBackgroundColor('#00000000');
    // Include the scrollbar gutter in the clipping outline. The page itself
    // keeps its viewport width, while both bottom corners follow the pane.
    const clipWidth = Math.min(width - x - 1, bounds.width + Math.round((layout.rightInset ?? 0) * zoom));
    this.roundedFrame.setBounds({ ...bounds, width: clipWidth, y: bounds.y - radius, height: bounds.height + radius });
    // Resize an attached native page in place. Reparenting on each pointer move
    // disrupts input/compositor state and needlessly changes its viewport twice.
    if (!owner.contentView.children.includes(this.roundedFrame)) owner.contentView.addChildView(this.roundedFrame);
    this.frameOwner = owner;
    if (!this.roundedFrame.children.includes(tab.view)) this.roundedFrame.addChildView(tab.view);
    tab.view.setBorderRadius(0); tab.view.setBounds({ x: 0, y: radius, width: bounds.width, height: bounds.height });
    this.roundedFrame.setVisible(true); this.attached = tab; this.activity(tab);
    if (switching) tab.view.webContents.invalidate();
    if (this.focusOnAttach === tab.id) { this.focusOnAttach = undefined; tab.view.webContents.focus(); }
    void this.installChrome(tab);
  }
  private async installChrome(tab: Tab): Promise<void> {
    if (tab.chromeCss || tab.installingChrome || tab.view.webContents.isDestroyed() || tab.view.webContents.isLoadingMainFrame()) return;
    tab.installingChrome = true;
    const epoch = tab.epoch;
    try { const key = await tab.view.webContents.insertCSS(browserPageChrome, { cssOrigin: 'user' }); if (tab.epoch === epoch) tab.chromeCss = key; } catch { /* Navigation can replace this document. */ }
    finally { tab.installingChrome = false; }
  }
  async scroll(conversationId: string, tabId: string, position?: number): Promise<BrowserScroll> {
    const tab = this.owned(conversationId, tabId);
    return this.evaluate(tab, `(${browserPageScroll.toString()})(${position === undefined ? 'undefined' : position})`);
  }
  async capture(conversationId: string, tabId: string, preview = false): Promise<string> {
    passwordPrivacy.assert();
    const tab = this.owned(conversationId, tabId);
    const key = preview ? `${tabId}:preview` : tabId;
    const pending = this.captures.get(key); if (pending) return pending;
    // The live preview and image tool can request the same hidden frame together.
    tab.busy++; this.activity(tab);
    const capture = this.captureFrame(tab, preview); this.captures.set(key, capture);
    try { return await capture; } finally { tab.busy--; this.activity(tab); if (this.captures.get(key) === capture) this.captures.delete(key); }
  }
  private async captureFrame(tab: Tab, preview = false): Promise<string> {
    const privacyEpoch = passwordPrivacy.epoch; passwordPrivacy.assert(privacyEpoch);
    for (let attempt = 0; attempt < 3; attempt++) {
      const contents = this.contents(tab.conversationId, tab.id);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const image = await Promise.race([
          contents.capturePage(undefined, { stayHidden: true }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(BROWSER_CAPTURE_TIMEOUT)), 6000); }),
        ]);
        passwordPrivacy.assert(privacyEpoch);
        if (image.isEmpty()) throw new Error(BROWSER_CAPTURE_UNAVAILABLE);
        return preview ? 'data:image/jpeg;base64,' + image.resize({ width: Math.min(640, image.getSize().width) }).toJPEG(65).toString('base64') : image.toDataURL();
      } catch (error) {
        if (contents.isDestroyed()) throw new Error('This browser tab is not available to the conversation.');
        const message = error instanceof Error ? error.message : '';
        if (message === BROWSER_CAPTURE_TIMEOUT) throw error;
        if (!['Current display surface not available for capture', 'UnknownVizError', BROWSER_CAPTURE_UNAVAILABLE].includes(message) || attempt === 2) throw new Error(BROWSER_CAPTURE_UNAVAILABLE);
        // A hidden WebContentsView can have no compositor surface despite a live
        // document. Reapply its painting state, then allow the first frame to land.
        // This keeps the window hidden and preserves its size, zoom, and focus.
        const throttled = contents.getBackgroundThrottling();
        contents.setBackgroundThrottling(!throttled); contents.setBackgroundThrottling(throttled);
        contents.invalidate();
        await new Promise(resolve => setTimeout(resolve, 100 * (attempt + 1)));
      } finally { clearTimeout(timer); }
    }
    throw new Error(BROWSER_CAPTURE_UNAVAILABLE);
  }
  private showFloating(tab: Tab): void {
    if (tab.chromeCss) { void tab.view.webContents.removeInsertedCSS(tab.chromeCss).catch(() => {}); tab.chromeCss = undefined; }
    if (!tab.floating || tab.floating.isDestroyed()) { const floating = new BrowserWindow({ show: false, width: 1100, height: 780, title: 'TinyGPT Browser', icon: windowIcon, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } }); tab.floating = floating; floating.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); floating.setMenu(Menu.buildFromTemplate([{ label: 'TinyGPT task', submenu: [{ label: 'Resume task after login or consent', click: () => { if (this.waiting.has(tab.id)) this.resume(tab.id); } }, { label: 'Hide browser', click: () => { floating.hide(); this.park(tab); } }] }])); floating.on('resize', () => { if (!tab.view.webContents.isDestroyed()) { const [width, height] = floating.getContentSize(); tab.view.setBounds({ x: 0, y: 0, width, height }); } }); floating.on('close', event => { event.preventDefault(); floating.hide(); this.park(tab); }); }
    if (this.attached === tab) this.detach(); this.observeWindow(tab.floating); tab.floating.contentView.addChildView(tab.view); const [width, height] = tab.floating.getContentSize(); tab.view.setBounds({ x: 0, y: 0, width, height }); tab.floating.show(); tab.floating.focus(); this.activity(tab);
  }
  private owned(conversationId: string, id: string): Tab {
    const tab = this.tabs.get(id); if (!tab || tab.conversationId !== conversationId || tab.view.webContents.isDestroyed()) throw new Error('This browser tab is not available to the conversation.');
    tab.touched = Date.now(); return tab;
  }
  private async evaluate<T>(tab: Tab, expression: string): Promise<T> { const epoch = passwordPrivacy.epoch; passwordPrivacy.assert(epoch); const result = await tab.view.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: expression }]) as T; passwordPrivacy.assert(epoch); return result; }
  private async cdp<T>(tab: Tab, method: string, params?: Record<string, unknown>): Promise<T> {
    const debuggerTransport = tab.view.webContents.debugger;
    if (!debuggerTransport.isAttached()) { debuggerTransport.attach('1.3'); await this.command(tab, 'Accessibility.enable'); }
    return this.command(tab, method, params);
  }
  private async command<T>(tab: Tab, method: string, params?: Record<string, unknown>): Promise<T> {
    const epoch = passwordPrivacy.epoch; passwordPrivacy.assert(epoch);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([tab.view.webContents.debugger.sendCommand(method, params) as Promise<T>, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { if (!tab.view.webContents.isDestroyed() && tab.view.webContents.debugger.isAttached()) tab.view.webContents.debugger.detach(); reject(new Error('The browser did not respond. Read a new browser snapshot.')); }, 10000); })]);
      passwordPrivacy.assert(epoch); return result;
    } finally { clearTimeout(timer); }
  }
  private async reference(tab: Tab, node: AXNode, id: string): Promise<BrowserReference> {
    const { node: dom } = await this.cdp<{ node: DOMNode }>(tab, 'DOM.describeNode', { backendNodeId: node.backendDOMNodeId });
    const attrs = new Map<string, string>(); for (let index = 0; index < (dom.attributes?.length ?? 0); index += 2) attrs.set(dom.attributes![index], dom.attributes![index + 1]);
    const type = dom.nodeName === 'INPUT' ? (attrs.get('type') ?? 'text').toLowerCase() : null;
    return { referenceId: id, axNodeId: node.nodeId, backendNodeId: dom.backendNodeId, url: tab.view.webContents.getURL(), role: axRole(node), label: axName(node), type, name: attrs.get('name') ?? '', href: attrs.get('href') ?? '', tagName: dom.nodeName, disabled: axProperty(node, 'disabled') === true || attrs.has('disabled'), readonly: axProperty(node, 'readonly') === true || attrs.has('readonly'), editable: dom.nodeName === 'TEXTAREA' || dom.nodeName === 'INPUT' && ['text', 'search', 'url', 'email', 'tel', 'number'].includes(type ?? '') || attrs.has('contenteditable') && attrs.get('contenteditable') !== 'false' };
  }
  private sameTarget(left: BrowserTarget, right: BrowserTarget): boolean {
    return left.backendNodeId === right.backendNodeId && left.referenceId === right.referenceId && documentAddress(left.url) === documentAddress(right.url) && left.role === right.role && left.label === right.label && left.type === right.type && left.name === right.name && left.href === right.href && left.tagName === right.tagName && left.disabled === right.disabled && left.readonly === right.readonly && left.editable === right.editable;
  }
  private async accessibility(tab: Tab, signal: AbortSignal, options: BrowserSnapshotOptions, dialogVisible = false): Promise<Pick<PageSnapshot, 'elements' | 'accessibility' | 'accessibilityCoverage' | 'snapshotKind' | 'targets'> & WithWaitEvidence> {
    const epoch = tab.epoch;
    const { nodes } = await this.cdp<{ nodes: AXNode[] }>(tab, 'Accessibility.getFullAXTree');
    signal.throwIfAborted();
    const old = new Map([...tab.references.values()].map(reference => [reference.backendNodeId, reference]));
    const selection = browserTargetPage(nodes, options, dialogVisible);
    const candidates = await Promise.all(selection.nodes.map(async node => {
      try {
        const prior = old.get(node.backendDOMNodeId!); const candidate = await this.reference(tab, node, prior?.referenceId ?? `t${tab.nextReference++}`);
        if (prior && !this.sameTarget(prior, candidate)) candidate.referenceId = `t${tab.nextReference++}`;
        return candidate;
      } catch { return null; } // A node removed during a read is absent from this snapshot.
    }));
    signal.throwIfAborted(); if (epoch !== tab.epoch) throw staleTarget();
    const current = candidates.filter((reference): reference is BrowserReference => reference !== null);
    // Retain other pages' references while the document lives. describe() still
    // revalidates identity, labels and states immediately before every action.
    const live = new Set(interactiveAXNodes(nodes).map(node => node.backendDOMNodeId));
    for (const [id, reference] of tab.references) if (!live.has(reference.backendNodeId) || selection.nodes.some(node => node.backendDOMNodeId === reference.backendNodeId)) tab.references.delete(id);
    for (const reference of current) tab.references.set(reference.referenceId, reference);
    const byId = new Map(nodes.map(node => [node.nodeId, node]));
    const outline = accessibilityOutlineDetail(nodes, new Map(current.map(reference => [reference.axNodeId, reference.referenceId])));
    return { snapshotKind: 'accessibility', targets: selection.targets, elements: current.map(reference => ({ id: reference.referenceId, role: reference.role, label: reference.label.slice(0, 160), ...(reference.role === 'link' && safeBrowserHref(reference.href, reference.url) ? { href: safeBrowserHref(reference.href, reference.url) } : {}), ...(selection.dialog ? { inActiveDialog: selection.dialog.descendants.has(reference.axNodeId) } : {}), ...(reference.disabled ? { disabled: true } : {}), ...(reference.readonly ? { readonly: true } : {}), ...Object.fromEntries(['selected', 'expanded', 'checked'].flatMap(key => { const value = axProperty(byId.get(reference.axNodeId)!, key); return value === undefined ? [] : [[key, value]]; })) })), accessibility: outline.text, accessibilityCoverage: outline.coverage, [WAIT_EVIDENCE]: { texts: nodes.filter(node => !node.ignored && axRole(node) !== 'RootWebArea').map(axName), complete: nodes.length > 0 && !nodes.some(node => axProperty(node, 'busy') === true) } };
  }
  private async navigate(tab: Tab, url: string, signal: AbortSignal): Promise<void> {
    pageUrlSchema.parse(url); signal.throwIfAborted();
    const abort = () => tab.view.webContents.stop(); signal.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([tab.view.webContents.loadURL(url), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { tab.view.webContents.stop(); reject(new Error('The page did not load. Check internet access and try again.')); }, 30000); })]);
      signal.throwIfAborted();
      await new Promise(resolve => setTimeout(resolve, 450)); signal.throwIfAborted();
    } catch { if (signal.aborted) throw new Error('Cancelled.'); throw new Error('The page did not load. Check internet access and try again.'); }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  private async handoff(tab: Tab, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      let finished = false; let checking = false;
      const done = (error?: Error) => { if (finished) return; finished = true; clearInterval(poll); signal.removeEventListener('abort', abort); this.waiting.delete(tab.id); if (!this.stopping) this.changed(tab.conversationId); if (tab.floating && !tab.floating.isDestroyed()) { tab.floating.hide(); this.park(tab); } if (error) reject(error); else resolve(); };
      const abort = () => done(new Error('Cancelled.'));
      // Verification can clear automatically or after the user's interaction.
      // Poll only this same tab; never retry an action or change its identity.
      const poll = setInterval(() => {
        if (finished || checking || tab.view.webContents.isDestroyed() || tab.view.webContents.isLoading()) return;
        checking = true;
        void this.evaluate<Omit<PageSnapshot, 'tabId'>>(tab, `(${pageDocument.toString()})()`).then(page => { if (!page.challenge) done(); }).catch(() => {}).finally(() => { checking = false; });
      }, 1000);
      this.waiting.set(tab.id, { handoff: { tabId: tab.id, conversationId: tab.conversationId, url: tab.view.webContents.getURL(), reason: 'Complete login, consent, or verification in this browser window, then resume.' }, resolve: () => done(), reject: error => done(error) });
      signal.addEventListener('abort', abort, { once: true }); this.changed(tab.conversationId);
    });
  }
  async snapshot(conversationId: string, tabId: string, signal: AbortSignal, options: BrowserSnapshotOptions = {}): Promise<PageSnapshot> {
    const tab = this.owned(conversationId, tabId); tab.busy++; this.activity(tab);
    try {
    for (let attempt = 0; ; attempt++) {
      try { return await this.snapshotAttempt(conversationId, tabId, signal, options); }
      catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof Error) || error.message !== staleTarget().message || attempt >= 2) throw error;
        // Repeat only the read when navigation races a snapshot, never an action.
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    } finally { tab.busy--; this.activity(tab); }
  }
  private async snapshotAttempt(conversationId: string, tabId: string, signal: AbortSignal, options: BrowserSnapshotOptions): Promise<PageSnapshot> {
    const tab = this.owned(conversationId, tabId); signal.throwIfAborted();
    let epoch = tab.epoch;
    let page = await this.evaluate<Omit<PageSnapshot, 'tabId'>>(tab, `(${pageDocument.toString()})()`);
    if (page.challenge) { await this.handoff(tab, signal); epoch = tab.epoch; page = await this.evaluate(tab, `(${pageDocument.toString()})()`); }
    if (epoch !== tab.epoch || documentAddress(page.url) !== documentAddress(tab.view.webContents.getURL())) throw staleTarget();
    signal.throwIfAborted(); const accessibility = await this.accessibility(tab, signal, options, !!page.activeDialog);
    signal.throwIfAborted(); if (epoch !== tab.epoch || documentAddress(page.url) !== documentAddress(tab.view.webContents.getURL())) throw staleTarget();
    return { ...page, url: tab.view.webContents.getURL(), ...accessibility, tabId, ...(tab.httpStatus ? { httpStatus: tab.httpStatus, ...(browserPageError(tab.httpStatus) ? { pageError: browserPageError(tab.httpStatus) } : {}) } : {}) };
  }
  async page(conversationId: string, partition: string, url: string, signal: AbortSignal, runId?: string): Promise<PageSnapshot> {
    pageUrlSchema.parse(url); signal.throwIfAborted();
    const existing = [...this.tabs.values()].find(tab => tab.conversationId === conversationId && !tab.view.webContents.isDestroyed() && !tab.view.webContents.isLoading() && tab.view.webContents.session === session.fromPartition(partition) && tab.view.webContents.getURL() === new URL(url).href);
    if (existing) { if (runId) existing.runs.add(runId); return this.snapshot(conversationId, existing.id, signal); }
    const tab = this.create(conversationId, partition, false, runId); tab.busy++;
    try { await this.navigate(tab, url, signal); return await this.snapshot(conversationId, tab.id, signal); }
    catch (error) { if (!tab.view.webContents.isDestroyed()) this.destroyTab(tab); throw error; }
    finally { tab.busy--; }
  }
  prepareInteraction(conversationId: string, tabId: string, runId?: string, interactive = true): void {
    const tab = this.owned(conversationId, tabId); if (runId) tab.runs.add(runId);
    this.activity(tab);
    if (interactive) this.followAgent(tab);
  }
  async open(conversationId: string, partition: string, url: string, signal: AbortSignal, runId?: string): Promise<PageSnapshot> {
    const page = await this.page(conversationId, partition, url, signal, runId);
    this.prepareInteraction(conversationId, page.tabId, runId); return page;
  }
  async preview(conversationId: string, partition: string, workspace: string, path: string, signal: AbortSignal, runId?: string, checkAccess: () => void = () => {}): Promise<PageSnapshot> {
    checkAccess(); signal.throwIfAborted();
    const existing = [...this.tabs.values()].find(tab => tab.conversationId === conversationId && tab.preview?.workspace === workspace && tab.preview.path === path && !tab.view.webContents.isDestroyed());
    if (existing) {
      this.prepareInteraction(conversationId, existing.id, runId);
      return this.navigateAgent(conversationId, existing.id, existing.preview!.url, signal, true);
    }
    const server = await serveBrowserPreview(workspace, path, checkAccess);
    let tab: Tab | undefined;
    try {
      signal.throwIfAborted();
      tab = this.create(conversationId, partition, false, runId);
      tab.preview = { workspace, path, ...server };
      await this.navigate(tab, server.url, signal);
      this.prepareInteraction(conversationId, tab.id, runId);
      return await this.snapshot(conversationId, tab.id, signal);
    } catch (error) { if (tab) this.destroyTab(tab); await server.close(); throw error; }
  }
  private followAgent(tab: Tab): void {
    const first = !tab.interactive; tab.interactive = true;
    // Update the tab selection only while the user is watching. Research never
    // reaches this path, and agent actions never open a closed workspace.
    if (this.attached?.conversationId === tab.conversationId) this.activate(tab.conversationId, tab.id, false);
    else this.workspaceChanged(this.workspaceState(tab.conversationId));
    if (first) this.changed(tab.conversationId);
  }
  private async moveCursor(tab: Tab, point: { x: number; y: number }, signal: AbortSignal): Promise<void> {
    this.followAgent(tab);
    const owner = this.host();
    // Chromium can defer synthetic mouse-move acknowledgements until a frame
    // paints. Never make background browser work wait on an invisible viewport.
    if (this.attached !== tab || !owner?.isVisible() || owner.isMinimized()) { tab.cursor = point; await this.paintCursor(tab, point).catch(() => {}); return; }
    const start = tab.cursor ?? { x: 24, y: 24 };
    await this.paintCursor(tab, start);
    // Move Chromium's actual pointer along the same path as the visual cursor.
    // This also gives page hover handlers genuine mouse movement events.
    await this.paintCursor(tab, point);
    for (let step = 1; step <= 6; step++) {
      signal.throwIfAborted();
      const progress = step / 6;
      const easing = 1 - Math.pow(1 - progress, 3);
      await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x + (point.x - start.x) * easing, y: start.y + (point.y - start.y) * easing });
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    tab.cursor = point; signal.throwIfAborted();
  }
  private async paintCursor(tab: Tab, point: { x: number; y: number }, pressed = false): Promise<void> {
    await this.evaluate(tab, `(${browserCursor.toString()})(${point.x},${point.y},${pressed},${JSON.stringify(agentCursorSvg)})`);
  }
  async search(conversationId: string, partition: string, engine: SearchEngine, query: string, signal: AbortSignal, runId?: string): Promise<WebSearch> {
    const tab = this.create(conversationId, partition, false, runId); tab.busy++;
    try {
      await this.navigate(tab, searchAddress(engine, query), signal);
      const page = await this.evaluate<Omit<PageSnapshot, 'tabId'>>(tab, `(${pageDocument.toString()})()`);
      if (page.challenge) await this.handoff(tab, signal);
      signal.throwIfAborted();
      const results = cleanSearchResults(engine, await this.evaluate(tab, `(${resultDocument.toString()})(${JSON.stringify(engine)})`));
      signal.throwIfAborted(); return { engine, query, results };
    } finally { tab.busy--; if (!tab.watched && !tab.manual && !tab.view.webContents.isDestroyed()) this.destroyTab(tab); }
  }
  async describe(conversationId: string, tabId: string, elementId: string): Promise<BrowserTarget> {
    const tab = this.owned(conversationId, tabId); const previous = tab.references.get(elementId);
    if (!previous || documentAddress(previous.url) !== documentAddress(tab.view.webContents.getURL())) throw staleTarget();
    try {
      const { nodes } = await this.cdp<{ nodes: AXNode[] }>(tab, 'Accessibility.getPartialAXTree', { backendNodeId: previous.backendNodeId, fetchRelatives: false });
      const node = nodes.find(node => node.backendDOMNodeId === previous.backendNodeId && !node.ignored);
      if (!node) throw staleTarget();
      const current = await this.reference(tab, node, elementId);
      if (!this.sameTarget(previous, current) || tab.references.get(elementId) !== previous) throw staleTarget();
      return current;
    } catch { throw staleTarget(); }
  }
  private async verifyTarget(conversationId: string, tabId: string, elementId: string, expected?: BrowserTarget): Promise<void> {
    if (!expected) return;
    const current = await this.describe(conversationId, tabId, elementId);
    if (!this.sameTarget(current, expected)) throw staleTarget();
  }
  private async inspectNode<T>(tab: Tab, target: BrowserTarget, functionDeclaration: string, args: unknown[] = []): Promise<T> {
    const group = `tinygpt-action-${randomUUID()}`;
    try {
      const { object } = await this.cdp<{ object: { objectId?: string } }>(tab, 'DOM.resolveNode', { backendNodeId: target.backendNodeId, objectGroup: group });
      if (!object.objectId) throw staleTarget();
      const result = await this.cdp<{ result: { value: T }; exceptionDetails?: unknown }>(tab, 'Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true });
      if (result.exceptionDetails) throw staleTarget();
      return result.result.value;
    } catch { throw staleTarget(); }
    finally { await this.cdp(tab, 'Runtime.releaseObjectGroup', { objectGroup: group }).catch(() => undefined); }
  }
  private async point(tab: Tab, target: BrowserTarget): Promise<{ x: number; y: number }> {
    let covered = false, blockingDialog: string | undefined;
    try {
      await this.cdp(tab, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: target.backendNodeId });
      const { quads } = await this.cdp<{ quads: number[][] }>(tab, 'DOM.getContentQuads', { backendNodeId: target.backendNodeId });
      for (const quad of quads) {
        if (quad.length !== 8 || Math.abs((quad[2] - quad[0]) * (quad[5] - quad[1])) < 1) continue;
        const x = Math.round((quad[0] + quad[2] + quad[4] + quad[6]) / 4); const y = Math.round((quad[1] + quad[3] + quad[5] + quad[7]) / 4);
        const hit = await this.inspectNode<{ visible: boolean; covered: boolean; dialog?: string }>(tab, target, 'function(x,y) { const hit = this.getRootNode().elementFromPoint?.(x,y) ?? this.ownerDocument.elementFromPoint(x,y); const visible = this.isConnected && !!hit && (hit === this || this.contains(hit)); const dialog = hit?.closest("dialog[open],[role=dialog],[role=alertdialog]"); const title = dialog?.getAttribute("aria-label") || (dialog?.getAttribute("aria-labelledby") || "").split(/\\s+/).map(id=>this.ownerDocument.getElementById(id)?.textContent || "").join(" ").trim() || dialog?.querySelector("h1,h2,h3")?.textContent || (dialog ? "Open dialog" : undefined); return {visible,covered:this.isConnected && !!hit && !visible,dialog:title?.slice(0,200)}; }', [x, y]);
        if (hit.visible) return { x, y };
        covered ||= hit.covered; blockingDialog ??= hit.dialog;
      }
    } catch { /* A missing or replaced node must never be retargeted by its old index. */ }
    throw new BrowserActionError(covered ? 'BROWSER_TARGET_BLOCKED' : 'BROWSER_TARGET_NOT_VISIBLE', blockingDialog);
  }
  async click(conversationId: string, tabId: string, elementId: string, signal: AbortSignal, expected?: BrowserTarget): Promise<PageSnapshot> {
    await this.verifyTarget(conversationId, tabId, elementId, expected);
    const tab = this.owned(conversationId, tabId); signal.throwIfAborted();
    const target = await this.describe(conversationId, tabId, elementId);
    if (['password', 'file'].includes(target.type ?? '')) throw new Error('This field needs manual interaction.');
    if (target.disabled) throw new Error('This field cannot be edited.');
    let point = await this.point(tab, target); signal.throwIfAborted(); await this.verifyTarget(conversationId, tabId, elementId, target); signal.throwIfAborted();
    await this.moveCursor(tab, point, signal);
    await this.verifyTarget(conversationId, tabId, elementId, target); signal.throwIfAborted();
    // Hover can move or cover an element. Recheck its hit target immediately
    // before clicking instead of acting on the coordinates from before hover.
    point = await this.point(tab, target); signal.throwIfAborted();
    await this.paintCursor(tab, point, true).catch(() => {});
    await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
    await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    await new Promise(resolve => setTimeout(resolve, 70));
    await this.paintCursor(tab, point).catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 500)); return this.snapshot(conversationId, tabId, signal);
  }
  async type(conversationId: string, tabId: string, elementId: string, text: string, signal: AbortSignal, expected?: BrowserTarget): Promise<PageSnapshot> {
    await this.verifyTarget(conversationId, tabId, elementId, expected);
    const tab = this.owned(conversationId, tabId); signal.throwIfAborted();
    const target = await this.describe(conversationId, tabId, elementId);
    if (!target.editable || ['password', 'file'].includes(target.type ?? '')) throw new Error('This field needs manual interaction.');
    if (target.disabled || target.readonly) throw new Error('This field cannot be edited.');
    const point = await this.point(tab, target); signal.throwIfAborted();
    await this.moveCursor(tab, point, signal);
    await this.verifyTarget(conversationId, tabId, elementId, target); signal.throwIfAborted();
    await this.cdp(tab, 'DOM.focus', { backendNodeId: target.backendNodeId });
    const focused = await this.inspectNode<boolean>(tab, target, 'function() { return this.isConnected && (this.getRootNode().activeElement === this || this.contains(this.getRootNode().activeElement)); }');
    if (!focused) throw staleTarget();
    await this.verifyTarget(conversationId, tabId, elementId, target); signal.throwIfAborted();
    const key = { key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: process.platform === 'darwin' ? 8 : 2 };
    await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', ...key });
    await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key }); signal.throwIfAborted();
    if (text) await this.cdp(tab, 'Input.insertText', { text });
    else { await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }); }
    return this.snapshot(conversationId, tabId, signal);
  }
  async navigateAgent(conversationId: string, tabId: string, url: string, signal: AbortSignal, reload = false): Promise<PageSnapshot & { navigation: { performed: boolean; notice: string } }> {
    const tab = this.owned(conversationId, tabId); this.followAgent(tab);
    pageUrlSchema.parse(url); signal.throwIfAborted();
    if (!reload && tab.view.webContents.getURL() === new URL(url).href) return { navigation: { performed: false, notice: 'This URL is already loaded. Observed without reloading; existing page activity continues. Use reload:true if a fresh page start is required.' }, ...await this.snapshot(conversationId, tabId, signal) };
    await this.navigate(tab, url, signal); return { navigation: { performed: true, notice: 'Navigated to the requested URL.' }, ...await this.snapshot(conversationId, tabId, signal) };
  }
  async scrollAgent(conversationId: string, tabId: string, direction: 'up' | 'down', pixels: number, signal: AbortSignal): Promise<PageSnapshot & { scroll: BrowserScroll }> {
    const tab = this.owned(conversationId, tabId); signal.throwIfAborted(); this.followAgent(tab);
    await this.evaluate(tab, `window.scrollBy({left:0,top:${direction === 'up' ? -pixels : pixels},behavior:'instant'})`);
    signal.throwIfAborted(); return { ...await this.snapshot(conversationId, tabId, signal), scroll: await this.scroll(conversationId, tabId) };
  }
  async hover(conversationId: string, tabId: string, elementId: string, signal: AbortSignal, expected?: BrowserTarget): Promise<PageSnapshot> {
    await this.verifyTarget(conversationId, tabId, elementId, expected);
    const tab = this.owned(conversationId, tabId); signal.throwIfAborted();
    const target = await this.describe(conversationId, tabId, elementId); const point = await this.point(tab, target);
    await this.verifyTarget(conversationId, tabId, elementId, target); signal.throwIfAborted();
    await this.moveCursor(tab, point, signal);
    // Hidden pages still need actual hover events; only animation is optional.
    if (this.attached !== tab || !this.host()?.isVisible() || this.host()?.isMinimized()) await this.cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await new Promise(resolve => setTimeout(resolve, 100)); return this.snapshot(conversationId, tabId, signal);
  }
  async pressKey(conversationId: string, tabId: string, key: string, signal: AbortSignal): Promise<PageSnapshot> {
    const tab = this.owned(conversationId, tabId); signal.throwIfAborted(); this.followAgent(tab);
    // AX/CDP can inspect focused fields in closed shadow roots as well. Never
    // dispatch keys into passwords, upload controls, or uninspected frames.
    const { nodes } = await this.cdp<{ nodes: AXNode[] }>(tab, 'Accessibility.getFullAXTree');
    const focusedNodes = nodes.filter(node => axProperty(node, 'focused') === true && node.backendDOMNodeId);
    // RootWebArea remains focused while a control owns keyboard focus. Prefer
    // that control (including closed shadow roots) over the document node.
    const focused = focusedNodes.filter(node => axRole(node) !== 'RootWebArea').at(-1) ?? focusedNodes[0];
    if (!focused) throw new Error('This field needs manual interaction.');
    const target = await this.reference(tab, focused, focused.nodeId);
    if (['password', 'file'].includes(target.type ?? '') || ['IFRAME', 'FRAME'].includes(target.tagName) || target.disabled || target.readonly) throw new Error('This field needs manual interaction.');
    const safeFocus = await this.inspectNode<boolean>(tab, target, 'function() { const root = this.nodeType === 9 ? this : this.getRootNode(); const active = root.activeElement; if (["IFRAME","FRAME"].includes(active?.tagName)) return false; return active === this || this.nodeType === 9 && ["BODY","HTML"].includes(active?.tagName); }');
    if (!safeFocus) throw new Error('The focused field changed. Read a new browser snapshot.');
    const keys: Record<string, number> = { Enter:13,Escape:27,Tab:9,Backspace:8,Delete:46,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Home:36,End:35,PageUp:33,PageDown:34 };
    if (!(key in keys)) throw new Error('This field needs manual interaction.');
    await this.cdp(tab, 'Input.dispatchKeyEvent', { type:'keyDown',key,code:key,windowsVirtualKeyCode:keys[key], ...(key === 'Enter' ? { text:'\r' } : {}) });
    await this.cdp(tab, 'Input.dispatchKeyEvent', { type:'keyUp',key,code:key,windowsVirtualKeyCode:keys[key] });
    await new Promise(resolve => setTimeout(resolve, 150)); return this.snapshot(conversationId, tabId, signal);
  }
  reveal(conversationId: string, tabId: string): void { const tab = this.owned(conversationId, tabId); tab.watched = true; this.focusOnAttach = tab.id; this.activate(conversationId, tabId); if (this.host()) { this.focusWorkspace(conversationId, tabId); if (this.attached === tab) { this.focusOnAttach = undefined; tab.view.webContents.focus(); } } else this.showFloating(tab); }
  endRun(runId: string, retainInteractive: (conversationId: string) => boolean = () => false): void {
    for (const tab of [...this.tabs.values()]) {
      if (!tab.runs.delete(runId) || tab.runs.size) continue;
      if (!tab.manual && !tab.watched && !(tab.interactive && retainInteractive(tab.conversationId)) && tab !== this.attached && !tab.floating?.isVisible() && !this.waiting.has(tab.id)) this.destroyTab(tab);
      else this.activity(tab);
      if (!this.stopping) { this.workspaceChanged(this.workspaceState(tab.conversationId)); this.changed(tab.conversationId); }
    }
  }
  resume(tabId: string): void { const waiting = this.waiting.get(tabId); if (!waiting) { if (this.tabs.has(tabId)) return; throw new Error('This browser task is not waiting for input.'); } waiting.resolve(); }
  clearNavigationHistory(): void { for (const tab of this.tabs.values()) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.navigationHistory.clear(); for (const id of this.active.keys()) this.workspaceChanged(this.workspaceState(id)); }
  hideWindow(): void { this.layout = null; this.focusOnAttach = undefined; this.detach(); }
  closeConversation(id: string): void { for (const tab of [...this.tabs.values()]) if (tab.conversationId === id) this.destroyTab(tab); }
  shutdown(): void { this.stopping = true; for (const tab of [...this.tabs.values()]) if (!tab.view.webContents.isDestroyed()) this.destroyTab(tab); this.tabs.clear(); if (this.pool && !this.pool.isDestroyed()) this.pool.destroy(); this.pool = null; }
}


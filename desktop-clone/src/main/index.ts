import { connectorToolIconKeys } from '../shared/connector-tool-icon-keys';
import { OnboardingStore } from './onboarding';
import { AppUpdates } from './app-updates';
import { signedUpdateEngine } from './update-engine';
import { prepareModelAssets } from './model-setup';
import { updateActionSchema } from '../shared/updates';
import { onboardingSchema } from '../shared/onboarding';
import { remotePresentation } from '../core/remote-presentation';
import { GpuTelemetry } from './gpu-telemetry';
import { RemoteMediaBridge } from './remote-media';
import { PasswordManager } from './passwords';
import { PASSWORD_PRIVATE_MESSAGE } from './password-privacy';
import { importRemoteAttachment,removeRemoteAttachment,validateRemoteAttachments } from './remote-attachments';
import { toolPreview,attachmentPreview } from './tool-preview';
import { ImageGeneration } from './image-generation';
import { LocalVisionService } from './local-vision';
import { ImageUnderstanding } from './image-understanding';
import { WindowsImageText } from './image-text';
import { RemoteService } from './remote-service';
import { desktopRemoteManagement } from './desktop-remote-management';
import { modelDisplayName } from '../shared/effort';
import { RemoteVoiceBridge } from './remote-voice';
import { remotePreferencesSchema, remoteAppearanceSchema, REMOTE_DRAFT_ID } from '../shared/remote';
import { ComputerService } from './computer-service';
import { CuaDriverFactory } from './computer-driver';
import { computerExecutable } from './computer-process';
import { ChatBroadcast } from './chat-broadcast';
import type { ChatUpdate } from '../shared/chat';
import { imageActionSchema, imageSelectionSchema } from '../shared/image-generation';
import { clipboard, ClipboardItem } from 'electron';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, globalShortcut, systemPreferences, powerSaveBlocker } from 'electron';
import { MoonshineDictation as DictationService } from './moonshine-dictation';
import { PocketTTS, pocketErrors } from './pocket-tts';
import { ManagedLocalModel } from './managed-local';
import { LibraryFiles } from './library-files';
import { ModelResidency } from './model-residency';
import { miniCPM, builtInModels, builtInModelId, builtInModelInfo, type BuiltInModelId } from '../shared/managed-local';
import { scanBuiltInHardware } from './built-in-hardware';
import { ConfigurationMonitor } from './configuration-monitor';
import type { MonitorComponent } from '../shared/configuration-monitor';
import { SpeechService } from './speech-service';
import { speechErrors } from '../core/speech';
import { speechRequestSchema, speechStreamRequestSchema, pocketConnection } from '../shared/voice';
import { windowIcon } from './app-icon';
import { join,resolve } from 'node:path';
import { screen, nativeImage } from 'electron';
import { shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { conversationOrganizeSchema } from '../shared/chat';
import defaultIcon from './assets/dock-icons/tinygpt-ios-default.png?asset';
import darkIcon from './assets/dock-icons/tinygpt-dark.png?asset';
import tintedIcon from './assets/dock-icons/tinygpt-tinted-light.png?asset';
import clearLightIcon from './assets/dock-icons/tinygpt-clear-light.png?asset';
import clearDarkIcon from './assets/dock-icons/tinygpt-clear-dark.png?asset';
import { pathToFileURL } from 'node:url';
import { SettingsStore } from './store';
import { routeSchema, secretInputSchema, secretSlotSchema, settingsSchema } from '../shared/config';
import { connectionSettings } from '../shared/inference-connections';
import type { AppSnapshot, Result } from '../shared/contracts';
import { checkConnection } from '../core/connections';
import { discoverLocal, inspectLocal, withModel } from '../core/inference-discovery';
import { localCandidates } from './local-listeners';
import { OpenRouterSignIn } from './inference-auth';
import { openRouterAccount } from '../core/openrouter-account';
import { version } from '../../package.json';
import { HistoryStore } from './history';
import { ChatService } from './chat-service';
import { answerMarkdown } from '../core/answer-content';
import { CODE_FOLDER_ERROR, CODE_RUNTIME_ERROR } from '../shared/code';
import { chatExecution as runtimeChatExecution, warmChatRuntime, closeChatRuntime } from './chat-execution';
import { createWorkExecution } from './work-execution';
import { BotService } from './bot-service';
import { ScheduledStore } from './scheduled-store';
import { ScheduledService } from './scheduled-service';
import { scheduledInputSchema, scheduledActionSchema } from '../shared/scheduled';
import { BOT_RUNTIME_ERROR, BOT_SLEEPING_MESSAGE, botSetupSchema, botConfigurationSchema, botNoteSchema, botJobActionSchema } from '../shared/bot';
import { botReactionSchema } from '../shared/bot-reactions';
import { createConversationSchema, editMessageSchema, idSchema, messageActionSchema, projectInputSchema, projectOrganizeSchema, renameConversationSchema, sendMessageSchema, updateProjectSchema, queueActionSchema } from '../shared/chat';
import { mkdir, realpath, stat, writeFile } from 'node:fs/promises';
import { BrowserController } from './browser';
import { BrowserProfiles } from './browser-profiles';
import { browserLinkDestination } from '../core/browser-privacy';
import { ProjectFiles, installFileExtractor } from './files';
import { FileExtraction } from './file-extraction';
import { FileIngestion } from './file-ingestion';
import { sourceManifest } from '../core/source-manifest';
import { ToolBroker, safeToolError } from './tool-broker';
import { chooseAttachments, chooseAttachmentFolder } from './attachments';
import { approvalResponseSchema, manualPageSchema, manualSearchSchema, pageUrlSchema, sourceActionSchema, sourceSearchSchema } from '../shared/tools';
import { z } from 'zod';
import { browserRequestSchema, browserLayoutSchema, browserScrollRequestSchema, workspaceFileRequestSchema } from '../shared/workspace';
import { WorkspaceFiles } from './workspace-files';
import { WorkspaceGit } from './workspace-git';
import { workspaceGitRequestSchema } from '../shared/workspace-git';
import { MemoryIndexer } from './memory-indexer';
import { MemoryService } from './memory-service';
import { LocalEmbeddings } from './embeddings';
import { memoryInputSchema, indexRequestSchema, memorySearchSchema, profileNameSchema } from '../shared/memory';
import { PluginStore } from './plugin-store';
import { PluginService } from './plugin-service';
import { registerPluginIPC, pluginErrors } from './plugin-ipc';
import { ReplyDiagnostics } from './reply-diagnostics';
import { uiTraceSchema } from '../shared/diagnostics';
import { WorkspaceTerminals } from './workspace-terminals';
import { terminalRequestSchema, TERMINAL_LOCKED, TERMINAL_UNAVAILABLE, TERMINAL_START_ERROR } from '../shared/terminal';
import { ChatWindow } from './chat-window';
import { revealWindow } from './window-visibility';
import { isTinyGPTAppLink } from '../shared/app-link';
import { NotificationLog } from './notification-log';
import { NotificationService } from './notification-service';
import { NotificationSoundStore } from './notification-sound';
import { NotificationDesktop } from './notification-desktop';
import { notificationActionSchema, notificationViewSchema, notificationSoundResultSchema, notificationErrors } from '../shared/notifications';

// Use grayscale text antialiasing for this Windows rendering pass. Chromium
// reads this before creating renderers; macOS keeps its existing smoothing.
if (process.platform === 'win32') app.commandLine.appendSwitch('disable-lcd-text');

let store: SettingsStore;
let onboarding: OnboardingStore;
let window: BrowserWindow | null = null;
let hideBrowserWorkspace = () => {};
let history: HistoryStore;
let chat: ChatService;
let remote: RemoteService | undefined;
let notifications: NotificationService | undefined;
let notificationDesktop: NotificationDesktop | undefined;
let botService: BotService;
let scheduled: ScheduledService | undefined;
let broker: ToolBroker;
let computer: ComputerService;
let memory: MemoryService;
let indexer: MemoryIndexer;
let plugins: PluginService;
let browserProfiles: BrowserProfiles | undefined;
let diagnostics: ReplyDiagnostics;
let terminals: WorkspaceTerminals;
let quitting = false;
let updates: AppUpdates | undefined;
const projectFolderChoices = new Map<string, { path: string; expires: number }>();
let restoredBounds: Electron.Rectangle | null = null;
let resizing: { edge: string; x: number; y: number; bounds: Electron.Rectangle } | null = null;
function windowState() { return { maximized: !!restoredBounds || !!window?.isMaximized(), fullScreen: !!window?.isFullScreen() }; }
function notifyWindowState() { window?.webContents.send('tinygpt:window-state', windowState()); }
const rendererFile = join(__dirname, '../renderer/index.html');
const developmentUrl = process.env.ELECTRON_RENDERER_URL;
const trustedUrl = developmentUrl ? new URL(developmentUrl).href : pathToFileURL(rendererFile).href;
function broadcast(channel: string, value: unknown) {
  if (quitting) return;
  if (channel === 'tinygpt:chat-update') { chatBroadcast.publish(value as ChatUpdate); remote?.publish(value as ChatUpdate); return; }
  if (channel === 'tinygpt:settings-update') remote?.refreshVoice();
  for (const target of [window, chatWindow.window]) if (target && !target.isDestroyed()) target.webContents.send(channel, value);
}
const chatWindow = new ChatWindow({ preload: join(__dirname, '../preload/index.js'), url: `${trustedUrl}#popout`, main: () => window,
  icon: windowIcon,
  createMain: createWindow, quitting: () => quitting, changed: value => broadcast('tinygpt:chat-window-update', value) });
const chatBroadcast = new ChatBroadcast(() => [window, chatWindow.window]);

function snapshot(): AppSnapshot {
  return { settings: store.getSettings(), onboarding: onboarding.snapshot(), secrets: store.secretStatus(), inferenceConnections: store.inferenceConnections(), activeConnectionId: store.activeConnectionId(), secureStorageAvailable: store.secureStorageAvailable(), platform: process.platform, version };
}

function handle<T>(channel: string, action: (input: unknown, owner?: BrowserWindow) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, input): Promise<Result<T>> => {
    if (quitting) return { ok: false, error: 'TinyGPT is closing.' };
    const main = !!window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === trustedUrl;
    if (!main && !chatWindow.owns(event.sender, event.senderFrame)) return { ok: false, error: 'This request is not allowed.' };
    try { return { ok: true, value: await action(input, main ? window! : chatWindow.window!) }; }
    catch (error) {
      // Validation and network errors must not echo secret values to the UI.
      const message = error instanceof Error ? error.message : '';
      if (message===PASSWORD_PRIVATE_MESSAGE) return {ok:false,error:message};
      if(channel==='tinygpt:browser-passwords')return {ok:false,error:['The native password service is unavailable on this build.','The native password service could not be verified.','Saved passwords require a secure HTTPS website.','Close debugging tools before using saved passwords.','Set up Windows Hello or macOS Keychain before using saved passwords.','Wait for this page to finish loading before opening passwords.','The password window is already opening.'].includes(message)?message:'The private password window could not open. Your saved passwords were not changed.'};
      if (channel.startsWith('tinygpt:scheduled')) return { ok: false, error: ['Choose a future time.', 'This task changed. Reopen it before saving.', 'This scheduled task no longer exists.', 'Wait for the current task to finish.', 'Stop this task before removing it.', 'Choose a model in Settings.'].includes(message) ? message : 'This task could not be updated. Check its instructions and schedule, then try again.' };
      if (channel.startsWith('tinygpt:remote-')) return { ok: false, error: ['Use an HTTPS relay address.', 'Disconnect remote access before changing the relay address.', 'Remote access currently supports Chat conversations.', 'Secure credential storage is unavailable.'].includes(message) ? message : 'Remote access could not be updated. Check the relay address and connection, then try again.' };
      if ([BOT_RUNTIME_ERROR,BOT_SLEEPING_MESSAGE,'Wait for the current task to finish.','Watch not found.','Set up your bot first.','Stop your bot before changing its setup.',TERMINAL_LOCKED,TERMINAL_UNAVAILABLE,TERMINAL_START_ERROR,'Close a terminal before opening another.'].includes(message)) return {ok:false,error:message};
      const safeMessages = [CODE_FOLDER_ERROR, CODE_RUNTIME_ERROR, 'Enable tools in Settings before using Work.', 'This workspace file is no longer available. Open it again.', 'The file changed on disk. Reload it before saving.', 'This file cannot be edited as text.', 'Open up to twelve workspace files at once.', 'Choose the Project folder again.', 'Invalid folder.', 'Secure credential storage is unavailable.', 'Add your provider API key first.', 'The endpoint did not accept your credentials.', 'The model list is too large.', 'The endpoint did not return a compatible model list.', 'Conversation not found.', 'Project not found.', 'There is no reply to retry.', 'Stop the current reply before making this change.', 'Switch to Chat before sending a message.', 'Portal conversations will be enabled with the credit wallet service.', 'Choose a model in Settings.', 'Add your provider API key in Settings.', 'This conversation is too long for the first Chat release. Start a new chat; your history stays saved.'];
      const extra = ['Message not found in this conversation.', 'This reply cannot be continued.', 'Only an unfinished reply without follow-ups can be discarded.', 'This chat includes images. Enable image input for a compatible model in Settings, or start a chat without images.', 'This Chat release supports up to four images in one conversation. Start a new chat for more images.', 'Choose up to eight distinct attachments.', 'This attachment is unavailable for the current message.', 'The selected image could not be read.', 'Source not found in this conversation or Project.', 'This approval is no longer pending.', 'This browser task is not waiting for input.', 'Browser tools are disabled in Settings.'];
      const inferenceErrors = ['Secure credential storage is unavailable on this computer.', 'Finish the current OpenRouter sign-in first.', 'OpenRouter sign-in was canceled.', 'OpenRouter sign-in timed out. Please try again.', 'OpenRouter sign-in was declined. Try again when you’re ready.', 'Could not start sign-in.', 'OpenRouter could not finish sign-in. Please try again.', 'OpenRouter did not return a valid connection.', 'Local discovery only connects to this computer.', 'This local model is no longer available. Scan again.', 'Connect OpenRouter first.', 'This model is unavailable for your access and privacy settings. Choose another model.', 'Your connection changed. Choose the model again.'];
      return { ok: false, error: speechErrors.includes(message) || pocketErrors.includes(message) || message === 'Enable transcription in Voice settings first.' || notificationErrors.includes(message) || ['Choose another conversation to link.', 'This conversation has no messages to link yet.', 'This folder has no supported readable files.'].includes(message) || inferenceErrors.includes(message) || safeMessages.includes(message) || extra.includes(message) || pluginErrors.includes(message) || ['Memory not found.', 'Select a Project folder before indexing.', 'Save up to 500 memories. Remove a memory before adding another.'].includes(message) || /^The endpoint returned HTTP \d+\.$/.test(message)
        ? message : safeToolError(error) };
    }
  });
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 1200, height: 820, minWidth: 850, minHeight: 600,
    title: 'TinyGPT', frame: false, transparent: true, backgroundColor: '#00000000', roundedCorners: true, hasShadow: true,
    icon: windowIcon,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, autoplayPolicy: 'no-user-gesture-required',
    },
  });
  const createdWindow = window;
  createdWindow.once('ready-to-show', () => {
    if (!createdWindow.isDestroyed() && !createdWindow.isMinimized() && !createdWindow.isVisible()) revealWindow(createdWindow, screen.getAllDisplays().map(display => display.workArea));
  });
  if (process.platform !== 'darwin') window.removeMenu();
  for (const channel of ['tinygpt:window-state', 'tinygpt:window-control', 'tinygpt:window-resize', 'tinygpt:app-icon']) ipcMain.removeHandler(channel);
  handle('tinygpt:app-icon', input => {
    const choice = z.enum(['ios-default', 'dark', 'tinted-light', 'clear-light', 'clear-dark']).parse(input);
    const image = nativeImage.createFromPath({ 'ios-default': process.platform === 'win32' ? windowIcon : defaultIcon, dark: darkIcon, 'tinted-light': tintedIcon, 'clear-light': clearLightIcon, 'clear-dark': clearDarkIcon }[choice]);
    if (process.platform === 'darwin') app.dock?.setIcon(image); else for (const target of [window, chatWindow.window]) if (target && !target.isDestroyed()) target.setIcon(image);
  });
  window.on('maximize', notifyWindowState); window.on('unmaximize', notifyWindowState);
  window.on('enter-full-screen', notifyWindowState); window.on('leave-full-screen', notifyWindowState);
  handle('tinygpt:window-state', windowState);
  handle('tinygpt:window-control', (input, owner) => {
    const action = z.enum(['minimize', 'maximize', 'close']).parse(input);
    if (owner === chatWindow.window) { if (action !== 'maximize') chatWindow.dock(); return { maximized: false, fullScreen: false }; }
    if (action === 'close') window?.close();
    else if (action === 'minimize') window?.minimize();
    else if (window) {
      if (window.isFullScreen()) window.setFullScreen(false);
      else if (process.platform === 'win32') {
        // Windows transparent windows need an explicit work-area maximize.
        if (restoredBounds) { const bounds = restoredBounds; restoredBounds = null; window.setBounds(bounds); }
        else { restoredBounds = window.getBounds(); window.setBounds(screen.getDisplayMatching(restoredBounds).workArea); }
      } else if (window.isMaximized()) window.unmaximize(); else window.maximize();
    }
    notifyWindowState(); return windowState();
  });
  handle('tinygpt:window-resize', (input, owner) => {
    if (owner === chatWindow.window) return;
    const value = z.object({ edge: z.enum(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']), phase: z.enum(['start', 'move', 'end']), x: z.number().finite().min(-50000).max(50000), y: z.number().finite().min(-50000).max(50000) }).strict().parse(input);
    if (value.phase === 'end') { resizing = null; return; }
    if (!window || windowState().maximized || window.isFullScreen()) return;
    if (value.phase === 'start') { resizing = { edge: value.edge, x: value.x, y: value.y, bounds: window.getBounds() }; return; }
    if (!resizing || resizing.edge !== value.edge) return;
    const bounds = { ...resizing.bounds }; const dx = Math.round(value.x - resizing.x); const dy = Math.round(value.y - resizing.y);
    if (value.edge.includes('e')) bounds.width = Math.max(850, bounds.width + dx);
    if (value.edge.includes('s')) bounds.height = Math.max(600, bounds.height + dy);
    if (value.edge.includes('w')) { bounds.width = Math.max(850, bounds.width - dx); bounds.x += resizing.bounds.width - bounds.width; }
    if (value.edge.includes('n')) { bounds.height = Math.max(600, bounds.height - dy); bounds.y += resizing.bounds.height - bounds.height; }
    window.setBounds(bounds);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== trustedUrl) event.preventDefault(); });
  // Microphone access is limited to our own composer frames. Embedded pages
  // and camera requests never receive a media grant.
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    (permission === 'clipboard-sanitized-write' || permission === 'media' && details.mediaType === 'audio') && details.isMainFrame && (contents === window?.webContents && details.requestingUrl === trustedUrl || contents === chatWindow.window?.webContents && details.requestingUrl === `${trustedUrl}#popout`));
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback((permission === 'clipboard-sanitized-write' || permission === 'media' && 'mediaTypes' in details && !!details.mediaTypes?.length && details.mediaTypes.every(type => type === 'audio')) && details.isMainFrame && (contents === window?.webContents && details.requestingUrl === trustedUrl || contents === chatWindow.window?.webContents && details.requestingUrl === `${trustedUrl}#popout`)));
  window.on('close', () => hideBrowserWorkspace());
  window.on('closed', () => { window = null; restoredBounds = null; resizing = null; if (process.platform !== 'darwin' && !chatWindow.window) app.quit(); });
  window.webContents.on('render-process-gone', (_event, details) => console.error('TinyGPT window renderer stopped:', details.reason, details.exitCode));
  window.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== -3) console.error('TinyGPT window failed to load:', code); });
  window.on('unresponsive', () => console.error('TinyGPT window renderer is unresponsive.'));
  if (developmentUrl) void window.loadURL(developmentUrl);
  else void window.loadFile(rendererFile);
}

app.setName('TinyGPT');
app.setPath('userData', process.env.TINYGPT_VOICE_PROFILE?resolve(process.env.TINYGPT_VOICE_PROFILE):join(app.getPath('appData'),'TinyGPT Voice Clone'));
if(process.env.TINYGPT_VOICE_DEBUG_PORT)app.commandLine.appendSwitch('remote-debugging-port',process.env.TINYGPT_VOICE_DEBUG_PORT);
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) app.quit();
else {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (quitting || !isTinyGPTAppLink(url)) return;
    if (window && !window.isDestroyed()) revealWindow(window, screen.getAllDisplays().map(display => display.workArea));
    // On a cold launch the normal ready-to-show path reveals the new window.
  });
  app.on('second-instance', (_event, commandLine) => {
    if (quitting) return;
    const links = commandLine.filter(value => /^tinygpt:/i.test(value));
    if (links.length && (links.length !== 1 || !isTinyGPTAppLink(links[0]))) return;
    if (window && !window.isDestroyed()) revealWindow(window, screen.getAllDisplays().map(display => display.workArea));
    else if (chatWindow.window) chatWindow.dock();
  });
  void app.whenReady().then(async () => {
    // Isolated test profiles must never take over the user's protocol handler.
    if (!process.env.TINYGPT_VOICE_PROFILE && !process.env.TINYGPT_TOOLS_PROFILE && (app.isPackaged || process.platform === 'win32')) {
      const args = process.defaultApp ? [app.getAppPath()] : undefined;
      if (args ? !app.isDefaultProtocolClient('tinygpt', process.execPath, args) : !app.isDefaultProtocolClient('tinygpt')) {
        const registered = args ? app.setAsDefaultProtocolClient('tinygpt', process.execPath, args) : app.setAsDefaultProtocolClient('tinygpt');
        if (!registered) console.warn('TinyGPT app-link registration was unavailable.');
      }
    }
    const modelResources = app.isPackaged ? await prepareModelAssets(process.resourcesPath, app.getPath('userData'), version, windowIcon) : undefined;
    const voiceRoot=app.isPackaged?join(modelResources!,'voice-runtime'):join(app.getAppPath(),'runtimes/voice');
    const runtimeMetric = (metric: import('../shared/diagnostics').NativePerformance) => diagnostics?.recordRuntime(metric);
    const managedLocal = new ManagedLocalModel(join(app.getPath('userData'), 'local-models', 'minicpm5-2b'),voiceRoot, 'included', undefined, runtimeMetric);
    const managedPro = new ManagedLocalModel(join(app.getPath('userData'), 'local-models', 'pro'), undefined, 'pro', join(app.getPath('userData'), 'local-models', 'minicpm5-2b'), runtimeMetric);
    const builtIns = { included: managedLocal, pro: managedPro };
    app.once('before-quit', () => { void Promise.all([managedLocal.stop(), managedPro.stop()]); });
    if (process.platform === 'win32') app.setAppUserModelId('com.tinygpt.voice.clone');
    const dictation = new DictationService(voiceRoot, () => store.getSettings().voice.dictation, () => !!store.getSettings().modelResidency?.keepLoaded);
    app.once('before-quit', () => dictation.close());
    const documentReader = new FileExtraction();
    installFileExtractor((path, bytes, signal) => documentReader.extract(path, bytes, signal));
    app.once('before-quit', () => documentReader.close());
    handle('tinygpt:dictation-start', (input, owner) => {
      const value = z.object({ id: z.string().uuid(), sampleRate: z.number().int().min(8000).max(96000) }).strict().parse(input);
      return dictation.start(value.id, value.sampleRate, owner!.webContents);
    });
    handle('tinygpt:dictation-audio', (input, owner) => {
      const value = z.object({ id: z.string().uuid(), audio: z.instanceof(Uint8Array).refine(bytes => bytes.length > 0 && bytes.length <= 32768 && bytes.length % 2 === 0) }).strict().parse(input);
      dictation.audio(value.id, owner!.webContents, value.audio);
    });
    handle('tinygpt:dictation-stop', (input, owner) => {
      const value = z.object({ id: z.string().uuid(), cancel: z.boolean().optional() }).strict().parse(input);
      return dictation.stop(value.id, owner!.webContents, value.cancel ?? false);
    });
    store = new SettingsStore(app.getPath('userData'), {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: value => safeStorage.encryptString(value),
      decrypt: value => safeStorage.decryptString(value),
    });
    const firstLaunch=!(await stat(join(app.getPath('userData'),'settings.json')).catch(()=>null));
    await store.load();
    onboarding = new OnboardingStore(app.getPath('userData'));
    await onboarding.load(firstLaunch);
    if(firstLaunch){const current=store.getSettings();await store.saveSettings({...current,mode:'chat',route:'local',local:{...current.local,model:miniCPM.id,contextWindowTokens:miniCPM.context,maxOutputTokens:miniCPM.output,tools:true},voice:{...current.voice,readAloud:{...current.voice.readAloud,enabled:true,selection:{connectionId:pocketConnection,model:'pocket-tts'},voice:'alba'}}});}
    else if (store.getSettings().voice.readAloud.selection?.model === 'kokoro') { const current = store.getSettings(); await store.saveSettings({ ...current, voice: { ...current.voice, readAloud: { ...current.voice.readAloud, selection: { connectionId: pocketConnection, model: 'pocket-tts' }, voice: 'alba' } } }); }
    const inferenceSignIn = new OpenRouterSignIn(url => shell.openExternal(url), () => { if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
    app.once('before-quit', () => inferenceSignIn.close());
    warmChatRuntime(store.getSettings().route === 'local' ? store.getSettings().local.model : store.getSettings().byok.model);
    await mkdir(app.getPath('userData'), { recursive: true });
    const gpuTelemetry = new GpuTelemetry(() => [managedLocal.processId(), managedPro.processId()].filter((pid): pid is number => pid !== undefined));
    try { diagnostics = new ReplyDiagnostics(join(app.getPath('userData'), 'diagnostics.sqlite'), undefined, undefined, gpuTelemetry); }
    catch { diagnostics = new ReplyDiagnostics(':memory:', undefined, undefined, gpuTelemetry); }
    history = new HistoryStore(join(app.getPath('userData'), 'library.sqlite'));
    history.memory.syncHandbook();
    const ingestion = new FileIngestion(history.sources, (name, bytes, signal) => documentReader.extractDocument(name, bytes, signal), id => { if (!quitting) { memory?.kick(); if (chat) toolUpdate(id); } });
    app.once('before-quit', () => { void ingestion.close(); });
    const pocket = new PocketTTS(voiceRoot, app.getPath('userData'), fetch, () => !!store.getSettings().modelResidency?.keepLoaded);
    const speech = new SpeechService(history, store, fetch, pocket);
    app.once('before-quit', () => speech.close());
    handle('tinygpt:speech-models', input => speech.models(z.boolean().optional().parse(input) ?? false, true));
    const speechOwners = new WeakSet<Electron.WebContents>();
    const speechOwner = (owner: BrowserWindow) => { const contents = owner.webContents, id = contents.id; if (!speechOwners.has(contents)) { speechOwners.add(contents); contents.once('destroyed', () => speech.cancelOwner(id)); } return id; };
    handle('tinygpt:read-aloud', (input, owner) => speech.read(speechRequestSchema.parse(input), speechOwner(owner!)));
    handle('tinygpt:speech-preview', (input, owner) => speech.preview(z.uuid().parse(input), speechOwner(owner!)));
    handle('tinygpt:speech-cancel', (input, owner) => speech.cancel(z.uuid().parse(input), owner!.webContents.id));
    handle('tinygpt:speech-next', (input, owner) => { const value = speechStreamRequestSchema.parse(input); return speech.nextStream(value.jobId, speechOwner(owner!), value.sequence); });
    browserProfiles = new BrowserProfiles(app.getPath('userData'), () => store.getSettings().browser);
    await browserProfiles.load();
    for (const project of history.projects()) browserProfiles.register(`persist:tinygpt-browser-${project.id}`);
    const toolUpdate = (id: string) => { if (!quitting && chat && history.hasConversation(id)) { const update = chat.update(id); if (update.conversation.mode !== 'bot' || update.conversation.id === botService.snapshot().conversationId) notifications?.observe(update); broadcast('tinygpt:chat-update', update); } };
    const browser = new BrowserController(toolUpdate, () => window, state => window?.webContents.send('tinygpt:workspace-browser-state', state), (conversationId, tabId) => window?.webContents.send('tinygpt:workspace-browser-focus', { conversationId, tabId }), browserProfiles, () => store.getSettings().browser);
    const workspaceFiles = new WorkspaceFiles(history, () => (window ?? chatWindow.window)!);
    const workspaceGit = new WorkspaceGit(history, projectId => chat.assertProjectIdle(projectId));
    hideBrowserWorkspace = () => browser.hideWindow();
    const memoryChanged = () => { if (!quitting && memory && window && !window.isDestroyed()) window.webContents.send('tinygpt:memory-update', memory.snapshot()); };
    memory = new MemoryService(history, new LocalEmbeddings(join(app.getPath('userData'), 'retrieval'), history.databasePath, app.isPackaged ? join(modelResources!, 'rag') : join(__dirname, '../../runtimes/rag')), () => store.getSettings().toolPermissions.read !== 'deny', memoryChanged, () => dictation.isActive(), () => store.getSettings().modelResidency ?? {});
    indexer = new MemoryIndexer(history, () => store.getSettings().toolPermissions.read !== 'deny', () => { memoryChanged(); memory.kick(); });
    let remoteToolIcons: Record<string,string> = {}, remoteIconRevision = 0;
    const refreshRemoteIcons = async () => { const revision = ++remoteIconRevision; const keys = await connectorToolIconKeys(plugins.snapshot()); if (revision === remoteIconRevision) { remoteToolIcons = keys; remote?.refreshDisplay(); } };
    const pluginsChanged = () => { if (quitting) return; void refreshRemoteIcons().catch(() => {}); broker?.revokeUnavailableExtensions(); memoryChanged(); memory.kick(); if (window && !window.isDestroyed()) window.webContents.send('tinygpt:plugins-update', plugins.snapshot()); };
    plugins = new PluginService(new PluginStore(app.getPath('userData'), { available: () => safeStorage.isEncryptionAvailable(), encrypt: value => safeStorage.encryptString(value), decrypt: value => safeStorage.decryptString(value) }), history, new ProjectFiles(history.sources), pluginsChanged, () => store.getSettings().toolPermissions.read !== 'deny', url => shell.openExternal(url), () => { if (!window || window.isDestroyed()) createWindow(); if (window?.isMinimized()) window.restore(); window?.show(); window?.focus(); });
    await plugins.initialize();
    await refreshRemoteIcons();
    broker = new ToolBroker(history, () => store.getSettings(), browser, new ProjectFiles(history.sources), toolUpdate, memory, plugins, diagnostics);
    broker.prepareSources = (ids, signal) => ingestion.wait(ids, signal);
    broker.imageUnderstanding = new ImageUnderstanding(new WindowsImageText(app.isPackaged ? join(process.resourcesPath, 'vision', 'windows-image-ocr.ps1') : join(app.getAppPath(), 'scripts', 'windows-image-ocr.ps1'), join(app.getPath('userData'), 'vision-sessions', 'text')));
    broker.localVision = new LocalVisionService({ keepLoaded: () => !!store.getSettings().modelResidency?.keepLoaded, modelRoot: app.isPackaged ? join(modelResources!, 'vision') : join(app.getAppPath(), 'runtimes/vision'), runtimeRoot: join(voiceRoot, 'llama'), stateRoot: join(app.getPath('userData'), 'vision-sessions') });
    broker.proVision = { available: () => managedPro.imageAvailable(), analyze: (image, question, signal) => managedPro.analyze(image, question, signal) };
    const computerRuntime = app.isPackaged ? join(process.resourcesPath, 'computer-runtime') : join(__dirname, '../../runtimes/computer');
    const computerPermissions = () => process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false) && systemPreferences.getMediaAccessStatus('screen') === 'granted';
    computer = new ComputerService(new CuaDriverFactory(computerRuntime, join(app.getPath('userData'), 'computer-sessions')), () => store.getSettings(), computerExecutable, process.platform, process.pid, computerPermissions);
    broker.computer = computer;
    const stopComputer = () => { computer.stop(); broker.revokeUnavailableExtensions(); };
    const stopKey = 'CommandOrControl+Shift+Backspace';
    const stopKeyRegistered = globalShortcut.register(stopKey, stopComputer);
    app.once('will-quit', () => { if (stopKeyRegistered) globalShortcut.unregister(stopKey); });
    const computerStatus = async () => ({ ...await computer.status(), stopShortcut: stopKeyRegistered ? process.platform === 'darwin' ? '⌘ + Shift + Backspace' : 'Ctrl + Shift + Backspace' : 'Use Stop in Chat or Settings', ...(process.platform === 'darwin' ? { permissions: { accessibility: systemPreferences.isTrustedAccessibilityClient(false), screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted' } } : {}) });
    handle('tinygpt:computer-status', computerStatus);
    handle('tinygpt:computer-stop', () => { stopComputer(); return computerStatus(); });
    handle('tinygpt:computer-resume', () => { computer.resume(); return computerStatus(); });
    handle('tinygpt:computer-permissions', async () => {
      if (process.platform === 'darwin') {
        const adapter = await import(/* @vite-ignore */ pathToFileURL(join(computerRuntime, 'sdk/node_modules/@trycua/cua-driver/dist/electron.js')).href);
        const permissions = adapter.requestMacOSPermissions();
        if (!permissions.screenRecording) await adapter.openMacOSScreenRecordingSettings();
      }
      return computerStatus();
    });
    const imageGeneration = new ImageGeneration(history, store, toolUpdate); broker.imageGeneration = imageGeneration;
    terminals = new WorkspaceTerminals(history,join(app.getPath('userData'),'terminal-runtime'),state=>{if(!quitting&&window&&!window.isDestroyed())window.webContents.send('tinygpt:workspace-terminal-state',state);});
    broker.native.terminals = terminals;
    handle('tinygpt:workspace-terminal', input => terminals.run(terminalRequestSchema.parse(input)));
    await broker.code.recover();
    botService = new BotService(app.getPath('userData'), history, () => store.getSettings(), value => { broadcast('tinygpt:bot-update', value); remote?.refreshLibraries(); }, (id, projectId) => plugins.store.captureSelection(id, projectId), id => toolUpdate(id));
    await botService.load();
    handle('tinygpt:bot', () => botService.snapshot());
    let botSnoozeChange: Promise<unknown> = Promise.resolve();
    const setBotSnoozed = (snoozed: boolean) => {
      const change = botSnoozeChange.then(async () => {
        const saving = botService.setSnoozed(snoozed);
        const stopping = snoozed ? chat.library().activeRuns.filter(run => history.conversation(run.conversationId).mode === 'bot').map(run => chat.cancel(run.conversationId)) : [];
        const outcomes = await Promise.allSettled([saving, ...stopping]);
        const failure = outcomes.find(result => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
        return botService.snapshot();
      });
      botSnoozeChange = change.catch(() => {}); return change;
    };
    handle('tinygpt:bot-snooze', input => setBotSnoozed(z.boolean().parse(input)));
    handle('tinygpt:bot-notes', () => botService.notes());
    handle('tinygpt:bot-jobs', () => botService.jobs());
    handle('tinygpt:bot-job-change', input => {
      const action = botJobActionSchema.parse(input);
      if (action.action === 'run') { scheduled!.checkBotJob(action.id); return botService.jobs(); }
      return botService.changeJob(action.id, action.action);
    });
    handle('tinygpt:bot-note-save', input => { const id = botService.snapshot().conversationId; if (id) chat.assertIdle(id); return botService.saveNote(botNoteSchema.parse(input)); });
    handle('tinygpt:bot-configure', input => { chat.assertIdle(); return botService.configure(botConfigurationSchema.parse(input)); });
    handle('tinygpt:bot-prepare', input => botService.prepare(botSetupSchema.parse(input)));
    handle('tinygpt:bot-clear', async () => {
      const id = botService.snapshot().conversationId;
      if (!id) throw Error('Set up your bot before clearing its conversation.');
      return chat.clearBotConversation(id, async () => { const conversation = await botService.clearConversation(); notifications?.forgetConversation(id); return conversation; });
    });
    handle('tinygpt:bot-complete', input => { const setup = botSetupSchema.parse(input); const id = botService.snapshot().conversationId; if (id) chat.assertIdle(id); return botService.complete(setup); });
    const notificationSound = new NotificationSoundStore(app.getPath('userData')); await notificationSound.load();
    notificationDesktop = new NotificationDesktop({ main: () => window, floating: () => chatWindow.window, floatingConversation: () => chatWindow.state.conversationId, createMain: createWindow, icon: defaultIcon, sound: notificationSound, soundPreferences: () => store.getSettings().notifications.sound });
    const notificationChanged = () => { if (!quitting && notifications) broadcast('tinygpt:notifications-update', notifications.snapshot()); };
    notifications = new NotificationService(new NotificationLog(join(app.getPath('userData'), 'notifications.sqlite')), history, () => store.getSettings().notifications, {
      supported: () => notificationDesktop!.supported(), viewing: id => notificationDesktop!.viewing(id), show: (entry, preview, open, failed) => notificationDesktop!.show(entry, preview, open, failed),
      sound: () => notificationDesktop!.play(), open: id => notificationDesktop!.open(id), customSoundName: () => notificationSound.name(),
    }, notificationChanged,undefined,entry=>remote?.notify(entry),id=>history.conversation(id).mode !== 'bot' || id === botService.snapshot().conversationId);
    handle('tinygpt:notifications', () => notifications!.snapshot());
    handle('tinygpt:notification-action', input => notifications!.action(notificationActionSchema.parse(input)));
    handle('tinygpt:notification-view', (input, owner) => {
      const view = notificationViewSchema.parse(input); if (view.conversationId) history.conversation(view.conversationId);
      notificationDesktop!.view(owner!, view);
      if (view.conversationId && notificationDesktop!.viewing(view.conversationId) && notifications!.snapshot().unreadConversationIds.includes(view.conversationId)) notifications!.readConversation(view.conversationId);
    });
    handle('tinygpt:notification-sound-result', (input, owner) => { const result = notificationSoundResultSchema.parse(input); notificationDesktop!.soundResult(owner!, result.id, result.played); });
    handle('tinygpt:notification-sound-preview', async (_input, owner) => { await notificationDesktop!.play(owner!); notifications!.resetError(); notificationChanged(); });
    handle('tinygpt:notification-sound-choose', async (_input, owner) => {
      const chosen = await dialog.showOpenDialog(owner!, { title: 'Choose notification sound', properties: ['openFile'], filters: [{ name: 'Notification sound', extensions: ['wav', 'mp3'] }] });
      if (!chosen.canceled && chosen.filePaths[0]) {
        await notificationSound.choose(chosen.filePaths[0]); const settings = store.getSettings(); await store.saveSettings({ ...settings, notifications: { ...settings.notifications, sound: { ...settings.notifications.sound, source: 'custom' } } });
        notifications!.resetError(); broadcast('tinygpt:settings-update', snapshot()); notificationChanged();
      }
      return notifications!.snapshot();
    });
    handle('tinygpt:notification-test', () => { notifications!.resetError(); notificationDesktop!.test(() => notifications!.deliveryFailed('Desktop alerts could not be shown. Check your system notification settings.')); notificationChanged(); return notifications!.snapshot(); });
    let prepareLocalExecution: ((input: import('../shared/chat').ChatWorkerInput, signal: AbortSignal) => Promise<void>) | undefined;
    const localOperations = new Map<string, number>();
    const chatExecution: import('../shared/chat').ChatExecution = { async run(...args) {
      const [input, signal] = args, id = input.route === 'local' ? builtInModelId(input.model) : undefined;
      if (id) localOperations.set(id, (localOperations.get(id) ?? 0) + 1);
      try { await prepareLocalExecution?.(input, signal); return await runtimeChatExecution.run(...args); }
      finally { if (id) localOperations.set(id, Math.max(0, (localOperations.get(id) ?? 1) - 1)); }
    } };
    chat = new ChatService(history, () => store.getSettings(), slot => store.getSecret(slot), chatExecution, update => {
      if (!quitting && (update.conversation.mode !== 'bot' || update.conversation.id === botService.snapshot().conversationId)) notifications?.observe(update);
      broadcast('tinygpt:chat-update', update);
    }, broker, memory, plugins, diagnostics, createWorkExecution(history, () => { const permissions = store.getSettings().toolPermissions; if (permissions.read === 'deny' || permissions.browser === 'deny') throw new Error('Browser preview access was revoked.'); }), true, botService);
    let remoteAwakeId: number | undefined;
    const deleteSavedConversation = async (id: string) => {
      chat.assertIdle(id); browser.closeConversation(id); workspaceFiles.closeConversation(id);
      await terminals.closeConversation(id); await botService.forgetConversation(id); await broker.observations.clear(id);
      history.deleteConversation(id); notifications?.forgetConversation(id); chatWindow.forget(id);
      broadcast('tinygpt:chat-update', { library: chat.library(), conversation: { id: REMOTE_DRAFT_ID, projectId: null, mode: 'chat', title: 'New chat', createdAt: 0, updatedAt: 0, messages: [], tools: [], sources: [] } });
    };
    remote = new RemoteService(app.getPath('userData'), { available: () => safeStorage.isEncryptionAvailable(), encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(bytes) }, chat, process.env.TINYGPT_REMOTE_RELAY_URL || '', awake => {
      if (awake && remoteAwakeId === undefined) remoteAwakeId = powerSaveBlocker.start('prevent-app-suspension');
      else if (!awake && remoteAwakeId !== undefined) { powerSaveBlocker.stop(remoteAwakeId); remoteAwakeId = undefined; }
    }, {
      toolIconKeys: () => remoteToolIcons,
      bot: () => { const status = botService.snapshot(); if (!status.configured || !status.conversationId) return; return { conversationId: status.conversationId, name: history.conversation(status.conversationId).title, snoozed: !!status.snoozed, phase: status.phase, browser: !!status.configuration?.browser, watches: (botService.schedules?.jobs('bot') ?? []).slice(0, 50).map(job => ({ id: job.id, title: job.title.slice(0, 180), enabled: job.enabled, nextRunAt: job.nextRunAt })) }; },
      botSnooze: setBotSnoozed,
      botReact: (conversationId, messageId, emoji) => { chat.reactToMessage(conversationId, messageId, emoji); },
      validateAttachments: (id,ids) => validateRemoteAttachments(history,id,ids),
      create: async mode => { const conversation = history.createConversation(null, mode); await plugins.store.captureSelection(conversation.id, null); return chat.update(conversation.id); },
      approve: async (id, decision) => { broker.respond(id, decision); },
      edit: (conversationId, messageId, text) => chat.edit(conversationId, messageId, text),
      regenerate: (conversationId, messageId) => chat.start(conversationId, null, [], { type: 'regenerate', messageId }, undefined, true),
      branch: (conversationId, messageId) => { chat.assertIdle(conversationId); history.selectBranch(conversationId, messageId); chat.describe(conversationId); const update = chat.update(conversationId); broadcast('tinygpt:chat-update', update); return update; },
      rename: (id, title) => { history.renameConversation(id, title); broadcast('tinygpt:chat-update', chat.update(id)); },
      organize: (id, action, value) => { history.organizeConversation(action === 'pin' ? { id, action: 'pin', value } : { id, action: 'archive', value }); broadcast('tinygpt:chat-update', chat.update(id)); },
      delete: deleteSavedConversation,
      notifications: () => { const titles = new Map(history.conversations().map(chat => [chat.id, chat.title])); return (notifications?.snapshot().items ?? []).filter(item => item.mode !== 'bot' || item.conversationId === botService.snapshot().conversationId).slice(0, 50).map(item => ({ id: item.id, conversationId: item.conversationId, title: item.title, conversationTitle: titles.get(item.conversationId) ?? 'Conversation', createdAt: item.createdAt, read: item.read })); },
      readNotification: id => { notifications?.action({ action: 'read', id }); },
    }, new RemoteVoiceBridge(dictation, speech, () => store.getSettings().voice),undefined,new RemoteMediaBridge({presentation:(id,toolId)=>remotePresentation(chat.update(id).conversation.tools.find(tool=>tool.id===toolId),id),importFile:(id,name,bytes)=>importRemoteAttachment(history,id=>chat.assertIdle(id),id,name,bytes),remove:(id,sourceId)=>removeRemoteAttachment(history,id=>chat.assertIdle(id),id,sourceId),preview:(id,toolId)=>toolPreview(history,id,toolId),attachmentPreview:(id,sourceId,full)=>attachmentPreview(history,id,sourceId,full)}));
    await remote.load();
    handle('tinygpt:remote-appearance', input => remote!.setAppearance(remoteAppearanceSchema.parse(input)));
    handle('tinygpt:remote-configure', input => remote!.configure(remotePreferencesSchema.parse(input)));
    handle('tinygpt:remote-create-chat', async () => { const conversation = history.createConversation(null, 'chat'); await plugins.store.captureSelection(conversation.id, null); return conversation; });
    handle('tinygpt:remote-status', () => remote!.refreshDevices());
    handle('tinygpt:remote-approve-pairing', input => { const args = z.object({ id: idSchema, allow: z.boolean() }).strict().parse(input); return remote!.approvePairing(args.id, args.allow); });
    handle('tinygpt:remote-pair', input => { const args = z.object({ conversationId: idSchema, relayUrl: z.string().max(2048).optional(), scope: z.enum(['conversation','library']).default('library') }).strict().parse(input); return remote!.pair(args.conversationId, args.relayUrl, args.scope); });
    handle('tinygpt:remote-scope', input => { const args = z.object({ id: idSchema, scope: z.enum(['conversation', 'library']) }).strict().parse(input); return remote!.setScope(args.id, args.scope); });
    handle('tinygpt:remote-revoke', input => remote!.revoke(idSchema.parse(input)));
    handle('tinygpt:remote-management-access',input=>{const {id,value}=z.object({id:z.uuid(),value:z.boolean()}).strict().parse(input);return remote!.setManagement(id,value);});
    handle('tinygpt:remote-disconnect', () => remote!.disconnect());
    const scheduleStore = new ScheduledStore(join(app.getPath('userData'),'scheduled.sqlite'));
    botService.schedules = scheduleStore;
    scheduled = new ScheduledService(scheduleStore, history, chat, botService, async (id,job) => {
      if (job.owner !== 'bot') { await plugins.store.captureSelection(id,null); return; }
      const bot = botService.snapshot();
      await plugins.store.select(id,bot.projectId,plugins.store.selection(bot.conversationId,bot.projectId));
      if (bot.conversationId) plugins.inheritConversationAccess(bot.conversationId,id);
    }, () => chat.metadataInput(), chatExecution, () => plugins.suggestionContext(), value => broadcast('tinygpt:scheduled-update',value));
    const personalBotId = () => { const id = botService.snapshot().conversationId; if (!id) throw Error('Set up your bot first.'); return id; };
    handle('tinygpt:bot-plugin-access', () => plugins.conversationAccess(personalBotId()));
    handle('tinygpt:bot-plugin-access-set', input => plugins.track(async () => {
      const value = z.object({pluginId:idSchema,allowed:z.boolean()}).strict().parse(input), id = personalBotId();
      await plugins.setConversationAccess(id,value.pluginId,value.allowed);
      if (!value.allowed) for (const conversationId of new Set(scheduleStore.jobs('bot').map(job => job.conversationId).filter((id): id is string => !!id && id !== personalBotId()))) {
        try { history.conversation(conversationId); } catch { continue; }
        await plugins.setConversationAccess(conversationId,value.pluginId,false);
      }
      if (value.allowed) for (const approval of broker.approvals()) if (approval.conversationId === id && approval.pluginUse?.pluginId === value.pluginId) broker.respond(approval.id,'allow-conversation');
      broker.revokeUnavailableExtensions(); return plugins.conversationAccess(id);
    }));
    chat.backgroundStarted = id => scheduled?.foregroundStarted(id);
    handle('tinygpt:scheduled', () => scheduled!.snapshot());
    handle('tinygpt:scheduled-save', input => scheduled!.save(scheduledInputSchema.parse(input)));
    handle('tinygpt:scheduled-action', input => { const args = scheduledActionSchema.parse(input); return scheduled!.action(args.id,args.action); });
    handle('tinygpt:scheduled-suggestions', input => scheduled!.suggestions(z.boolean().default(false).parse(input)));
    setTimeout(() => scheduled?.start(), 0);
    void botService.resume();
    handle('tinygpt:diagnostics', () => diagnostics.snapshot());
    handle('tinygpt:diagnostic-trace', input => diagnostics.reports().find(run => run.runId === idSchema.parse(input)) ?? null);
    handle('tinygpt:diagnostics-enabled', input => diagnostics.setEnabled(z.boolean().parse(input)));
    handle('tinygpt:diagnostics-clear', () => diagnostics.clear());
    handle('tinygpt:reply-frame', input => diagnostics.acknowledge(uiTraceSchema.parse(input)));
    handle('tinygpt:diagnostics-export', async () => {
      const chosen = await dialog.showSaveDialog((window ?? chatWindow.window)!, { title: 'Export reply diagnostics', defaultPath: 'TinyGPT-diagnostics.json', filters: [{ name: 'Diagnostic report', extensions: ['json'] }] });
      if (chosen.canceled || !chosen.filePath) return false;
      await writeFile(chosen.filePath, JSON.stringify({ schemaVersion: 1, exportedAt: Date.now(), version, privacy: 'Local timing and categorical events only; no message content, credentials, URLs, or file paths.', runs: diagnostics.reports() }, null, 2), { encoding: 'utf8', mode: 0o600 });
      return true;
    });
    registerPluginIPC(handle, plugins, history, () => store.getSettings());
    memory.start(); indexer.start();
    const memoryResult = () => { memoryChanged(); const id = history.lastConversationId(); if (id) toolUpdate(id); return memory.snapshot(); };
    remote.setManagementActions(desktopRemoteManagement({history,store,plugins,chat,remote,version,voices:()=>pocket.listVoices(),memorySnapshot:()=>memory.snapshot(),memoryChanged:()=>{memory.kick();memoryResult();remote!.refreshLibraries();},settingsChanged:()=>{speech.close();broadcast('tinygpt:settings-update',snapshot());remote!.refreshVoice();},projectCreated:id=>{browserProfiles!.register(`persist:tinygpt-browser-${id}`);},moving:async id=>{browser.closeConversation(id);await terminals.closeConversation(id);}}));
    handle('tinygpt:memory', () => memory.snapshot());
    handle('tinygpt:memory-evidence', input => history.memory.evidence(idSchema.parse(input)));
    handle('tinygpt:memory-save', input => { chat.assertIdle(); history.memory.saveMemory(memoryInputSchema.parse(input)); memory.kick(); return memoryResult(); });
    handle('tinygpt:profile-name', input => { chat.assertIdle(); history.memory.saveProfileName(profileNameSchema.parse(input)); memory.kick(); return memoryResult(); });
    handle('tinygpt:memory-forget', input => { chat.assertIdle(); history.memory.remove(idSchema.parse(input)); return memoryResult(); });
    handle('tinygpt:memory-personal', input => { chat.assertIdle(); history.memory.setPreference('personal', z.boolean().parse(input)); return memoryResult(); });
    handle('tinygpt:memory-index', async input => { const { projectId, action } = indexRequestSchema.parse(input); history.project(projectId); chat.assertProjectIdle(projectId); await indexer.configure(projectId, action); return memoryResult(); });
    handle('tinygpt:memory-preview', input => { const { projectId, query } = memorySearchSchema.parse(input); return memory.preview(projectId, query); });
    handle('tinygpt:snapshot', () => snapshot());
    updates = new AppUpdates(app.isPackaged && process.platform === 'win32' ? await signedUpdateEngine(process.resourcesPath) : undefined, version, value => broadcast('tinygpt:update-state', value), () => chat.hasActiveRuns() || botService.hasActiveRuns() || !!scheduled?.hasActiveRuns() || terminals.hasActiveTerminals(), async () => { await browserProfiles?.flush(); });
    handle('tinygpt:updates', () => updates!.snapshot());
    handle('tinygpt:update-action', input => updates!.action(updateActionSchema.parse(input)));
    updates.start();
    handle('tinygpt:onboarding', async input => {
      await onboarding.save(onboardingSchema.parse(input));
      const next = snapshot();
      broadcast('tinygpt:settings-update', next);
      return next;
    });
    handle('tinygpt:chat-window', () => chatWindow.state);
    handle('tinygpt:chat-return-received', (input, owner) => { const id = idSchema.parse(input); if (owner === window && chatWindow.state.returnedConversationId === id) chatWindow.state = { conversationId: chatWindow.state.conversationId, returnedConversationId: null }; });
    handle('tinygpt:chat-pop-out', input => { const id = idSchema.parse(input); history.conversation(id); return chatWindow.open(id); });
    handle('tinygpt:chat-return', input => chatWindow.dock(z.object({ settingsSection: z.enum(['General', 'Configuration', 'Bot', 'Plugins']).optional(), workspace: z.object({ panel: z.enum(['sources', 'web', 'files']), sourceId: idSchema.optional(), url: pageUrlSchema.optional() }).strict().optional() }).strict().parse(input ?? {})));
    handle('tinygpt:browser-history', () => browserProfiles!.history());
    const passwords = new PasswordManager(async()=>{
      await Promise.all(chat.library().activeRuns.map(run=>chat.cancel(run.conversationId)));
      await broker.pauseForPasswords();
      chat.assertIdle();
    });
    app.once('before-quit',()=>passwords.shutdown());
    handle('tinygpt:browser-passwords',async(input,owner)=>{
      const {conversationId,tabId}=z.object({conversationId:z.uuid(),tabId:z.uuid()}).strict().parse(input);
      if(!owner||owner!==window)throw Error('Open the browser in the main window first.');
      const conversation=history.conversation(conversationId), project=conversation.projectId?history.project(conversation.projectId):null;
      const context=browser.passwordContext(conversationId,tabId);
      if(context.partition!==browser.partition(project?.id??null,project?.browserIsolated??false))throw Error('This browser profile changed.');
      await passwords.open(owner,context,async()=>{try{await browser.navigateWorkspace(conversationId,tabId,new URL(context.url).origin+'/');browser.reveal(conversationId,tabId);}catch{/* The originating tab may have been closed by the user. */}});
    });
    handle('tinygpt:browser-open-link', async input => { const url = pageUrlSchema.parse(input); const destination = browserLinkDestination(url, store.getSettings().browser); if (destination === 'system') await shell.openExternal(url); return destination; });
    handle('tinygpt:browser-clear-data', async input => {
      const action = z.enum(['history', 'all']).parse(input); chat.assertIdle();
      if (browser.handoffs().length) throw new Error('Finish or stop the browser task before clearing browsing data.');
      if (action === 'all') { broker.cancelManual(); await browserProfiles!.clearData(); } else await browserProfiles!.clearHistory();
      browser.clearNavigationHistory();
    });
    handle('tinygpt:workspace-files', async input => { const request = workspaceFileRequestSchema.parse(input); const result = await workspaceFiles.run(request); if (result.sourceId) toolUpdate(request.conversationId); return result; });
    handle('tinygpt:workspace-git', input => workspaceGit.run(workspaceGitRequestSchema.parse(input)));
    handle('tinygpt:workspace-browser-layout', (input, owner) => { const layout = browserLayoutSchema.parse(input); history.conversation(layout.conversationId); browser.setLayout(layout,owner); });
    handle('tinygpt:workspace-browser-scroll', input => { const request = browserScrollRequestSchema.parse(input); history.conversation(request.conversationId); return browser.scroll(request.conversationId, request.tabId, request.position); });
    handle('tinygpt:workspace-browser-capture', async input => { const { conversationId, tabId, preview } = z.object({ conversationId: z.uuid(), tabId: z.uuid(), preview: z.boolean().optional() }).strict().parse(input); if (!history.hasConversation(conversationId)) throw Error('Conversation not found.'); return browser.capture(conversationId, tabId, preview); });
    handle('tinygpt:workspace-browser', async input => {
      const request = browserRequestSchema.parse(input); const conversation = history.conversation(request.conversationId); const project = conversation.projectId ? history.project(conversation.projectId) : null;
      const partition = browser.partition(project?.id ?? null, project?.browserIsolated ?? false);
      if (request.action === 'state') return browser.workspaceState(conversation.id);
      if (request.action === 'new') { const id = browser.newWorkspaceTab(conversation.id, partition); if (request.url) void browser.navigateWorkspace(conversation.id, id, request.url).catch(() => {}); return browser.workspaceState(conversation.id); }
      const contents = browser.contents(conversation.id, request.tabId);
      if (request.action === 'navigate') { void browser.navigateWorkspace(conversation.id, request.tabId, request.url).catch(() => {}); }
      else if (request.action === 'activate') browser.activate(conversation.id, request.tabId);
      else if (request.action === 'close') browser.closeTab(conversation.id, request.tabId);
      else if (request.action === 'duplicate') { const id = browser.newWorkspaceTab(conversation.id, partition); if (contents.getURL() && contents.getURL() !== 'about:blank') void browser.navigateWorkspace(conversation.id, id, contents.getURL()).catch(() => {}); }
      else if (request.action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      else if (request.action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      else if (request.action === 'reload') contents.reload();
      else if (request.action === 'stop') contents.stop();
      else if (request.action === 'zoom') contents.setZoomFactor(request.value / 100);
      else if (request.action === 'find') { if (request.query) contents.findInPage(request.query, { forward: request.forward }); else contents.stopFindInPage('clearSelection'); }
      else if (request.action === 'print') contents.print({ silent: false });
      else if (request.action === 'downloads') await shell.openPath(app.getPath('downloads'));
      else if (request.action === 'screenshot') { const image = nativeImage.createFromDataURL(await browser.capture(conversation.id, request.tabId)); const choice = await dialog.showSaveDialog((window ?? chatWindow.window)!, { title: 'Save browser screenshot', defaultPath: 'TinyGPT page.png', filters: [{ name: 'PNG image', extensions: ['png'] }] }); if (!choice.canceled && choice.filePath) await writeFile(choice.filePath, image.toPNG()); }
      else if (request.action === 'save-source') { const page = await browser.snapshot(conversation.id, request.tabId, new AbortController().signal); history.sources.add(conversation.id, { kind: 'page', title: page.title, text: page.text, url: page.url }); toolUpdate(conversation.id); }
      return browser.workspaceState(conversation.id);
    });
    handle('tinygpt:settings', async (input, owner) => { const next = settingsSchema.parse(input); if (owner === chatWindow.window) next.mode = store.getSettings().mode; const permissionsChanged = JSON.stringify(next.toolPermissions) !== JSON.stringify(store.getSettings().toolPermissions); const computerChanged = next.computer.enabled !== store.getSettings().computer.enabled || next.toolPermissions.desktop !== store.getSettings().toolPermissions.desktop || next.toolPermissions.desktopInteract !== store.getSettings().toolPermissions.desktopInteract; if (JSON.stringify(next.voice) !== JSON.stringify(store.getSettings().voice)) speech.close(); await store.saveSettings(next); if (computerChanged) { computer.stop(); if (next.computer.enabled) computer.resume(); } warmChatRuntime(next.route === 'local' ? next.local.model : next.byok.model); if (permissionsChanged) history.clearConversationGrants(); broker.revokeUnavailableExtensions(); void botService.connectionChanged(); const value = snapshot(); broadcast('tinygpt:settings-update', value); return value; });
    handle('tinygpt:secret-save', async input => {
      const { slot, value } = secretInputSchema.parse(input);
      await store.saveSecret(slot, value); const next = snapshot(); broadcast('tinygpt:settings-update', next); return next;
    });
    handle('tinygpt:secret-delete', async input => { await store.deleteSecret(secretSlotSchema.parse(input)); const next = snapshot(); broadcast('tinygpt:settings-update', next); return next; });
    handle('tinygpt:connection', async input => {
      const route = routeSchema.parse(input);
      const settings = store.getSettings();
      if (route === 'local' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(settings.local.endpoint).hostname)) {
        const connection = await inspectLocal(settings, settings.local.endpoint, store.getSecret('local'));
        const selected = connection.models.find(model => model.id === settings.local.model);
        return { reachable: true, modelAvailable: !!selected, models: connection.models.map(model => model.id), modelDetails: connection.models, modelContextWindowTokens: selected?.contextWindowTokens,
          message: !settings.local.model ? 'Connected. Choose a model to continue.' : selected ? 'Connected. Your selected model is available.' : 'Connected, but the selected model was not in the model list.' };
      }
      return checkConnection(settings, route, store.getSecret(route));
    });
    const inferenceChanged = () => { const settings = store.getSettings(); warmChatRuntime(settings.route === 'local' ? settings.local.model : settings.byok.model); const value = snapshot(); broadcast('tinygpt:settings-update', value); void botService.connectionChanged(); return value; };
    let startingBuiltIn: BuiltInModelId | undefined;
    const warmingModels = new Map<BuiltInModelId, Promise<void>>();
    let modelWarmQueue = Promise.resolve();
    const residency = new ModelResidency(Object.fromEntries((['included', 'pro'] as const).map(id => [id, {
      loaded: () => builtIns[id].status().phase === 'running',
      busy: () => warmingModels.has(id) || !!localOperations.get(id) || chat.usesOwnedModel(id) || dictation.isActive() && store.getSettings().route === 'local' && builtInModelId(store.getSettings().local.model) === id,
      unload: () => builtIns[id].stop(),
    }])), () => store.getSettings().modelResidency ?? {});
    const residencyTimer = setInterval(() => { void residency.tick().catch(() => {}); }, 5000); residencyTimer.unref();
    app.once('before-quit', () => clearInterval(residencyTimer));
    let builtInGeneration = 0;
    const stopBuiltIn = async (id: BuiltInModelId) => {
      chat.assertIdle();
      if (startingBuiltIn === id) builtInGeneration++;
      await builtIns[id].stop();
      return inferenceChanged();
    };
    const startBuiltIn = async (id: BuiltInModelId, speculative = id === 'pro' && store.getSettings().builtIn.proMtp, authorized = () => {}) => {
      if (startingBuiltIn) throw new Error('Finish the current built-in setup first.');
      chat.assertIdle();
      startingBuiltIn = id;
      const generation = ++builtInGeneration;
      const ensureCurrent = () => { authorized(); if (generation !== builtInGeneration) throw new Error('Setup canceled.'); };
      try {
        if (id === 'pro' && !(await scanBuiltInHardware()).proCompatible) throw new Error('Pro compatibility could not be confirmed on this device.');
        ensureCurrent();
        await builtIns[id === 'pro' ? 'included' : 'pro'].stop();
        ensureCurrent();
        const { endpoint, key } = await builtIns[id].start(speculative);
        ensureCurrent();
        const model = builtInModelInfo(id);
        const existing = store.inferenceConnections().find(item => item.route === 'local' && builtInModelId(item.config.model) === id);
        await store.addInferenceConnection(withModel(store.getSettings(), 'local', model, endpoint), 'local', key, existing?.id, model.name);
        return inferenceChanged();
      } finally { startingBuiltIn = undefined; }
    };
    const warmModel = async (requestedId?: BuiltInModelId) => {
      memory?.warm();
      const settings = store.getSettings(), id = requestedId ?? (settings.route === 'local' ? builtInModelId(settings.local.model) : undefined);
      if (!id) return;
      await residency.ready(id);
      if (builtIns[id].status().phase === 'running') return;
      let task = warmingModels.get(id);
      if (!task) {
        task = modelWarmQueue.catch(() => {}).then(async () => {
          if (!(await builtIns[id].installedStatus()).installed) throw Error('Set up this built-in model in Configuration first.');
          const other = id === 'pro' ? 'included' : 'pro';
          if (builtIns[other].status().phase === 'running' && (chat.usesOwnedModel(other) || localOperations.get(other))) throw Error('Wait for the current local conversation before loading another model.');
          await builtIns[other].stop();
          const result = await builtIns[id].start(id === 'pro' && store.getSettings().builtIn.proMtp);
          const connection = store.inferenceConnections().find(item => item.route === 'local' && builtInModelId(item.config.model) === id);
          if (!connection) throw Error('Select this model in Configuration first.');
          await store.refreshOwnedLocal(connection.id, result.endpoint, result.key);
          broadcast('tinygpt:settings-update', snapshot());
        }).finally(() => { warmingModels.delete(id); residency.touch(id); });
        modelWarmQueue = task;
        warmingModels.set(id, task);
      }
      await task;
    };
    handle('tinygpt:model-warm', () => warmModel());
    prepareLocalExecution = async (input, signal) => {
      const id = input.route === 'local' ? builtInModelId(input.model) : undefined; if (!id) return;
      signal.throwIfAborted(); await warmModel(id); signal.throwIfAborted();
      const connection = store.inferenceConnections().find(item => item.route === 'local' && builtInModelId(item.config.model) === id);
      if (connection) { input.endpoint = connection.config.endpoint; input.secret = store.connectionSecret(connection.id); }
    };
    chat.prepareRun = async (input, signal, activity) => {
      const pendingSources = input.conversationId ? history.sources.messageSources(input.conversationId, history.conversation(input.conversationId).messages.filter(message => message.role === 'user').at(-1)?.id ?? '').filter(source => source.processing?.status === 'preparing') : [];
      if (pendingSources.length) {
        await activity('Preparing your documents…', () => ingestion.wait(pendingSources.map(source => source.id), signal));
        for (const source of pendingSources) for (const message of input.messages) message.text = message.text.replace(sourceManifest([source]), sourceManifest([history.sources.detail(input.conversationId!, source.id)]));
      }
      if (input.route !== 'local' || !builtInModelId(input.model)) return;
      signal.throwIfAborted();
      const id = builtInModelId(input.model)!; residency.touch(id);
      if (builtIns[id].status().phase !== 'running') await activity(`Loading ${builtInModels[id].name}…`, () => warmModel(id));
      signal.throwIfAborted();
      const connection = store.inferenceConnections().find(item => item.route === 'local' && builtInModelId(item.config.model) === id);
      if (connection) { input.endpoint = connection.config.endpoint; input.secret = store.connectionSecret(connection.id); }
    };
    remote!.setWarmModel(() => warmModel());
    const connectionCatalog = async (id: string) => {
      const connection = store.connection(id);
      const builtIn = connection.route === 'local' && builtInModelId(connection.config.model);
      if (builtIn) {
        const installed = (await builtIns[builtIn].installedStatus()).installed && (builtIn !== 'pro' || (await scanBuiltInHardware()).proCompatible);
        const model = builtInModelInfo(builtIn);
        return { reachable: !!installed, modelAvailable: !!installed, models: installed ? [model.id] : [], modelDetails: installed ? [model] : [], message: installed ? 'Available on this device.' : 'Set up this built-in model in Configuration.' };
      }
      const settings = connectionSettings(store.getSettings(), connection);
      const secret = store.connectionSecret(id);
      if (connection.route === 'local' && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connection.config.endpoint).hostname)) {
        const found = await inspectLocal(settings, connection.config.endpoint, secret);
        return { reachable: true, modelAvailable: found.models.some(item => item.id === connection.config.model), models: found.models.map(item => item.id), modelDetails: found.models, message: 'Connected.' };
      }
      return checkConnection(settings, connection.route, secret);
    };
    handle('tinygpt:inference-models', async input => {
      const id = z.uuid().parse(input); const connection = store.connection(id);
      const report = await connectionCatalog(id);
      const selected = report.modelDetails?.find(item => item.id === connection.config.model);
      if (selected && await store.refreshInferenceCapabilities(connection, selected)) inferenceChanged();
      return report;
    });
    const selectConnectionModel = async (id: string, modelId: string, authorized = () => {}) => {
      authorized();
      const connection = store.connection(id); const secret = store.connectionSecret(id); const policy = store.getSettings().openrouter;
      const builtIn = connection.route === 'local' && builtInModelId(connection.config.model);
      if (builtIn) {
        if (builtInModelId(modelId) !== builtIn) throw new Error('This built-in model is unavailable.');
        return startBuiltIn(builtIn, undefined, authorized);
      }
      const catalog = await connectionCatalog(id);
      const model = catalog.modelDetails?.find(item => item.id === modelId);
      if (!model) throw new Error('This model is unavailable. Choose another model.');
      const latestConnection = store.connection(id);
      const { modelCapabilities: _previousCapabilities, ...previousConfig } = connection.config;
      const { modelCapabilities: _latestCapabilities, ...latestConfig } = latestConnection.config;
      if (JSON.stringify([connection.route, previousConfig]) !== JSON.stringify([latestConnection.route, latestConfig]) || secret !== store.connectionSecret(id) || connection.route === 'byok' && connection.config.provider === 'openrouter' && JSON.stringify(policy) !== JSON.stringify(store.getSettings().openrouter)) throw new Error('Your connection changed. Choose the model again.');
      const settings = connectionSettings(store.getSettings(), connection);
      const next = withModel(settings, connection.route, { ...model, tools: model.tools ?? connection.config.tools, images: model.images ?? connection.config.images });
      authorized();
      await store.activateInferenceConnection(id, next); return inferenceChanged();
    };
    handle('tinygpt:inference-model', async input => {
      const { id, model } = z.object({ id: z.uuid(), model: z.string().min(1).max(300) }).strict().parse(input);
      return selectConnectionModel(id, model);
    });
    remote.setInference({
      state: () => {
        const settings = store.getSettings(), config = settings.route === 'portal' ? undefined : settings[settings.route];
        return { connectionId: store.activeConnectionId(), model: config?.model ?? '', name: config ? modelDisplayName({ id: config.model, name: config.modelCapabilities?.model === config.model ? config.modelCapabilities.name : undefined }, settings.route === 'byok' && settings.byok.provider === 'openrouter').slice(0,300) : '', effort: { chat: settings.effort.chat, code: settings.effort.code }, connections: store.inferenceConnections().filter(item => item.connected).map(item => ({ id: item.id, name: item.name.slice(0,200), provider: item.route === 'local' ? 'local' as const : item.config.provider, ...(item.route === 'local' && builtInModelId(item.config.model) ? { builtIn: builtInModelId(item.config.model) } : {}) })) };
      },
      models: async id => {
        const connection = store.inferenceConnections().find(item => item.id === id && item.connected);
        if (!connection) throw Error('Connection unavailable.');
        const catalog = await connectionCatalog(id);
        return { models: (catalog.modelDetails ?? catalog.models.map(id => ({ id }))).slice(0,1000).map(item => ({ id: item.id, name: modelDisplayName(item, connection.route === 'byok' && connection.config.provider === 'openrouter').slice(0,300) })) };
      },
      select: (id, model, authorized) => selectConnectionModel(id, model, () => { authorized(); chat.assertIdle(); }),
      effort: async (mode, effort, authorized) => { authorized(); const settings = store.getSettings(); await store.saveSettings({ ...settings, effort: { ...settings.effort, [mode]: effort } }); broadcast('tinygpt:settings-update', snapshot()); },
    });
    handle('tinygpt:inference-activate', async input => { const id = z.uuid().parse(input), connection = store.connection(id), builtIn = connection.route === 'local' && builtInModelId(connection.config.model); if (builtIn) return startBuiltIn(builtIn); await store.activateInferenceConnection(id); return inferenceChanged(); });
    handle('tinygpt:inference-remove', async input => { await store.removeInferenceConnection(z.uuid().parse(input)); return inferenceChanged(); });
    let connectingOpenRouter = false;
    handle('tinygpt:inference-cancel', () => inferenceSignIn.cancel());
    handle('tinygpt:openrouter-connect', async () => {
      if (!store.secureStorageAvailable()) throw new Error('Secure credential storage is unavailable on this computer.');
      if (connectingOpenRouter) throw new Error('Finish the current OpenRouter sign-in first.');
      connectingOpenRouter = true;
      try {
        const key = await inferenceSignIn.connect();
        const account = await openRouterAccount(key);
        inferenceSignIn.assertNotCanceled();
        const current = store.getSettings();
        const existing = store.inferenceConnections().find(item => item.route === 'byok' && item.config.provider === 'openrouter');
        await store.addInferenceConnection({ ...current, route: 'byok', openrouter: { ...current.openrouter, access: account.recommendedAccess }, byok: { provider: 'openrouter', protocol: 'openai-compatible', endpoint: 'https://openrouter.ai/api/v1', model: '', tools: false, images: false } }, 'byok', key, existing?.id);
        inferenceSignIn.complete(true); return inferenceChanged();
      } catch (error) { inferenceSignIn.complete(false); throw error; }
      finally { connectingOpenRouter = false; }
    });
    handle('tinygpt:openrouter-account', async () => {
      const connection = store.inferenceConnections().find(item => item.route === 'byok' && item.config.provider === 'openrouter');
      const key = connection && store.connectionSecret(connection.id);
      if (!key || !connection) throw new Error('Connect OpenRouter first.');
      const account = await openRouterAccount(key);
      if (key !== store.connectionSecret(connection.id)) throw new Error('Your connection changed. Open it again.');
      return account;
    });
    handle('tinygpt:openrouter-preferences', async input => { await store.saveOpenRouterPreferences(settingsSchema.shape.openrouter.parse(input)); return inferenceChanged(); });
    handle('tinygpt:inference-key', async input => {
      const parsed = z.object({ id: z.uuid().optional(), provider: settingsSchema.shape.byok.shape.provider, protocol: settingsSchema.shape.byok.shape.protocol, endpoint: settingsSchema.shape.byok.shape.endpoint, key: z.string().trim().min(1).max(8192) }).strict().parse(input);
      if (!store.secureStorageAvailable()) throw new Error('Secure credential storage is unavailable on this computer.');
      if (parsed.id) {
        const existing = store.connection(parsed.id);
        if (existing.route !== 'byok' || existing.config.provider !== parsed.provider) throw new Error('Add a new connection for a different provider.');
      }
      const current = store.getSettings();
      const byok = { provider: parsed.provider, protocol: parsed.protocol, endpoint: parsed.endpoint, model: '', tools: parsed.provider !== 'custom', images: false };
      const account = parsed.provider === 'openrouter' ? await openRouterAccount(parsed.key) : undefined;
      await checkConnection({ ...current, byok }, 'byok', parsed.key);
      const latest = store.getSettings();
      const existingRouter = parsed.provider === 'openrouter' ? store.inferenceConnections().find(item => item.route === 'byok' && item.config.provider === 'openrouter') : undefined;
      await store.addInferenceConnection({ ...latest, route: 'byok', byok, openrouter: account ? { ...latest.openrouter, access: account.recommendedAccess } : latest.openrouter }, 'byok', parsed.key, parsed.id ?? existingRouter?.id);
      return inferenceChanged();
    });
    handle('tinygpt:inference-disconnect', async input => {
      const route = z.enum(['byok', 'local']).parse(input);
      const connected = store.inferenceConnections().find(item => item.route === route && (route === 'local' ? item.config.endpoint === store.getSettings().local.endpoint : item.id === store.activeConnectionId()));
      if (connected) { await store.removeInferenceConnection(connected.id); return inferenceChanged(); }
      await store.deleteSecret(route);
      const current = store.getSettings();
      const other = route === 'local' ? 'byok' : 'local';
      await store.saveSettings({ ...current, route: current.route === route && current[other].model && (other === 'local' || store.getSecret('byok')) ? other : current.route,
        [route]: { ...current[route], model: '', modelCapabilities: undefined, reasoningOverride: undefined, contextWindowTokens: undefined, maxOutputTokens: undefined, tools: false, images: false } });
      return inferenceChanged();
    });
    handle('tinygpt:managed-local-status', () => managedLocal.status());
    handle('tinygpt:managed-local-stop', async () => { await stopBuiltIn('included'); });
    handle('tinygpt:managed-local-start', async input => {
      return startBuiltIn('included', z.boolean().default(false).parse(input));
    });
    handle('tinygpt:built-in-hardware', () => scanBuiltInHardware());
    const configurationMonitor = new ConfigurationMonitor(() => {
      const modelComponent = (id: BuiltInModelId, model: ManagedLocalModel): MonitorComponent => {
        const pid = model.processId(), phase = model.status().phase;
        const settings = store.getSettings();
        return { id, name: id === 'pro' ? 'TinyGPT Pro' : 'TinyGPT', pids: pid ? [pid] : [], state: phase === 'running' ? settings.route === 'local' && builtInModelId(settings.local.model) === id ? 'Active' : 'Loaded' : phase === 'idle' ? 'Not loaded' : phase === 'error' ? 'Needs attention' : 'Setting up' };
      };
      const components: MonitorComponent[] = [modelComponent('included', managedLocal), modelComponent('pro', managedPro)];
      const vision = broker.localVision?.status();
      components.push({ id: 'vision', name: 'Image understanding', pids: vision?.processId ? [vision.processId] : [], state: vision?.loaded ? 'Loaded' : 'On demand' });
      const voice = pocket.processIds(); components.push({ id: 'voice', name: 'Read aloud', pids: voice, state: voice.length ? 'Loaded' : 'On demand' });
      const groups = new Map<string, MonitorComponent>();
      for (const metric of app.getAppMetrics()) {
        const name = /retrieval/i.test(metric.name ?? '') ? 'Memory & search' : /moonshine|dictation/i.test(metric.name ?? '') ? 'Dictation' : 'App & background services';
        const group = groups.get(name) ?? { id: name, name, pids: [], state: 'Running', memoryBytes: 0 };
        group.pids.push(metric.pid); group.memoryBytes! += metric.memory.workingSetSize * 1024;
        groups.set(name, group);
      }
      return [...components, ...groups.values()];
    });
    handle('tinygpt:configuration-monitor', () => configurationMonitor.sample());
    handle('tinygpt:built-in-status', async () => ({ included: await managedLocal.installedStatus(), pro: await managedPro.installedStatus(store.getSettings().builtIn.proMtp) }));
    handle('tinygpt:built-in-start', input => startBuiltIn(z.enum(['included', 'pro']).parse(input)));
    handle('tinygpt:built-in-stop', input => stopBuiltIn(z.enum(['included', 'pro']).parse(input)));
    handle('tinygpt:local-scan', async () => {
      const settings = store.getSettings();
      const candidates = [...new Set([...(await localCandidates(settings.local.endpoint)), ...store.inferenceConnections().filter(item => item.route === 'local').map(item => item.config.endpoint)])];
      const discovered = await discoverLocal(settings, candidates, store.getSecret('local'), fetch, endpoint => {
        const connection = store.inferenceConnections().find(item => item.route === 'local' && item.config.endpoint === endpoint);
        return connection ? store.connectionSecret(connection.id) : endpoint === settings.local.endpoint ? store.getSecret('local') : undefined;
      });
      return { ...discovered, connections: discovered.connections.filter(connection => !connection.models.some(model => builtInModelId(model.id))) };
    });
    handle('tinygpt:local-use', async input => {
      const selected = z.object({ endpoint: z.string().max(2048), model: z.string().min(1).max(200) }).strict().parse(input);
      if (builtInModelId(selected.model)) return startBuiltIn(builtInModelId(selected.model)!);
      const current = store.getSettings();
      const existing = store.inferenceConnections().find(item => item.route === 'local' && item.config.endpoint === selected.endpoint);
      const secret = existing ? store.connectionSecret(existing.id) : selected.endpoint === current.local.endpoint ? store.getSecret('local') : undefined;
      const found = await inspectLocal(current, selected.endpoint, secret);
      const model = found.models.find(item => item.id === selected.model);
      if (!model) throw new Error('This local model is no longer available. Scan again.');
      await store.addInferenceConnection(withModel(store.getSettings(), 'local', model, found.endpoint), 'local', secret, existing?.id, found.name); return inferenceChanged();
    });
    handle('tinygpt:openrouter-model', async input => {
      const id = z.string().min(1).max(200).parse(input); const current = store.getSettings();
      if (current.byok.provider !== 'openrouter') throw new Error('Connect OpenRouter first.');
      const catalog = await checkConnection(current, 'byok', store.getSecret('byok'));
      const model = catalog.modelDetails?.find(item => item.id === id);
      if (!model) throw new Error('This model is unavailable for your access and privacy settings. Choose another model.');
      const latest = store.getSettings();
      if (JSON.stringify([latest.byok, latest.openrouter]) !== JSON.stringify([current.byok, current.openrouter])) throw new Error('Your connection changed. Choose the model again.');
      await store.saveSettings(withModel(latest, 'byok', model)); return inferenceChanged();
    });
    handle('tinygpt:library', () => chat.library());
    handle('tinygpt:profile-usage', () => history.profileUsage());
    handle('tinygpt:outputs', () => history.outputs());
    const libraryFiles = new LibraryFiles(history), librarySource = (id: string) => libraryFiles.detail(id);
    handle('tinygpt:library-search', input => libraryFiles.search(z.string().max(500).parse(input)));
    handle('tinygpt:source-exclude', input => { const args = z.object({ id: idSchema, excluded: z.boolean() }).strict().parse(input); chat.assertIdle(); libraryFiles.exclude(args.id, args.excluded); memoryChanged(); remote?.refreshLibraries(); });
    handle('tinygpt:library-source', input => librarySource(idSchema.parse(input)));
    handle('tinygpt:source-retry', input => { const id = idSchema.parse(input), source = librarySource(id); if (!source.conversationId || !source.originalAvailable) throw Error('The original file is unavailable.'); ingestion.retry(source.conversationId, id); });
    handle('tinygpt:source-download', async input => {
      const id = idSchema.parse(input), source = librarySource(id);
      const selected = await dialog.showSaveDialog((window ?? chatWindow.window)!, { title: 'Save file', defaultPath: source.originalAvailable || source.linkedFile ? source.title : source.title.replace(/\.[^.]+$/, '') + '.txt' });
      if (selected.canceled || !selected.filePath) return;
      const bytes = await libraryFiles.bytes(id);
      await (await import('node:fs/promises')).writeFile(selected.filePath, bytes);
    });
    handle('tinygpt:library-source-remove', input => { const id = idSchema.parse(input), source = librarySource(id); chat.assertIdle(); if (source.conversationId) history.sources.remove(source.conversationId, id); else history.memory.remove(id); memoryChanged(); remote?.refreshLibraries(); });
    handle('tinygpt:source-reuse', async input => {
      const { id, conversationId } = z.object({ id: idSchema, conversationId: idSchema }).strict().parse(input); chat.assertIdle(conversationId);
      const source = librarySource(id), drafts = history.sources.list(conversationId, false).filter(item => !item.messageId && ['attachment', 'image', 'folder', 'conversation'].includes(item.kind));
      if (drafts.length >= 8) throw Error('Choose up to eight distinct attachments.');
      if (source.originalAvailable || source.linkedFile) {
        const bytes = await libraryFiles.bytes(id); chat.assertIdle(conversationId);
        if (history.sources.list(conversationId, false).filter(item => !item.messageId && ['attachment', 'image', 'folder', 'conversation'].includes(item.kind)).length >= 8) throw Error('Choose up to eight distinct attachments.');
        ingestion.upload(conversationId, source.title, bytes, source.image ? { image: source.image, mime: source.mime } : undefined);
      } else history.sources.add(conversationId, { kind: 'attachment', title: source.title, text: source.text, mime: 'text/plain' });
      toolUpdate(conversationId);
    });
    handle('tinygpt:conversation-usage', input => history.conversationUsage(idSchema.parse(input)));
    handle('tinygpt:help', async input => { const page = z.enum(['about', 'privacy', 'terms']).parse(input); await shell.openExternal({ about: 'https://tinygpt.org', privacy: 'https://tinygpt.org/privacy-policy', terms: 'https://tinygpt.org/terms-of-service' }[page]); });
    handle('tinygpt:conversation-organize', async input => {
      const action = conversationOrganizeSchema.parse(input); chat.assertIdle(action.id);
      if (action.action === 'move') { browser.closeConversation(action.id); await terminals.closeConversation(action.id); chat.assertIdle(action.id); }
      history.organizeConversation(action); toolUpdate(action.id); return chat.library();
    });
    handle('tinygpt:conversation-create', async input => { const conversation = history.createConversation(createConversationSchema.parse(input).projectId, store.getSettings().mode === 'code' ? 'code' : 'chat'); await plugins.store.captureSelection(conversation.id, conversation.projectId); return conversation; });
    handle('tinygpt:code-changes', input => history.codeChanges(idSchema.parse(input)));
    handle('tinygpt:code-undo', async input => { const { conversationId, changeId } = z.object({ conversationId: idSchema, changeId: idSchema }).strict().parse(input); chat.assertIdle(conversationId); await broker.code.undo(conversationId, changeId); toolUpdate(conversationId); return history.codeChanges(conversationId); });
    handle('tinygpt:conversation', input => { const id = idSchema.parse(input); const conversation = history.selectConversation(id); if (conversation.mode === 'bot') void botService.warm(); chat.describe(id); return conversation; });
    handle('tinygpt:conversation-read', input => { const { id, messageId } = z.object({ id: idSchema, messageId: idSchema }).strict().parse(input); history.markConversationRead(id, messageId); notifications?.readConversation(id, messageId); return chat.library(); });
    handle('tinygpt:conversation-rename', input => {
      const { id, title } = renameConversationSchema.parse(input);
      history.renameConversation(id, title); toolUpdate(id); return chat.library();
    });
    handle('tinygpt:conversation-delete', async input => {
      await deleteSavedConversation(idSchema.parse(input)); return chat.library();
    });
    handle('tinygpt:connector-dismiss', input => { const { conversationId, requestId } = z.object({ conversationId: z.uuid(), requestId: z.uuid() }).strict().parse(input); chat.assertIdle(conversationId); plugins.finishConnectionRequest(conversationId, requestId, 'dismissed'); return chat.update(conversationId); });
    handle('tinygpt:connector-resume', input => plugins.track(async () => {
      const { conversationId, requestId, pluginId } = z.object({ conversationId: z.uuid(), requestId: z.uuid(), pluginId: z.uuid() }).strict().parse(input); chat.assertIdle(conversationId); const original = plugins.connectionRequest(conversationId, requestId);
      const messageId = await plugins.acceptConnection(conversationId, requestId, pluginId); chat.assertIdle(conversationId); plugins.finishConnectionRequest(conversationId, requestId, 'connected');
      try { return chat.start(conversationId, null, [], { type: 'resume-plugin', messageId }); } catch (error) { history.finishTool(requestId, 'success', JSON.stringify(original.request)); plugins.notifyChanged(); throw error; }
    }));
    handle('tinygpt:chat-send', async input => { const { conversationId, text, attachmentIds } = sendMessageSchema.parse(input); return chat.send(conversationId, text, attachmentIds, conversationId === chatWindow.state.conversationId); });
    handle('tinygpt:chat-queue', input => chat.queueAction(queueActionSchema.parse(input)));
    handle('tinygpt:bot-react', input => { const value = botReactionSchema.parse(input); return chat.reactToMessage(value.conversationId, value.messageId, value.emoji); });
    handle('tinygpt:chat-retry', input => chat.start(idSchema.parse(input), null));
    handle('tinygpt:message-edit', input => { const { conversationId, messageId, text } = editMessageSchema.parse(input); return chat.edit(conversationId, messageId, text); });
    handle('tinygpt:message-regenerate', input => { const { conversationId, messageId } = messageActionSchema.parse(input); return chat.start(conversationId, null, [], { type: 'regenerate', messageId }); });
    handle('tinygpt:message-continue', input => { const { conversationId, messageId } = messageActionSchema.parse(input); return chat.start(conversationId, null, [], { type: 'continue', messageId }); });
    handle('tinygpt:branch-select', input => { const { conversationId, messageId } = messageActionSchema.parse(input); chat.assertIdle(conversationId); history.selectBranch(conversationId, messageId); chat.describe(conversationId); const update = chat.update(conversationId); broadcast('tinygpt:chat-update', update); return update; });
    handle('tinygpt:reply-discard', input => { const { conversationId, messageId } = messageActionSchema.parse(input); chat.assertIdle(conversationId); history.discardReply(conversationId, messageId); return chat.update(conversationId); });
    handle('tinygpt:chat-cancel', input => chat.cancel(idSchema.parse(input)));
    handle('tinygpt:message-export', async input => {
      const { conversationId, messageId } = z.object({ conversationId: idSchema, messageId: idSchema }).strict().parse(input);
      const conversation = history.conversation(conversationId);
      const message = conversation.messages.find(item => item.id === messageId && item.role === 'assistant');
      if (!message || message.status === 'streaming') throw new Error('There is no completed answer to export.');
      const filename = (conversation.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 60) || 'TinyGPT answer') + '.md';
      const choice = await dialog.showSaveDialog((window ?? chatWindow.window)!, { title: 'Export answer', defaultPath: filename, filters: [{ name: 'Markdown', extensions: ['md'] }] });
      if (choice.canceled || !choice.filePath) return false;
      await writeFile(choice.filePath, `# ${conversation.title}\n\n${answerMarkdown(message.text, conversation.tools.filter(tool => tool.runId === message.runId))}\n`, 'utf8');
      return true;
    });
    handle('tinygpt:project-folder-choice', async () => {
      const selected = await dialog.showOpenDialog((window ?? chatWindow.window)!, { title: 'Choose Project folder', properties: ['openDirectory'] });
      if (selected.canceled || !selected.filePaths[0]) return null;
      const path = await realpath(selected.filePaths[0]); if (!(await stat(path)).isDirectory()) throw new Error('Invalid folder.');
      for (const [id, choice] of projectFolderChoices) if (choice.expires < Date.now()) projectFolderChoices.delete(id);
      if (projectFolderChoices.size >= 32) projectFolderChoices.delete(projectFolderChoices.keys().next().value!);
      const id = randomUUID(); projectFolderChoices.set(id, { path, expires: Date.now() + 1800000 }); return { id, path };
    });
    handle('tinygpt:project-create', async input => {
      const { name, instructions, browserIsolated, folderChoiceId } = projectInputSchema.parse(input);
      const choice = folderChoiceId ? projectFolderChoices.get(folderChoiceId) : undefined;
      if (folderChoiceId && (!choice || choice.expires < Date.now())) throw new Error('Choose the Project folder again.');
      if (choice && !(await stat(choice.path)).isDirectory()) throw new Error('Invalid folder.');
      const project = history.createProject(name, instructions, browserIsolated, choice?.path ?? null);
      indexer.refreshEnabled(); memoryChanged();
      browserProfiles!.register(`persist:tinygpt-browser-${project.id}`);
      if (folderChoiceId) projectFolderChoices.delete(folderChoiceId); return project;
    });
    handle('tinygpt:project-update', async input => {
      const { id, name, instructions, browserIsolated, folderChoiceId } = updateProjectSchema.parse(input);
      const current = history.project(id); chat.assertProjectIdle(id);
      const choice = folderChoiceId ? projectFolderChoices.get(folderChoiceId) : undefined;
      if (folderChoiceId && (!choice || choice.expires < Date.now())) throw new Error('Choose the Project folder again.');
      if (choice && !(await stat(choice.path)).isDirectory()) throw new Error('Invalid folder.');
      const rootPath = folderChoiceId === null ? null : choice?.path;
      if (rootPath !== undefined && rootPath !== current.rootPath) {
        await indexer.cancel(id); chat.assertProjectIdle(id);
        await Promise.all(history.conversations().filter(chat => chat.projectId === id).map(chat => terminals.closeConversation(chat.id)));
      }
      chat.assertProjectIdle(id); history.updateProject(id, name, instructions, browserIsolated, rootPath);
      indexer.refreshEnabled();
      if (folderChoiceId) projectFolderChoices.delete(folderChoiceId);
      memoryChanged(); return chat.library();
    });
    handle('tinygpt:project-organize', async input => {
      const action = projectOrganizeSchema.parse(input); history.project(action.id);
      if (action.action !== 'favorite') chat.assertProjectIdle(action.id);
      const chats = history.conversations().filter(chat => chat.projectId === action.id);
      if (action.action === 'remove') {
        await indexer.cancel(action.id); chat.assertProjectIdle(action.id);
        for (const item of chats) { browser.closeConversation(item.id); workspaceFiles.closeConversation(item.id); }
        await Promise.all(chats.map(item => terminals.closeConversation(item.id))); chat.assertProjectIdle(action.id);
      }
      history.organizeProject(action); memoryChanged();
      for (const item of chats) toolUpdate(item.id);
      return chat.library();
    });
    handle('tinygpt:project-folder', async input => {
      const id = idSchema.parse(input); history.project(id); chat.assertProjectIdle(id);
      const selected = await dialog.showOpenDialog((window ?? chatWindow.window)!, { title: 'Choose Project folder', properties: ['openDirectory'] });
      if (selected.canceled || !selected.filePaths[0]) return history.project(id);
      chat.assertProjectIdle(id);
      const canonicalPath = await realpath(selected.filePaths[0]);
      if (!(await stat(canonicalPath)).isDirectory()) throw new Error('Invalid folder.');
      await indexer.cancel(id); chat.assertProjectIdle(id);
      await Promise.all(history.conversations().filter(chat=>chat.projectId===id).map(chat=>terminals.closeConversation(chat.id))); chat.assertProjectIdle(id);
      const project = history.setProjectFolder(id, canonicalPath); indexer.refreshEnabled(); memoryChanged(); return project;
    });
    handle('tinygpt:attachments', async (input, owner) => { const id = idSchema.parse(input); chat.assertIdle(id); history.conversation(id); await chooseAttachments(owner!, id, history.sources); return chat.update(id); });
    handle('tinygpt:attachment-folder', async (input, owner) => { const id = idSchema.parse(input); chat.assertIdle(id); history.conversation(id); await chooseAttachmentFolder(owner!, id, history.sources); return chat.update(id); });
    handle('tinygpt:conversation-link', input => { const { conversationId, targetId } = z.object({ conversationId: idSchema, targetId: idSchema }).strict().parse(input); chat.assertIdle(conversationId); history.linkConversation(conversationId, targetId); return chat.update(conversationId); });
    handle('tinygpt:image-models', input => imageGeneration.models(input === true));
    handle('tinygpt:image-model-select', async input => { const value = z.object({approvalId:idSchema, selection:imageSelectionSchema}).strict().parse(input); await broker.chooseImageModel(value.approvalId,value.selection); broadcast('tinygpt:settings-update',snapshot()); return chat.library(); });
    handle('tinygpt:image-action', async (input, owner) => {
      const value=imageActionSchema.parse(input); if(value.action==='cancel'){imageGeneration.cancel(value.jobId);return null;}
      const source=imageGeneration.source(value.conversationId,value.sourceId);
      if(value.action==='copy'){await clipboard.write([new ClipboardItem({'image/png':new Blob([Uint8Array.from(nativeImage.createFromDataURL(source.image!).toPNG())],{type:'image/png'})})]);return true;}
      if(value.action==='download'){const result=await dialog.showSaveDialog(owner!,{title:'Save image',defaultPath:source.title.replace(/[<>:\x22/\\|?*]/g,'-')+'.png',filters:[{name:'PNG image',extensions:['png']}]});if(result.canceled||!result.filePath)return false;await writeFile(result.filePath,nativeImage.createFromDataURL(source.image!).toPNG());return true;}
      if(value.action==='save')return imageGeneration.saveMarkup(value.conversationId,value.sourceId,value.image,value.label);
      if(value.action==='resize')return imageGeneration.resize(value.conversationId,value.sourceId,value.width,value.height);
      if(value.action!=='edit')return null;
      const updated=await imageGeneration.edit(value);broadcast('tinygpt:settings-update',snapshot());return updated;
    });
    handle('tinygpt:tool-preview', input => { const value = z.object({conversationId:idSchema,toolId:idSchema}).strict().parse(input); return toolPreview(history,value.conversationId,value.toolId); });
    handle('tinygpt:source', input => { const { conversationId, sourceId } = sourceActionSchema.parse(input); return history.sources.detail(conversationId, sourceId); });
    handle('tinygpt:source-remove', input => { const { conversationId, sourceId } = sourceActionSchema.parse(input); chat.assertIdle(conversationId); history.sources.remove(conversationId, sourceId); return chat.update(conversationId); });
    handle('tinygpt:source-search', input => { const { conversationId, query } = sourceSearchSchema.parse(input); return memory.search(conversationId, query); });
    handle('tinygpt:approve-tool', async input => { const { id, decision } = approvalResponseSchema.parse(input); if (!await botService.approve(id, decision)) broker.respond(id, decision); return chat.library(); });
    handle('tinygpt:work-answer', input => chat.answerWorkQuestion(input));
    handle('tinygpt:work-question-cancel', input => chat.cancelWorkQuestion(z.object({ questionId: z.uuid() }).strict().parse(input).questionId));
    handle('tinygpt:web-search', input => { const { conversationId, query, engine } = manualSearchSchema.parse(input); return broker.userSearch(conversationId, query, engine); });
    handle('tinygpt:page-read', input => { const { conversationId, url } = manualPageSchema.parse(input); return broker.userPage(conversationId, url); });
    handle('tinygpt:browser-reveal', (input, owner) => { const { conversationId, tabId } = z.object({ conversationId: idSchema, tabId: idSchema }).strict().parse(input); if (owner === chatWindow.window) chatWindow.dock({ workspace: { panel: 'web' } }); browser.reveal(conversationId, tabId); });
    handle('tinygpt:browser-resume', input => { browser.resume(idSchema.parse(input)); });
    handle('tinygpt:browser-cancel', input => { broker.cancelManual(idSchema.parse(input)); });
    createWindow();
    void (async () => {
      const saved = store.getSettings(), active = store.activeConnectionId();
      const selectedBuiltIn = saved.route === 'local' && builtInModelId(saved.local.model);
      const restorePro = selectedBuiltIn === 'pro' && (await managedPro.installedStatus()).installed && (await scanBuiltInHardware()).proCompatible;
      await startBuiltIn(restorePro ? 'pro' : 'included');
      if (!selectedBuiltIn && active) await store.activateInferenceConnection(active, saved);
      broadcast('tinygpt:settings-update', snapshot());
      const selected = history.lastConversationId(); if (selected) chat.describe(selected);
    })().catch(error => console.error('Bundled local model:', error instanceof Error ? error.message : 'could not start'));
    app.on('activate', () => {
      if (quitting) return;
      if (!window || window.isDestroyed()) createWindow();
      revealWindow(window!, screen.getAllDisplays().map(display => display.workArea));
    });
  }).catch(error => {
    if (error?.code === 'MODEL_SETUP_CANCELED') { app.quit(); return; }
    if (error?.code === 'MODEL_SETUP_FAILED') { dialog.showErrorBox('TinyGPT setup', error.message); app.quit(); return; }
    dialog.showErrorBox('TinyGPT could not start', 'Saved settings, credentials, or the conversation library could not be loaded. Your files have been preserved.');
    app.quit();
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (quitting || !chat) return;
  event.preventDefault(); quitting = true;
  updates?.close();
  remote?.close();
  notifications?.close(); notificationDesktop?.close();
  broker.cancelManual();
  void Promise.resolve().then(() => scheduled?.shutdown()).then(() => chat.shutdown()).then(() => botService.shutdown()).then(() => broker.shutdown()).then(() => terminals.shutdown()).then(() => plugins.shutdown()).then(() => indexer.shutdown()).then(() => memory.shutdown()).then(() => browserProfiles?.flush()).finally(() => { closeChatRuntime(); diagnostics?.close(); history.close(); app.quit(); });
});



import type { InferenceRoute, Mode, SecretSlot, Settings } from './config';
import type { ChatProject, ChatUpdate, Conversation, LibrarySnapshot, ConversationOrganization, ProfileUsage, ConversationUsage } from './chat';
import type { PageSnapshot, SearchEngine, SourceDetail, SourceExcerpt, WebSearch } from './tools';
import type { BrowserHistoryEntry, BrowserLayout, BrowserRequest, BrowserState, WorkspaceFileRequest, WorkspaceFileResult } from './workspace';
import type { WorkspaceGitRequest, WorkspaceGitResult } from './workspace-git';
import type { MemoryInput, MemorySnapshot, StoredEvidence } from './memory';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type WindowState = { maximized: boolean; fullScreen: boolean };
export type ChatWindowState = { conversationId: string | null; returnedConversationId: string | null; settingsSection?: string; workspace?: { panel: 'sources' | 'web' | 'files'; sourceId?: string; url?: string } };
export type WindowAction = 'minimize' | 'maximize' | 'close';
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export interface AppSnapshot {
  onboarding?: import('./onboarding').OnboardingState;
  settings: Settings;
  secrets: Record<SecretSlot, boolean>;
  secureStorageAvailable: boolean;
  platform: string;
  version: string;
  inferenceConnections?: (import('./inference-connections').InferenceConnection & { connected: boolean })[];
  activeConnectionId?: string;
}
export interface ConnectionReport {
  reachable: boolean;
  modelAvailable: boolean;
  models: string[];
  message: string;
  modelContextWindowTokens?: number;
  modelDetails?: import('./effort').ModelInfo[];
}
export interface LocalDiscovery {
  connections: { endpoint: string; name: string; models: import('./effort').ModelInfo[] }[];
  unavailable: { endpoint: string; message: string }[];
}
export interface OpenRouterAccount {
  status: 'free' | 'funded' | 'exhausted' | 'unknown';
  recommendedAccess: 'free' | 'paid';
  balance?: number;
  keyRemaining?: number | null;
}

// Inference and harness are independent choices. Each adapter must declare
// capabilities for the selected provider/model before a run can start.
export interface Capabilities {
  text: boolean;
  tools: boolean;
  images: boolean;
  streaming: boolean;
}
export type RunEvent =
  | { type: 'started'; runId: string }
  | { type: 'text-delta'; runId: string; text: string }
  | { type: 'tool-request'; runId: string; callId: string; name: string; input: unknown }
  | { type: 'approval-required'; runId: string; approvalId: string; description: string }
  | { type: 'completed'; runId: string }
  | { type: 'cancelled'; runId: string }
  | { type: 'failed'; runId: string; message: string };
export interface HarnessAdapter {
  readonly mode: Mode;
  readonly upstream: 'librechat' | 'openclaw' | 'opencode';
  connect(): Promise<void>;
  capabilities(route: InferenceRoute): Promise<Capabilities>;
  run(input: { runId: string; sessionId: string; prompt: string; route: InferenceRoute; signal: AbortSignal }): AsyncIterable<RunEvent>;
  cancel(runId: string): Promise<void>;
  disconnect(): Promise<void>;
}

export interface DesktopBridge {
  updates?(): Promise<Result<import('./updates').UpdateState>>;
  updateAction?(action: import('./updates').UpdateAction): Promise<Result<import('./updates').UpdateState>>;
  onUpdateState?(listener: (state: import('./updates').UpdateState) => void): () => void;
  warmModel?(): Promise<Result<void>>;
  remoteAppearance(value: import('./remote').RemoteAppearance): Promise<Result<void>>;
  remoteStatus(): Promise<Result<import('./remote').RemoteStatus>>;
  remoteApprovePairing(id: string, allow: boolean): Promise<Result<import('./remote').RemoteStatus>>;
  remoteConfigure(value: import('./remote').RemotePreferences): Promise<Result<import('./remote').RemoteStatus>>;
  remoteCreateChat(): Promise<Result<Conversation>>;
  remotePair(conversationId: string, relayUrl?: string, scope?: import('./remote').RemoteScope): Promise<Result<import('./remote').RemoteInvitation>>;
  remoteSetScope(id: string, scope: import('./remote').RemoteScope): Promise<Result<import('./remote').RemoteStatus>>;
  remoteSetManagement(id:string,value:boolean):Promise<Result<import('./remote').RemoteStatus>>;
  remoteRevoke(id: string): Promise<Result<import('./remote').RemoteStatus>>;
  remoteDisconnect(): Promise<Result<import('./remote').RemoteStatus>>;
  computerStatus(): Promise<Result<import('./computer').ComputerStatus>>;
  stopComputer(): Promise<Result<import('./computer').ComputerStatus>>;
  resumeComputer(): Promise<Result<import('./computer').ComputerStatus>>;
  computerPermissions(): Promise<Result<import('./computer').ComputerStatus>>;
  speechModels(refresh?: boolean): Promise<Result<import('./voice').SpeechCatalog>>;
  readAloud(input: import('./voice').SpeechRequest): Promise<Result<import('./voice').SpeechAudio>>;
  previewSpeech(jobId: string): Promise<Result<import('./voice').SpeechAudio>>;
  cancelSpeech(jobId: string): Promise<Result<void>>;
  nextSpeechAudio(jobId: string, sequence: number): Promise<Result<import('./voice').SpeechAudio>>;
  imageModels(refresh?: boolean): Promise<Result<import('./image-generation').ImageCatalog>>;
  chooseImageModel(approvalId: string, selection: import('./image-generation').ImageSelection): Promise<Result<LibrarySnapshot>>;
  imageAction(input: import('./image-generation').ImageAction): Promise<Result<SourceDetail | boolean | null>>;

  notifications(): Promise<Result<import('./notifications').NotificationSnapshot>>;
  notificationAction(action: import('./notifications').NotificationAction): Promise<Result<import('./notifications').NotificationSnapshot>>;
  notificationView(view: { conversationId: string | null; visible: boolean }): Promise<Result<void>>;
  chooseNotificationSound(): Promise<Result<import('./notifications').NotificationSnapshot>>;
  previewNotificationSound(): Promise<Result<void>>;
  testDesktopNotification(): Promise<Result<import('./notifications').NotificationSnapshot>>;
  notificationSoundResult(result: { id: string; played: boolean }): Promise<Result<void>>;
  onNotificationsUpdate(listener: (snapshot: import('./notifications').NotificationSnapshot) => void): () => void;
  onNotificationOpen(listener: (conversationId: string) => void): () => void;
  onNotificationSound(listener: (sound: import('./notifications').NotificationSound) => void): () => void;
  startDictation(input: { id: string; sampleRate: number }): Promise<Result<void>>;
  dictationAudio(input: { id: string; audio: Uint8Array }): Promise<Result<void>>;
  stopDictation(input: { id: string; cancel?: boolean }): Promise<Result<void>>;
  onDictationEvent(listener: (event: import('./dictation').DictationEvent) => void): () => void;
  chatWindow(): Promise<Result<ChatWindowState>>;
  popOutChat(conversationId: string): Promise<Result<ChatWindowState>>;
  returnChat(input?: { settingsSection?: string; workspace?: ChatWindowState['workspace'] }): Promise<Result<ChatWindowState>>;
  acknowledgeChatReturn(conversationId: string): Promise<Result<void>>;
  onChatWindowUpdate(listener: (value: ChatWindowState) => void): () => void;
  onSettingsUpdate(listener: (value: AppSnapshot) => void): () => void;
  clearBotConversation(): Promise<Result<ChatUpdate>>;
  botSnapshot(): Promise<Result<import('./bot').BotSnapshot>>;
  botPluginAccess(): Promise<Result<import('./bot').BotPluginAccess>>;
  setBotPluginAccess(pluginId: string, allowed: boolean): Promise<Result<import('./bot').BotPluginAccess>>;
  scheduledSnapshot(): Promise<Result<import('./scheduled').ScheduledSnapshot>>;
  saveScheduled(input: import('./scheduled').ScheduledInput): Promise<Result<import('./scheduled').ScheduledJob>>;
  scheduledAction(input: { id: string; action: 'pause' | 'resume' | 'remove' | 'run' | 'stop' }): Promise<Result<import('./scheduled').ScheduledSnapshot>>;
  scheduleSuggestions(refresh?: boolean): Promise<Result<import('./scheduled').ScheduledSnapshot>>;
  onScheduledUpdate(listener: (value: import('./scheduled').ScheduledSnapshot) => void): () => void;
  configureBot(input: import('./bot').BotConfiguration): Promise<Result<import('./bot').BotSnapshot>>;
  setBotSnoozed(value: boolean): Promise<Result<import('./bot').BotSnapshot>>;
  botNotes(): Promise<Result<import('./bot').BotNote[]>>;
  botJobs(): Promise<Result<import('./bot').BotJob[]>>;
  changeBotJob(input: { id: string; action: 'pause' | 'resume' | 'run' | 'remove' }): Promise<Result<import('./bot').BotJob[]>>;
  saveBotNote(input: { file: import('./bot').BotNote['file']; text: string }): Promise<Result<import('./bot').BotNote[]>>;
  prepareBot(input: import('./bot').BotSetup): Promise<Result<import('./bot').BotSnapshot>>;
  completeBot(input: import('./bot').BotSetup): Promise<Result<Conversation>>;
  onBotUpdate(listener: (value: import('./bot').BotSnapshot) => void): () => void;
  codeChanges(conversationId: string): Promise<Result<import('./code').CodeChange[]>>;
  undoCodeChange(conversationId: string, changeId: string): Promise<Result<import('./code').CodeChange[]>>;
  diagnostics(): Promise<Result<import('./diagnostics').DiagnosticsSnapshot>>;
  diagnosticTrace(runId: string): Promise<Result<import('./diagnostics').TraceReport | null>>;
  setDiagnostics(enabled: boolean): Promise<Result<import('./diagnostics').DiagnosticsSnapshot>>;
  clearDiagnostics(): Promise<Result<import('./diagnostics').DiagnosticsSnapshot>>;
  exportDiagnostics(): Promise<Result<boolean>>;
  recordReplyFrame(input: import('./diagnostics').UiTrace): Promise<Result<void>>;
  plugins(): Promise<Result<import('./plugins').PluginSnapshot>>;
  skills(): Promise<Result<import('./plugins').SkillHubSnapshot>>;
  previewCatalogSkill(id: string): Promise<Result<import('./plugins').PluginSkill>>;
  installCatalogSkill(id: string, projectId: string | null): Promise<Result<import('./plugins').PluginSnapshot>>;
  draftSkill(input: import('./plugins').SkillDraftInput, projectId?: string | null): Promise<Result<import('./plugins').SkillHubSnapshot>>;
  installDraftSkill(id: string, config: import('./plugins').PluginConfig): Promise<Result<import('./plugins').PluginSnapshot>>;
  dismissSkillDraft(id: string): Promise<Result<import('./plugins').SkillHubSnapshot>>;
  installConnector(kind: import('./plugins').SuggestedConnector): Promise<Result<import('./plugins').PluginSnapshot>>;
  importGoogleConnectorApp(id: string): Promise<Result<import('./plugins').PluginSnapshot>>;
  configureGoogleConnectorApp(id: string, clientId: string, clientSecret: string): Promise<Result<import('./plugins').PluginSnapshot>>;
  configureGithubConnectorApp(id: string, clientId: string): Promise<Result<import('./plugins').PluginSnapshot>>;
  signInConnector(id: string, allowSend?: boolean): Promise<Result<import('./plugins').PluginSnapshot>>;
  resumePluginConnection(conversationId: string, requestId: string, pluginId: string): Promise<Result<ChatUpdate>>;
  dismissPluginConnection(conversationId: string, requestId: string): Promise<Result<ChatUpdate>>;
  savePlugin(input: { id?: string; manifest: import('./plugins').PluginManifest; config: import('./plugins').PluginConfig; importId?: string }): Promise<Result<import('./plugins').PluginSnapshot>>;
  importPlugin(): Promise<Result<{ manifest: import('./plugins').PluginManifest; importId: string } | null>>;
  exportPlugin(id: string): Promise<Result<boolean>>;
  connectPlugin(id: string): Promise<Result<import('./plugins').PluginSnapshot>>;
  disconnectPlugin(id: string, forget?: boolean): Promise<Result<import('./plugins').PluginSnapshot>>;
  removePlugin(id: string): Promise<Result<import('./plugins').PluginSnapshot>>;
  pluginCredentials(id: string, credentials: import('./plugins').PluginCredentials): Promise<Result<import('./plugins').PluginSnapshot>>;
  browsePlugin(id: string, query: string): Promise<Result<import('./plugins').PluginSnapshot>>;
  importPluginResource(id: string, uri: string, projectId: string): Promise<Result<import('./plugins').PluginSnapshot>>;
  refreshPluginResources(id: string): Promise<Result<import('./plugins').PluginSnapshot>>;
  forgetPluginResource(id: string, uri: string, projectId: string): Promise<Result<import('./plugins').PluginSnapshot>>;
  pluginSelection(conversationId: string | null, projectId: string | null): Promise<Result<string[]>>;
  selectPlugins(conversationId: string | null, projectId: string | null, ids: string[]): Promise<Result<string[]>>;
  onPluginsUpdate(listener: (snapshot: import('./plugins').PluginSnapshot) => void): () => void;
  memorySnapshot(): Promise<Result<MemorySnapshot>>;
  memoryEvidence(id: string): Promise<Result<StoredEvidence>>;
  saveMemory(input: MemoryInput): Promise<Result<MemorySnapshot>>;
  saveProfileName(input: import('./memory').ProfileName): Promise<Result<MemorySnapshot>>;
  forgetMemory(id: string): Promise<Result<MemorySnapshot>>;
  personalMemory(enabled: boolean): Promise<Result<MemorySnapshot>>;
  projectIndex(projectId: string, action: 'enable' | 'disable' | 'refresh' | 'forget'): Promise<Result<MemorySnapshot>>;
  previewMemory(projectId: string | null, query: string): Promise<Result<SourceExcerpt[]>>;
  onMemoryUpdate(listener: (snapshot: MemorySnapshot) => void): () => void;
  browserHistory(): Promise<Result<BrowserHistoryEntry[]>>;
  clearBrowserData(action: 'history' | 'all'): Promise<Result<void>>;
  openBrowserLink(url: string): Promise<Result<'workspace' | 'system'>>;
  workspaceBrowser(input: BrowserRequest): Promise<Result<BrowserState>>;
  openBrowserPasswords(conversationId: string, tabId: string): Promise<Result<void>>;
  workspaceBrowserLayout(input: BrowserLayout): Promise<Result<void>>;
  workspaceBrowserScroll(input: import('./workspace').BrowserScrollRequest): Promise<Result<import('./workspace').BrowserScroll>>;
  workspaceBrowserCapture(conversationId: string, tabId: string, preview?: boolean): Promise<Result<string>>;
  workspaceFiles(input: WorkspaceFileRequest): Promise<Result<WorkspaceFileResult>>;
  workspaceGit(input: WorkspaceGitRequest): Promise<Result<WorkspaceGitResult>>;
  workspaceTerminal(input: import('./terminal').TerminalRequest): Promise<Result<import('./terminal').TerminalState>>;
  onWorkspaceTerminalState(listener: (state: import('./terminal').TerminalState) => void): () => void;
  onWorkspaceBrowserState(listener: (state: BrowserState) => void): () => void;
  onWorkspaceBrowserFocus(listener: (input: { conversationId: string; tabId: string }) => void): () => void;
  windowState(): Promise<Result<WindowState>>;
  setAppIcon(icon: 'ios-default' | 'dark' | 'tinted-light' | 'clear-light' | 'clear-dark'): Promise<Result<void>>;
  windowControl(action: WindowAction): Promise<Result<WindowState>>;
  resizeWindow(input: { edge: ResizeEdge; phase: 'start' | 'move' | 'end'; x: number; y: number }): Promise<Result<void>>;
  onWindowState(listener: (state: WindowState) => void): () => void;
  snapshot(): Promise<Result<AppSnapshot>>;
  saveOnboarding(state: import('./onboarding').OnboardingState): Promise<Result<AppSnapshot>>;
  saveSettings(settings: Settings): Promise<Result<AppSnapshot>>;
  saveSecret(slot: SecretSlot, value: string): Promise<Result<AppSnapshot>>;
  deleteSecret(slot: SecretSlot): Promise<Result<AppSnapshot>>;
  checkConnection(route: InferenceRoute): Promise<Result<ConnectionReport>>;
  connectOpenRouter(): Promise<Result<AppSnapshot>>;
  openRouterAccount(): Promise<Result<OpenRouterAccount>>;
  openRouterPreferences(policy: Settings['openrouter']): Promise<Result<AppSnapshot>>;
  connectWithKey(input: { id?: string; provider: Settings['byok']['provider']; protocol: Settings['byok']['protocol']; endpoint: string; key: string }): Promise<Result<AppSnapshot>>;
  connectionModels(id: string): Promise<Result<ConnectionReport>>;
  chooseConnectionModel(id: string, model: string): Promise<Result<AppSnapshot>>;
  activateInferenceConnection(id: string): Promise<Result<AppSnapshot>>;
  removeInferenceConnection(id: string): Promise<Result<AppSnapshot>>;
  disconnectInference(route: 'byok' | 'local'): Promise<Result<AppSnapshot>>;
  cancelInferenceSignIn(): Promise<Result<void>>;
  scanLocalModels(): Promise<Result<LocalDiscovery>>;
  builtInHardware(): Promise<Result<import('./managed-local').BuiltInHardware>>;
  configurationMonitor(): Promise<Result<import('./configuration-monitor').ConfigurationMonitorSnapshot>>;
  builtInStatus(): Promise<Result<Record<import('./managed-local').BuiltInModelId, import('./managed-local').ManagedLocalStatus>>>;
  startBuiltInModel(id: import('./managed-local').BuiltInModelId): Promise<Result<AppSnapshot>>;
  stopBuiltInModel(id: import('./managed-local').BuiltInModelId): Promise<Result<AppSnapshot>>;
  managedLocalStatus(): Promise<Result<import('./managed-local').ManagedLocalStatus>>;
  startManagedLocal(speculative?: boolean): Promise<Result<AppSnapshot>>;
  stopManagedLocal(): Promise<Result<void>>;
  useLocalModel(endpoint: string, model: string): Promise<Result<AppSnapshot>>;
  chooseOpenRouterModel(model: string): Promise<Result<AppSnapshot>>;
  library(): Promise<Result<LibrarySnapshot>>;
  outputs(): Promise<Result<import('./outputs').LibraryOutput[]>>;
  searchLibrary?(query: string): Promise<Result<string[]>>;
  excludeSource?(id: string, excluded: boolean): Promise<Result<void>>;
  librarySource?(id: string): Promise<Result<import('./tools').SourceDetail & { originalAvailable: boolean; linkedFile?: boolean }>>;
  downloadSource?(id: string): Promise<Result<void>>;
  removeLibrarySource?(id: string): Promise<Result<void>>;
  reuseSource?(id: string, conversationId: string): Promise<Result<void>>;
  retrySource?(id: string): Promise<Result<void>>;
  profileUsage(): Promise<Result<ProfileUsage>>;
  conversationUsage(id: string): Promise<Result<ConversationUsage>>;
  organizeConversation(input: ConversationOrganization): Promise<Result<LibrarySnapshot>>;
  createConversation(projectId: string | null): Promise<Result<Conversation>>;
  conversation(id: string): Promise<Result<Conversation>>;
  renameConversation(id: string, title: string): Promise<Result<LibrarySnapshot>>;
  deleteConversation(id: string): Promise<Result<LibrarySnapshot>>;
  sendMessage(conversationId: string, text: string, attachmentIds?: string[]): Promise<Result<ChatUpdate>>;
  queueRequest(action: import('./chat').QueueAction): Promise<Result<ChatUpdate>>;
  retryMessage(conversationId: string): Promise<Result<ChatUpdate>>;
  reactToMessage(conversationId: string, messageId: string, emoji: import('./bot-reactions').MessageReaction['emoji'] | null): Promise<Result<ChatUpdate>>;
  editMessage(conversationId: string, messageId: string, text: string): Promise<Result<ChatUpdate>>;
  regenerateMessage(conversationId: string, messageId: string): Promise<Result<ChatUpdate>>;
  continueMessage(conversationId: string, messageId: string): Promise<Result<ChatUpdate>>;
  selectBranch(conversationId: string, messageId: string): Promise<Result<ChatUpdate>>;
  discardReply(conversationId: string, messageId: string): Promise<Result<ChatUpdate>>;
  cancelMessage(conversationId: string): Promise<Result<ChatUpdate>>;
  exportMessage(conversationId: string, messageId: string): Promise<Result<boolean>>;
  createProject(name: string, instructions: string, browserIsolated?: boolean, folderChoiceId?: string): Promise<Result<ChatProject>>;
  chooseNewProjectFolder(): Promise<Result<{ id: string; path: string } | null>>;
  openHelp(page: 'about' | 'privacy' | 'terms'): Promise<Result<void>>;
  updateProject(id: string, name: string, instructions: string, browserIsolated?: boolean, folderChoiceId?: string | null): Promise<Result<LibrarySnapshot>>;
  organizeProject(input: import('./chat').ProjectOrganization): Promise<Result<LibrarySnapshot>>;
  chooseProjectFolder(id: string): Promise<Result<ChatProject>>;
  chooseAttachments(conversationId: string): Promise<Result<ChatUpdate>>;
  chooseAttachmentFolder(conversationId: string): Promise<Result<ChatUpdate>>;
  linkConversation(conversationId: string, targetId: string): Promise<Result<ChatUpdate>>;
  toolPreview(conversationId: string,toolId: string): Promise<Result<import('./remote-media').ToolImagePreview>>;
  source(conversationId: string, sourceId: string): Promise<Result<SourceDetail>>;
  removeSource(conversationId: string, sourceId: string): Promise<Result<ChatUpdate>>;
  searchSources(conversationId: string, query: string): Promise<Result<SourceExcerpt[]>>;
  approveTool(id: string, decision: import('./tools').ApprovalDecision): Promise<Result<LibrarySnapshot>>;
  answerWorkQuestion(input: { questionId: string; optionId?: string; text?: string }): Promise<Result<ChatUpdate>>;
  cancelWorkQuestion(questionId: string): Promise<Result<ChatUpdate>>;
  markConversationRead(id: string, messageId: string): Promise<Result<LibrarySnapshot>>;
  searchWeb(conversationId: string, query: string, engine: SearchEngine): Promise<Result<WebSearch>>;
  readPage(conversationId: string, url: string): Promise<Result<{ page: PageSnapshot; sourceId?: string }>>;
  revealBrowser(conversationId: string, tabId: string): Promise<Result<void>>;
  resumeBrowser(tabId: string): Promise<Result<void>>;
  cancelBrowserTasks(conversationId: string): Promise<Result<void>>;
  onChatUpdate(listener: (update: ChatUpdate) => void): () => void;
  onChatPackets?(listener: (packets: import('../core/chat-updates').ChatPacket[]) => void): () => void;
}

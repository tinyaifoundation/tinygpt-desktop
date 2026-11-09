import { searchHandbook, readHandbook, handbookVersion, handbookArticles, handbookSourceId } from '../core/handbook';
import { passwordPrivacy, PASSWORD_PRIVATE_MESSAGE } from './password-privacy';
import { ObservationStore } from './observations';
import { devtoolsPermissions } from './devtools-mcp';
import { browserToolResult } from '../core/browser-snapshot';
import { BrowserActionError } from '../core/browser-errors';
import { calculate } from './calculator';
import { WorkCommandJobs } from './work-command-jobs';
import { operationOutcome } from '../core/operation-outcome';
import { connectorFailure } from './connector-errors';
import { ImageGeneration } from './image-generation';
import { snapshotEvidence, waitForObservation } from '../core/wait-until';
import { computerToolLabel, isComputerTool, type ComputerToolName } from '../shared/computer';
import { ComputerFailure } from './computer-driver';
import type { ComputerService } from './computer-service';
import { imageErrors } from '../core/image-generation';
import type { ImageModel, ImageSelection } from '../shared/image-generation';
import { ImageTools } from './image-tools';
import { BROWSER_CAPTURE_UNAVAILABLE, BROWSER_CAPTURE_TIMEOUT } from './browser';
import { visionTool } from '../shared/vision';
import { VisionFailure, type LocalVisionService, type VisionAnalyzer } from './local-vision';
import { builtInModels, proModelRevision } from '../shared/managed-local';
import visionManifest from '../shared/vision-model.json';
import type { ImageUnderstanding } from './image-understanding';
import { randomUUID, createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { lstat, mkdir } from 'node:fs/promises';
import { scopedPath } from './files';
import { fileDestination, prepareFileDestination } from './file-destination';
import { CodeFiles, CODE_STALE_FILE, CODE_EDIT_GUARD_REQUIRED } from './code-files';
import { WorkspaceFiles, WorkspaceFileError } from './work-files';
import { nativeCodePath, NativeCodeTools } from './native-code-tools';
import { FILE_WRITE_CONFLICT } from './file-write-locks';
import type { NativeCodeEvent } from '../shared/code';
import type { MemoryService } from './memory-service';
import type { PluginService } from './plugin-service';
import type { HistoryStore } from './history';
import type { BrowserController, BrowserTarget } from './browser';
import type { ProjectFiles } from './files';
import type { Settings } from '../shared/config';
import { toolDisplayText, toolApprovalText } from '../shared/tool-display';
import type { ApprovalDecision } from '../shared/tools';
import type { PluginUse } from '../shared/plugins';
import type { TraceSink, TraceEvent } from '../shared/diagnostics';
import { toolArguments, toolNameSchema, type ApprovalRequest, type BuiltInToolName, type ToolName, type ToolRequest, type WebSearch, type SearchEngine, type PageSnapshot } from '../shared/tools';

export interface ToolContext { conversationId: string; runId: string; signal: AbortSignal; vision?: boolean; imageModel?: 'pro'; inferenceScope?: string; unattended?: boolean }
const category: Record<BuiltInToolName, keyof Settings['toolPermissions']> = { search_help: 'read', read_source: 'read', read_observation: 'read', list_files: 'read', read_file: 'read', search_files: 'read', write_file: 'write', edit_file: 'write', run_command: 'execute', load_tools: 'read', computer_open_app: 'desktopInteract', computer_activate_window: 'desktopInteract', computer_list_windows: 'desktop', computer_read_window: 'desktop', computer_screenshot: 'desktop', computer_click: 'desktopInteract', computer_type: 'desktopInteract', computer_press_key: 'desktopInteract', computer_scroll: 'desktopInteract', search_skills: 'read', load_skill: 'read', read_skill_reference: 'read', draft_skill: 'read', copy_skill_files: 'write', generate_image: 'read', view_image: 'read', browser_screenshot: 'browser', present: 'read', calculate: 'read', create_project_directory: 'write', edit_project_file: 'write', review_project_changes: 'read', run_project_command: 'execute', command_status: 'execute', command_stop: 'execute', request_plugin_connection: 'read', search_web: 'browser', read_page: 'browser', browser_preview: 'browser', browser_tabs: 'browser', browser_open: 'browser', browser_navigate: 'browser', browser_snapshot: 'browser', browser_click: 'interact', browser_type: 'interact', browser_scroll: 'interact', browser_hover: 'interact', browser_press_key: 'interact', browser_close: 'interact', list_project_files: 'read', read_project_file: 'read', write_project_file: 'write', search_sources: 'read' };
const friendly = [
  'Four commands are already running. Check or stop one before starting another.',
  'This command job is not available to this conversation. It may have ended when the app closed. Check its outcome before retrying.',
  'Choose a new destination folder; existing files will not be replaced.',
  BROWSER_CAPTURE_UNAVAILABLE, BROWSER_CAPTURE_TIMEOUT, 'The generated files folder changed. Try again.',
  'Use view_image with a relative Project path to inspect images.',
  'Choose a readable PNG, JPEG, or WebP image.', 'This image has too many pixels. Use an image with 32 megapixels or fewer.', 'The image crop is outside the original image. Use its originalWidth and originalHeight.', 'This image is too large to view. Use a smaller image.', 'This reference is not an image.', 'Source not found in this conversation or Project.',
  FILE_WRITE_CONFLICT,
  'Code edits support files up to 100,000 characters.', 'Code edits support files up to 500,000 characters.',
  CODE_STALE_FILE, CODE_EDIT_GUARD_REQUIRED, 'Use a program name and separate arguments; shell programs are not available.', 'The program could not start. Check that it is installed and available on your PATH.',
  'Cancelled.', 'The page still needs manual login, consent, or verification.', 'The browser did not respond. Read a new browser snapshot.',
  'Select a Project folder before using file tools.', 'Use a relative path inside the Project folder.', 'That path is outside the Project folder.', 'A link points outside the Project folder.', 'The Project folder changed. Select it again.',
  'Sensitive configuration files are not available to file tools. Attach a file explicitly if you want to share it.', 'Files must be 15 MB or smaller.', 'Choose a regular file.', 'Choose a text/code file, PDF, PNG, JPEG, or WebP image.', 'This file is not supported UTF-8 text.', 'Text files must contain 500,000 characters or fewer.', 'PDFs must have 200 pages or fewer.', 'This PDF has no readable text. Scanned PDFs need OCR, which is not available yet.', 'The PDF could not be read within 30 seconds.',
  'File tools write supported text/code formats only.', 'The file changed while it was being read. Try again.', 'The file changed before writing. Try again.', 'This browser tab is not available to the conversation.', 'This field needs manual interaction.', 'This field cannot be edited.', 'The element changed. Read a new browser snapshot.', 'The element is no longer visible. Read a new browser snapshot.', 'The page did not load. Check internet access and try again.', 'The browser window was closed.', 'Close a browser window before opening another page.',
];
export function safeToolError(error: unknown): string { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException | null)?.code ?? '')) return 'That file or folder does not exist. Check the relative Project path with list_project_files; use edit_project_file to create a new file.'; const message = error instanceof Error ? error.message : ''; return imageErrors.includes(message) || friendly.includes(message) || message === 'Browser reading was disabled while waiting.' ? message : 'The tool could not finish. Check the file, page, or connection and try again.'; }
export class ToolBroker {
  prepareSources?: (ids: string[], signal: AbortSignal) => Promise<void>;
  private workspaceFiles: WorkspaceFiles;
  private commandJobs = new WorkCommandJobs();
  computer?: ComputerService;
  imageGeneration?: ImageGeneration;
  localVision?: LocalVisionService;
  imageUnderstanding?: ImageUnderstanding;
  proVision?: VisionAnalyzer;
  readonly images: ImageTools;
  readonly code: CodeFiles;
  readonly native: NativeCodeTools;
  private pending = new Map<string, { approval: ApprovalRequest; check?: () => void; resolve: (value: ApprovalDecision) => void }>();
  private grants = new Map<string, Set<keyof Settings['toolPermissions']>>();
  private connectionWaits = new Set<string>();
  private extensionGrants = new Map<string, Set<string>>();
  private deniedPluginUses = new Map<string, Set<string>>();
  private manual = new Map<string, AbortController>();
  private manualConversations = new Map<string, string>();
  private retainedBotBrowserRuns = new Set<string>();
  private queues = new Map<string, Promise<unknown>>();
  private inflight = new Set<Promise<unknown>>();
  private passwordAbort = new AbortController();
  async pauseForPasswords(): Promise<void> {
    this.passwordAbort.abort(); this.passwordAbort = new AbortController();
    this.cancelManual(); await this.commandJobs.shutdown();
    await Promise.allSettled([...this.inflight, ...this.manualDone]);
  }
  private manualDone = new Set<Promise<void>>();
  private trackManual(): () => void { let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; }); this.manualDone.add(done); return () => { finish(); this.manualDone.delete(done); }; }
  readonly observations: ObservationStore;
  constructor(private history: HistoryStore, private settings: () => Settings, readonly browser: BrowserController, private files: ProjectFiles, private changed: (conversationId: string) => void, private memory?: MemoryService, private plugins?: PluginService, private diagnostics?: TraceSink) {
    this.observations = new ObservationStore(history.databasePath === ':memory:' ? join(history.generatedFilesRoot, 'library.sqlite') : history.databasePath);
    this.images = new ImageTools(history, browser);
    this.code = new CodeFiles(history, files);
    this.workspaceFiles = new WorkspaceFiles(history, files, this.code);
    this.native = new NativeCodeTools(history, async (context,event,category,summary,details) => {
      passwordPrivacy.assert();
      this.history.addTool(event.id,context.conversationId,context.runId,event.name,summary,toolDisplayText(event.displayText),typeof event.args.filePath === 'string' ? event.args.filePath : undefined);
      this.changed(context.conversationId);
      const required = event.name === 'code_devtools' ? devtoolsPermissions(event.args) : [category];
      const setting = () => required.some(key => this.settings().toolPermissions[key] === 'deny') ? 'deny' : required.some(key => this.settings().toolPermissions[key] === 'ask') ? 'ask' : 'allow';
      const scope = () => this.conversationScope(context,event.name) + (event.name === 'code_devtools' ? ':' + required.join(',') : '');
      let approved = (event.name === 'code_devtools' ? this.extensionGrants.get(context.runId)?.has(`devtools:${scope()}`) : this.grants.get(context.runId)?.has(category)) || this.history.hasConversationGrant(context.conversationId,scope());
      if (this.connectionWaits.has(context.runId) || setting() === 'deny') {
        this.history.finishTool(event.id,'denied','Blocked by your tool preference or a pending connection.');
        throw new Error('This action is blocked. Do not use another tool to bypass the decision.');
      }
      if (setting() === 'ask' && !approved) approved = await this.ask(context,event.id,event.name,summary,details,() => { if (setting() === 'deny') throw new Error('Revoked.'); },event.approvalText,scope);
      context.signal.throwIfAborted();
      if (setting() === 'deny' || setting() === 'ask' && !approved) {
        this.history.finishTool(event.id,'denied','Denied by the user.');
        throw new Error('The user denied this action. Do not perform it or work around the denial.');
      }
      this.history.finishTool(event.id,'running'); this.changed(context.conversationId);
      this.trace(context,{event:'tool-start',operationId:event.id,tool:'native-code'});
    },changed);
  }
  nativeCode(context: ToolContext, event: NativeCodeEvent): Promise<{output?:string}> {
    if (event.phase === 'before') this.trace(context,{event:'tool-queued',operationId:event.id,tool:'native-code'});
    const operation = this.native.handle(context,event).catch(error => {
      if (event.phase === 'before') {
        let tool = this.history.conversation(context.conversationId).tools.find(tool => tool.id === event.id);
        if (!tool) { this.history.addTool(event.id,context.conversationId,context.runId,event.name,'The coding action could not start.',toolDisplayText(event.displayText)); tool = undefined; }
        if (tool?.status !== 'denied') this.history.finishTool(event.id,context.signal.aborted ? 'cancelled' : 'error',context.signal.aborted ? 'Cancelled.' : safeToolError(error));
        this.trace(context,{event:'tool-end',operationId:event.id,tool:'native-code',outcome:context.signal.aborted ? 'cancelled' : tool?.status === 'denied' ? 'denied' : 'error'});
      }
      this.changed(context.conversationId); throw error;
    }).finally(() => {
      if (event.phase === 'after') this.trace(context,{event:'tool-end',operationId:event.id,tool:'native-code',outcome:event.status === 'success' ? 'success' : 'error'});
    });
    this.inflight.add(operation); void operation.finally(() => this.inflight.delete(operation)).catch(() => {}); return operation;
  }
  private trace(context: ToolContext, event: TraceEvent): void { try { this.diagnostics?.record(context.runId, event); } catch { /* Best effort. */ } }
  approvals(): ApprovalRequest[] { return [...this.pending.values()].map(value => value.approval); }
  respond(id: string, decision: ApprovalDecision): void { const request = this.pending.get(id); if (!request) throw new Error('This approval is no longer pending.'); if (request.approval.imageModels && decision !== 'deny') throw new Error('Choose an image model to continue.'); request.resolve(decision); }
  async chooseImageModel(id: string, selection: ImageSelection) {
    const request = this.pending.get(id);
    if (!request?.approval.imageModels || !this.imageGeneration || !request.approval.imageModels.some(item => item.connectionId === selection.connectionId && item.model === selection.model)) throw new Error('This image model is no longer available. Choose another model.');
    await this.imageGeneration.select(selection);
    if (this.pending.get(id) !== request) throw new Error('This approval is no longer pending.');
    request.resolve('allow-once');
  }
  revokeUnavailableExtensions(): void { for (const request of this.pending.values()) if (request.check) { try { request.check(); } catch { request.resolve('deny'); } } }
  private conversationScope(context: ToolContext, name: ToolName, extension = ''): string {
    const conversation = this.history.conversation(context.conversationId); const project = conversation.projectId ? this.history.project(conversation.projectId) : null;
    return createHash('sha256').update(JSON.stringify([name, conversation.projectId, project?.rootPath ?? this.history.generatedFilesRoot, project?.browserIsolated, this.settings().toolPermissions, extension])).digest('hex');
  }
  private async ask(context: ToolContext, id: string, name: ToolName, summary: string, details: string, check?: () => void, prompt?: string, scope?: () => string, imageModels?: ImageModel[], onceOnly = false, pluginUse?: PluginUse): Promise<boolean> {
    // A private proactive check cannot leave an approval card in a hidden chat.
    // It may use only access already granted by the user's shared policies.
    if (context.unattended) return false;
    context.signal.throwIfAborted();
    const capturedScope = scope?.();
    return new Promise<boolean>((resolve, reject) => {
      this.trace(context, { event: 'approval-start', operationId: id });
      const abort = () => { this.trace(context, { event: 'approval-end', operationId: id, outcome: 'cancelled' }); this.pending.delete(id); context.signal.removeEventListener('abort', abort); this.changed(context.conversationId); reject(new Error('Cancelled.')); };
      this.pending.set(id, { check, approval: { id, conversationId: context.conversationId, runId: context.runId, name, summary, details, prompt: toolApprovalText(prompt), imageModels, ...(pluginUse ? { pluginUse } : {}), ...(onceOnly ? { onceOnly: true } : {}) }, resolve: decision => {
        if (pluginUse && decision !== 'deny') decision = 'allow-conversation';
        if (onceOnly && decision !== 'deny') decision = 'allow-once';
        this.pending.delete(id); context.signal.removeEventListener('abort', abort);
        try { check?.(); if (scope && scope() !== capturedScope) decision = 'deny'; } catch { decision = 'deny'; }
        this.trace(context, { event: 'approval-end', operationId: id, outcome: decision === 'deny' ? 'denied' : 'success' });
        if (decision === 'allow-conversation' && capturedScope) { try { this.history.grantConversationTool(context.conversationId, capturedScope); } catch (error) { this.changed(context.conversationId); reject(error); return; } }
        if (decision === 'allow-run') {
          if (name === 'code_devtools' || isComputerTool(name) || name.startsWith('ext_') || name === 'load_skill' || name === 'read_skill_reference') { const grants = this.extensionGrants.get(context.runId) ?? new Set(); grants.add(name === 'code_devtools' ? `devtools:${capturedScope}` : isComputerTool(name) ? `computer:${capturedScope}` : name.startsWith('ext_') ? name : `${name}:${capturedScope}`); this.extensionGrants.set(context.runId, grants); }
          else { const grants = this.grants.get(context.runId) ?? new Set(); grants.add(name.startsWith('code_') ? ['code_write','code_edit','code_apply_patch'].includes(name) ? 'write' : name === 'code_bash' ? 'execute' : 'read' : category[name as BuiltInToolName]); if (name === 'browser_preview') grants.add('read'); this.grants.set(context.runId, grants); }
        }
        this.changed(context.conversationId); resolve(decision !== 'deny');
      } });
      context.signal.addEventListener('abort', abort, { once: true }); this.changed(context.conversationId);
    });
  }
  private async ensurePluginUse(context: ToolContext, pluginId: string): Promise<boolean> {
    const authorization = () => this.plugins!.useAuthorization(context.conversationId, pluginId);
    const first = authorization(); if (!first) return true;
    if (this.deniedPluginUses.get(context.runId)?.has(pluginId)) return false;
    if (this.history.hasConversationGrant(context.conversationId, first.scope)) return true;
    const { scope: _scope, ...pluginUse } = first;
    const id = randomUUID(); const request = { type: 'plugin-use-request', ...pluginUse };
    this.history.addTool(id, context.conversationId, context.runId, 'load_tools', `Use ${first.name}`, undefined, first.name);
    this.history.finishTool(id, 'pending', JSON.stringify({ ...request, status: 'pending' }));
    try {
      const approved = await this.ask(context, id, 'load_tools', `Use ${first.name} in this chat`, 'Read access for this conversation. Changes still need approval.', () => { authorization(); }, undefined, () => authorization()!.scope, undefined, false, pluginUse);
      context.signal.throwIfAborted();
      this.history.finishTool(id, approved ? 'success' : 'denied', JSON.stringify({ ...request, status: approved ? 'approved' : 'denied' }));
      if (!approved) { const denied = this.deniedPluginUses.get(context.runId) ?? new Set<string>(); denied.add(pluginId); this.deniedPluginUses.set(context.runId, denied); }
      return approved;
    } catch (error) { this.history.finishTool(id, 'cancelled', JSON.stringify({ ...request, status: 'cancelled' })); throw error; }
    finally { this.changed(context.conversationId); }
  }
  execute(context: ToolContext, request: ToolRequest): Promise<string> {
    if (passwordPrivacy.active) return Promise.resolve(JSON.stringify({error:PASSWORD_PRIVATE_MESSAGE,code:'PRIVATE_SIGN_IN'}));
    const privacyEpoch = passwordPrivacy.epoch;
    context = {...context,signal:AbortSignal.any([context.signal,this.passwordAbort.signal])};
    const tool: TraceEvent['tool'] = request.name.startsWith('ext_') ? 'extension' : request.name as BuiltInToolName;
    this.trace(context, { event: 'tool-queued', operationId: request.id, tool });
    const operation = async () => {
      let outcome: TraceEvent['outcome'] = 'error';
      try { passwordPrivacy.assert(privacyEpoch); let result = await this.perform(context, request, false); passwordPrivacy.assert(privacyEpoch); outcome = 'success'; try { if (JSON.parse(result)?.error) outcome = 'error'; } catch { /* Diagnostic inspection cannot alter a result. */ }
        if (outcome === 'success' && result.length > 6000 && (['read_page','search_web','search_sources'].includes(request.name) || request.name.startsWith('browser_'))) { const record = await this.observations.save({ conversationId: context.conversationId, runId: context.runId, tool: request.name, permission: request.name === 'search_sources' ? 'read' : 'browser', text: result }); result = request.name === 'read_page' || request.name.startsWith('browser_') ? JSON.stringify({ ...JSON.parse(result), observationId: record.id, capturedAt: record.createdAt }) : this.observations.excerpt(record); }
        return request.name === 'read_page' || request.name.startsWith('browser_') ? browserToolResult(result) : result; }
      finally { this.trace(context, { event: 'tool-end', operationId: request.id, tool, outcome: context.signal.aborted ? 'cancelled' : outcome }); }
    };
    // Approval waits and slow tools block only their own run. Keep each run's
    // actions ordered; independent conversations execute concurrently.
    const next = (this.queues.get(context.runId) ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.queues.set(context.runId, next); this.inflight.add(next);
    void next.finally(() => { this.inflight.delete(next); if (this.queues.get(context.runId) === next) this.queues.delete(context.runId); }).catch(() => undefined);
    return next;
  }
  private async perform(context: ToolContext, request: ToolRequest, manual: boolean, forceConnection = false): Promise<string> {
    passwordPrivacy.assert();
    context.signal.throwIfAborted();
    if (request.validationError) { this.history.addTool(request.id, context.conversationId, context.runId, request.name, 'Check tool availability'); this.history.finishTool(request.id, 'error', request.validationError); this.changed(context.conversationId); return request.validationError; }
    if (this.connectionWaits.has(context.runId)) return JSON.stringify({ error: 'A plugin connection card is waiting for the user. Stop tools and wait; do not bypass this request.' });
    if (request.name.startsWith('ext_')) return this.performExtension(context, request);
    const imageAssistant = context.imageModel === 'pro' ? this.proVision : this.localVision;
    if (visionTool(request.name) && (context.imageModel === 'pro' || context.vision !== true) && !imageAssistant?.available()) return JSON.stringify({ error: context.imageModel === 'pro' ? 'Start Pro in Configuration to use its image analysis.' : 'Image tools require the bundled image model or a vision-capable main model.', code: 'VISION_UNAVAILABLE' });
    const name = toolNameSchema.parse(request.name); const parsed = toolArguments[name].safeParse(request.input);
    const conversation = this.history.conversation(context.conversationId);
    if (conversation.mode === 'bot' && !context.unattended && name.startsWith('browser_')) this.retainedBotBrowserRuns.add(context.runId);
    if (!parsed.success) {
      const result = JSON.stringify({ error: name === 'present' ? `Invalid interface. ${parsed.error.issues.map(issue => issue.message).join(' ').slice(0, 1200)} Correct the indicated fields and call present again.` : `Invalid arguments for ${name}. Nothing was executed.`, code: 'INVALID_ARGUMENTS', tool: name, executed: false, issues: parsed.error.issues.map(issue => ({ field: issue.path.join('.') || 'arguments', message: issue.message })).slice(0, 8), nextAction: 'Correct the indicated fields and call this tool again.' });
      if (conversation.mode === 'code') { this.history.addTool(request.id, context.conversationId, context.runId, name, `Check ${name} arguments`); this.history.finishTool(request.id, 'error', result); this.changed(context.conversationId); }
      return result;
    }
    const input = parsed.data as Record<string, string>;
    if (isComputerTool(name)) return this.performComputer(context, { ...request, input: parsed.data }, name);
    if (['list_files','read_file','search_files','write_file','edit_file','run_command','create_project_directory','edit_project_file','review_project_changes','run_project_command','command_status','command_stop','copy_skill_files'].includes(name) && conversation.mode !== 'code') return JSON.stringify({ error: 'This tool is available only in Work conversations.' });
    if (name === 'load_tools') {
      if (conversation.mode !== 'code' && ['jobs', 'history'].includes(input.group)) return JSON.stringify({ error: 'This tool group is available only in Work conversations.' });
      if (input.group === 'services') {
        if (!this.plugins) return JSON.stringify({ error: 'Plugins are unavailable.' });
        const selection = this.plugins.loadTools(context.runId, context.conversationId, input.query, (parsed.data as { connect?: boolean }).connect);
        if (selection.connection) return this.perform(context, { ...request, name: 'request_plugin_connection', input: selection.connection }, false, (parsed.data as { connect?: boolean }).connect === true);
        for (const pluginId of this.plugins.usePluginIds(context.runId, context.conversationId, selection.toolNames)) if (!await this.ensurePluginUse(context, pluginId)) return JSON.stringify({ error: 'The user declined this plugin for the task. Do not use it or work around this decision.', code: 'PLUGIN_USE_DENIED', executed: false });
        // Recheck after an approval wait: selection or connection may have changed.
        const currentSelection = this.plugins.loadTools(context.runId, context.conversationId, input.query, (parsed.data as { connect?: boolean }).connect);
        if (JSON.stringify(currentSelection.toolNames) !== JSON.stringify(selection.toolNames) || currentSelection.connection) return JSON.stringify({ error: 'Plugin access changed while waiting. Load the tools again.', code: 'ACCESS_CHANGED', executed: false });
        const result = JSON.stringify(selection);
        this.history.addTool(request.id, context.conversationId, context.runId, name, selection.status === 'loaded' ? 'Load plugin tools' : 'Find plugin tools');
        this.history.finishTool(request.id, 'success', result); this.changed(context.conversationId); return result;
      }
      const result = JSON.stringify({ enabled: input.group, ...(input.query ? { query: input.query } : {}), notice: 'Tools are available on the next request. Permissions remain unchanged.' });
      this.history.addTool(request.id, context.conversationId, context.runId, name, `Use ${input.group} tools`); this.history.finishTool(request.id, 'success', result); this.changed(context.conversationId); return result;
    }
    if (conversation.mode === 'code' && name === 'write_project_file') return JSON.stringify({ error: 'Use edit_project_file with the exact existing content to protect unrelated changes.' });
    if (name === 'search_help') {
      const args = toolArguments.search_help.parse(request.input);
      const articleId = args.query.match(/^article:([a-z0-9-]+)$/)?.[1];
      const hits = !articleId && this.memory ? await this.memory.searchHelp(args.query, context.signal) : undefined;
      const articles = articleId ? readHandbook(articleId) : hits ? hits.map(hit => ({ ...hit, articleId: handbookArticles.find(article => handbookSourceId(article.id) === hit.sourceId)?.id })) : searchHandbook(args.query);
      const result = JSON.stringify({ version: handbookVersion, articles, notice: 'Product documentation, not live access or an action result.' });
      this.history.addTool(request.id, context.conversationId, context.runId, name, 'Read TinyGPT help');
      this.history.finishTool(request.id, 'success', result); this.changed(context.conversationId); return result;
    }
    if (name === 'calculate') {
      this.history.addTool(request.id, context.conversationId, context.runId, name, 'Calculate · ' + input.expression.slice(0, 80), toolDisplayText(request.displayText));
      this.changed(context.conversationId);
      try {
        const result = JSON.stringify(calculate(input.expression));
        context.signal.throwIfAborted();
        this.history.finishTool(request.id, 'success', result);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid calculator expression.';
        this.history.finishTool(request.id, context.signal.aborted ? 'cancelled' : 'error', message);
        if (context.signal.aborted) throw error;
        return JSON.stringify({ error: message });
      } finally { this.changed(context.conversationId); }
    }
    const project = conversation.projectId ? this.history.project(conversation.projectId) : null;
    const workspace = conversation.mode === 'code' ? await prepareFileDestination(this.history, context.conversationId, context.signal) : undefined;
    let checkCopyAccess: (() => void) | undefined;
    if (name === 'copy_skill_files') {
      if (!this.plugins || !workspace) return JSON.stringify({ error: 'Select a Project folder before copying skill files.' });
      const args = toolArguments.copy_skill_files.parse(request.input);
      checkCopyAccess = () => { const auth = this.plugins!.skillAuthorization(context.runId, context.conversationId, args.skillId, false), reference = this.plugins!.skillAuthorization(context.runId, context.conversationId, args.skillId, true); const scope = this.conversationScope(context, 'load_skill', auth.scope); if (auth.rule === 'deny' || reference.rule === 'deny' || auth.rule === 'ask' && !this.extensionGrants.get(context.runId)?.has(`load_skill:${scope}`) && !this.history.hasConversationGrant(context.conversationId, scope)) throw Error('Load and approve this skill before copying its package.'); };
      try { checkCopyAccess(); } catch (error) { return JSON.stringify({ error: error instanceof Error && error.message === 'Load and approve this skill before copying its package.' ? error.message : 'This skill is unavailable for this reply.' }); }
    }
    if (['search_skills', 'load_skill', 'read_skill_reference', 'draft_skill'].includes(name)) {
      if (!this.plugins) return JSON.stringify({ error: 'Skills are unavailable.' });
      // Reading installed guidance and drafting an inert review card are internal
      // operations. They do not bypass file, account, command, or send approvals.
      const values = parsed.data as { skillId?: string };
      const authorization = values.skillId ? () => this.plugins!.skillAuthorization(context.runId, context.conversationId, values.skillId!, name === 'read_skill_reference') : undefined;
      let initial: ReturnType<PluginService['skillAuthorization']> | undefined;
      try { initial = authorization?.(); } catch { return JSON.stringify({ error: 'This skill is unavailable for this reply.' }); }
      const label = name === 'draft_skill' ? 'Draft a skill' : name === 'search_skills' ? 'Find a skill' : name === 'load_skill' ? `Use skill · ${initial?.name}` : `Read guidance · ${initial?.name}`;
      this.history.addTool(request.id, context.conversationId, context.runId, name, label, toolDisplayText(request.displayText)); this.changed(context.conversationId);
      try {
        if (authorization) {
          const scope = () => this.conversationScope(context, name, authorization().scope);
          let approved = this.extensionGrants.get(context.runId)?.has(`${name}:${scope()}`) || this.history.hasConversationGrant(context.conversationId, scope());
          if (authorization().rule === 'ask' && !approved) approved = await this.ask(context, request.id, name, label, 'Read this installed skill’s packaged guidance. No account, file, or command access is granted.', () => { if (authorization().rule === 'deny') throw new Error('Revoked.'); }, request.approvalText, scope);
          if (authorization().rule === 'deny' || authorization().rule === 'ask' && !approved) { this.history.finishTool(request.id, 'denied', 'Skill guidance was denied.'); return JSON.stringify({ error: 'This skill was denied. Do not work around this decision.' }); }
        }
        let result: unknown;
        if (name === 'draft_skill') result = await this.plugins.draftSkill(context.conversationId, toolArguments.draft_skill.parse(request.input));
        else if (name === 'search_skills') { const values = toolArguments.search_skills.parse(request.input); result = this.plugins.searchSkills(context.runId, context.conversationId, values.query, values.offset); }
        else if (name === 'load_skill') { const values = toolArguments.load_skill.parse(request.input); result = this.plugins.loadSkill(context.runId, context.conversationId, values.skillId); }
        else { const values = toolArguments.read_skill_reference.parse(request.input); result = await this.plugins.loadSkillReference(context.runId, context.conversationId, values.skillId, values.path, values.offset); }
        context.signal.throwIfAborted(); const output = JSON.stringify(result); this.history.finishTool(request.id, 'success', output); this.changed(context.conversationId); return output;
      } catch (error) { const message = error instanceof Error && error.message.length < 300 ? error.message : 'The skill could not be used. Review it in the Skills hub.'; this.history.finishTool(request.id, context.signal.aborted ? 'cancelled' : 'error', message); this.changed(context.conversationId); return JSON.stringify({ error: message }); }
    }
    if (name === 'generate_image') {
      this.history.addTool(request.id, context.conversationId, context.runId, name, 'Generate an image', toolDisplayText(request.displayText)); this.changed(context.conversationId);
      try {
        if (!this.imageGeneration) throw new Error('No compatible image models are available. Connect an image provider in Configuration.');
        if (this.settings().toolPermissions.read === 'deny') { this.history.finishTool(request.id, 'denied', 'Blocked by your tool preference.'); return JSON.stringify({error:'Image tools are disabled.'}); }
        const values = toolArguments.generate_image.parse(request.input);
        const reference = values.reference ? this.imageGeneration.source(context.conversationId, values.reference.slice('tinygpt-image:'.length)).image! : undefined;
        let model = await this.imageGeneration.selected(!!reference, values.transparent);
        let approved = manual || this.grants.get(context.runId)?.has('read') || this.history.hasConversationGrant(context.conversationId, this.conversationScope(context, name));
        if (!model) {
          const models = (await this.imageGeneration.models()).models.filter(item => (!reference || item.editing) && (!values.transparent || item.transparency));
          if (!models.length) throw new Error('No compatible image models are available. Connect an image provider in Configuration.');
          const accepted = await this.ask(context, request.id, name, 'Choose an image model', values.prompt, undefined, undefined, undefined, models);
          if (!accepted) { this.history.finishTool(request.id, 'denied', 'Image generation declined.'); return JSON.stringify({error:'Image generation declined by the user. Do not bypass this decision.'}); }
          approved = true;
          model = await this.imageGeneration.selected(!!reference, values.transparent);
        }
        if (this.settings().toolPermissions.read === 'ask' && !approved) approved = await this.ask(context, request.id, name, 'Generate an image', values.prompt, () => { if (this.settings().toolPermissions.read === 'deny') throw new Error('Revoked.'); }, request.approvalText, () => this.conversationScope(context, name));
        if (this.settings().toolPermissions.read === 'ask' && !approved) { this.history.finishTool(request.id, 'denied', 'Image generation declined.'); return JSON.stringify({error:'Image generation declined by the user. Do not bypass this decision.'}); }
        context.signal.throwIfAborted(); if (!model) throw new Error('Choose an image model to continue.');
        if (this.settings().toolPermissions.read === 'deny') throw new Error('Image generation was cancelled.');
        this.history.finishTool(request.id, 'running'); this.changed(context.conversationId);this.trace(context,{event:'tool-start',operationId:request.id,tool:name});
        const source = await this.imageGeneration.generate(context.conversationId, model, {...values, reference}, context.signal, values.reference?.slice('tinygpt-image:'.length));
        const result = JSON.stringify({sourceId:source.id,title:source.title,imageReference:'tinygpt-image:'+source.id}); this.history.finishTool(request.id,'success',result); return result;
      } catch(error) { if(context.signal.aborted){this.history.finishTool(request.id,'cancelled','Cancelled.');throw error;} const message=safeToolError(error);this.history.finishTool(request.id,'error',message);return JSON.stringify({error:message}); }
      finally {this.changed(context.conversationId);}
    }
    if (name === 'present') {
      if (conversation.mode === 'code') return JSON.stringify({ error: 'Interfaces are available in Chat conversations.' });
      this.history.addTool(request.id, context.conversationId, context.runId, name, 'Present an interface');
      this.history.finishTool(request.id, 'success', JSON.stringify({ ui: parsed.data }));
      this.changed(context.conversationId);
      return JSON.stringify({ presented: true });
    }
    if (name === 'request_plugin_connection') {
      if (!this.plugins) return JSON.stringify({ error: 'Plugins are unavailable.' });
      const ready = this.plugins.connectedConnectorTools(context.conversationId, context.runId, input.connector as import('../shared/plugins').SuggestedConnector);
      if (!forceConnection) for (const pluginId of new Set(ready.map(tool => tool.pluginId))) if (!await this.ensurePluginUse(context, pluginId)) return JSON.stringify({ error: 'The user declined this plugin for the task. Do not bypass this decision.', code: 'PLUGIN_USE_DENIED', executed: false });
      if (ready.length && !forceConnection) {
        const result = JSON.stringify({ status: 'connected', tools: ready.map(tool => ({ name: tool.name, action: tool.originalName })), message: input.connector === 'gmail' && ready.some(tool => tool.originalName === 'send_mail') ? 'Gmail is already connected and selected, including send access. No connection card is needed. For email to me/myself, call the declared send_mail_to_self tool with subject and text; the connector resolves the real recipient. That call automatically pauses for required send approval; it does not bypass approval.' : 'This plugin is connected and allowed in this chat. Load the needed actions with load_tools. Action permissions still apply.' });
        this.history.addTool(request.id, context.conversationId, context.runId, name, 'Check plugin connection', toolDisplayText(request.displayText), input.connector);
        this.history.finishTool(request.id, 'success', result); this.changed(context.conversationId); return result;
      }
      const proposed = this.plugins.proposeConnection(context.conversationId, input.connector as import('../shared/plugins').SuggestedConnector, input.reason);
      this.history.addTool(request.id, context.conversationId, context.runId, name, `Connect ${input.connector}`, toolDisplayText(request.displayText), input.connector);
      this.connectionWaits.add(context.runId); const result = JSON.stringify(proposed); this.history.finishTool(request.id, 'success', result); this.changed(context.conversationId); return result;
    }
    const destination = ['list_project_files', 'read_project_file', 'write_project_file'].includes(name) ? fileDestination(this.history, context.conversationId) : null;
    const access = name === 'browser_preview' ? ['browser', 'read'] as const : [category[name]];
    const setting = () => { const rules = access.map(key => this.settings().toolPermissions[key]); return rules.includes('deny') ? 'deny' : rules.includes('ask') ? 'ask' : 'allow'; };
    const summary = name === 'browser_preview' ? `Preview local app · ${input.path ?? 'index.html'}` : name === 'read_observation' ? 'Read a saved observation' : ['list_files', 'read_file', 'search_files', 'write_file', 'edit_file'].includes(name) ? `${name.replaceAll('_', ' ')} · ${input.path ?? '.'}` : name === 'copy_skill_files' ? 'Copy the original skill package into the Project' : name === 'view_image' ? `View image · ${input.image}` : name === 'browser_screenshot' ? 'Capture a browser screenshot' : name === 'create_project_directory' ? "Create folder " + input.path + " in " + (project?.name ?? 'the Project') : ['run_project_command', 'run_command'].includes(name) ? `Run ${input.executable} in ${project?.name ?? 'the Project'}` : name === 'edit_project_file' ? `Edit ${input.path} in ${project?.name ?? 'the Project'}` : name === 'review_project_changes' ? 'Review this conversation’s file changes' : name === 'search_web' ? `Search the web for “${input.query}”` : name === 'read_page' ? `Read ${input.url}` : name === 'search_sources' ? `Search saved sources for “${input.query}”` : name === 'write_project_file' ? `Write ${input.path} in ${destination!.generated ? 'Generated files' : project?.name ?? 'the Project'}` : name === 'read_project_file' ? `Read ${input.path} in ${destination!.generated ? 'Generated files' : project?.name ?? 'the Project'}` : name === 'list_project_files' ? `List ${input.path} in ${destination!.generated ? 'Generated files' : project?.name ?? 'the Project'}` : `${name.replaceAll('_', ' ')} · ${input.elementId ?? input.tabId}`;
    // Display text never changes the factual approval summary or execution arguments.
    this.history.addTool(request.id, context.conversationId, context.runId, name, summary, toolDisplayText(request.displayText), input.query ?? input.url ?? input.path ?? input.image); this.changed(context.conversationId);
    try {
      if (setting() === 'deny') { this.history.finishTool(request.id, 'denied', 'Blocked by your tool preference.'); return JSON.stringify({ error: 'This tool is blocked by the user. Do not try another tool to bypass the decision.' }); }
      let details = input.id ?? input.url ?? input.path ?? input.image ?? input.query ?? input.tabId ?? '';
      let target: BrowserTarget | undefined;
      if (name === 'browser_preview') details = `Workspace: ${workspace?.root ?? fileDestination(this.history, context.conversationId).root}\nEntry: ${input.path ?? 'index.html'}\nOpen a static local app and its web assets in TinyGPT’s interactive browser.`;
      if (name === 'copy_skill_files') details = 'Copy original scripts, references, assets and license into a new Project subfolder. Existing files are not replaced. No code runs or dependencies install.';
      if (name === 'write_file' || name === 'edit_file') details = `Workspace: ${workspace!.root}\nFile: ${input.path}\nChanges are saved for review and Undo.`;
      if (name === 'write_project_file') details = `Destination: ${destination!.root}\nFile: ${input.path}\nThis creates or replaces the UTF-8 file.\n\n${input.content}`;
      if (name === 'edit_project_file') details = `Project: ${project?.name}\nFile: ${input.path}\nExisting content must match the version read before editing. A diff is saved for review and undo.`;
      if (name === 'run_project_command') { const command = toolArguments.run_project_command.parse(request.input); details = `Working folder: ${workspace?.root ?? project?.rootPath}\nWorking directory: ${command.cwd}\nProgram: ${command.executable}\nArguments: ${JSON.stringify(command.args)}\nTimeout: ${command.timeoutSeconds}s\nThis process can access files and the network outside this folder; it is not an OS sandbox.`; }
      if (name === 'browser_click' || name === 'browser_type' || name === 'browser_hover') {
        target = await this.browser.describe(context.conversationId, input.tabId, input.elementId);
        details = `Page: ${target.url}\nElement: ${target.label || input.elementId} (${target.role})${name === 'browser_type' ? `\nText: ${input.text}` : ''}`;
      }
      const scope = () => this.conversationScope(context, name);
      let approved = manual || access.every(key => this.settings().toolPermissions[key] === 'allow' || this.grants.get(context.runId)?.has(key)) || this.history.hasConversationGrant(context.conversationId, scope());
      if (setting() === 'ask' && !approved) {
        approved = await this.ask(context, request.id, name, summary, details, () => { if (setting() === 'deny') throw new Error('Revoked.'); }, request.approvalText, scope);
        if (!approved) { this.history.finishTool(request.id, 'denied', 'Denied by the user.'); return JSON.stringify({ error: 'The user denied this action. Do not perform it or work around the denial.' }); }
      }
      context.signal.throwIfAborted();
      if (setting() === 'deny' || (setting() === 'ask' && !approved)) { this.history.finishTool(request.id, 'denied', 'Denied by the user.'); return JSON.stringify({ error: 'The user denied this action. Do not perform it or work around the denial.' }); }
      this.history.finishTool(request.id, 'running'); this.changed(context.conversationId);
      this.trace(context, { event: 'tool-start', operationId: request.id, tool: name });
      let result: unknown;
      const partition = this.browser.partition(project?.id ?? null, project?.browserIsolated ?? false);
      if (input.tabId && name.startsWith('browser_')) {
        if (name === 'browser_snapshot' || name === 'browser_screenshot') this.browser.prepareInteraction?.(context.conversationId, input.tabId, context.runId, false);
        else this.browser.prepareInteraction?.(context.conversationId, input.tabId, context.runId);
      }
      if (name === 'copy_skill_files') {
        const args = toolArguments.copy_skill_files.parse(request.input), copied: string[] = [];
        const packet = await this.plugins!.skillFiles(context.runId, context.conversationId, args.skillId), directory = `${args.destination.replace(/\/$/, '')}/${packet.name}`;
        if (setting() === 'deny') throw Error('Project access changed.'); checkCopyAccess!(); if (this.history.conversation(context.conversationId).projectId !== (project?.id ?? null)) throw Error('Project access changed.'); await this.files.createDirectory(workspace!.root, args.destination, context.signal); const target = await scopedPath(workspace!.root, directory, true); try { await lstat(target); throw Error('Choose a new destination folder; existing files will not be replaced.'); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause; }
        try { await mkdir(target); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'EEXIST') throw Error('Choose a new destination folder; existing files will not be replaced.'); throw cause; }
        try { for (const file of packet.files) { context.signal.throwIfAborted(); if (setting() === 'deny') throw Error('Project access changed.'); checkCopyAccess!(); if (this.history.conversation(context.conversationId).projectId !== (project?.id ?? null)) throw Error('Project access changed.'); const path = `${directory}/${file.path}`; await this.files.createDirectory(workspace!.root, dirname(path), context.signal); await this.files.writeNewPackageFile(workspace!.root, path, file.bytes, context.signal); copied.push(path); } result = { directory, files: copied, note: 'Original upstream package copied into the Project. No scripts were run and no dependencies were installed. Commands still require normal approval.' }; }
        catch { result = { directory, files: copied, error: 'Package copy stopped. These files were created; inspect them before retrying in a new folder.' }; }
      }
      else if (name === 'read_source') {
        const args = toolArguments.read_source.parse(request.input);
        const current = this.history.sources.detail(context.conversationId, args.sourceId);
        if (current.processing?.status === 'preparing') await this.prepareSources?.([current.id], context.signal);
        const source = this.history.sources.detail(context.conversationId, args.sourceId);
        const version = createHash('sha256').update(source.text).digest('hex');
        result = source.excluded ? { error: 'This source was excluded from retrieval by the user.', code: 'SOURCE_EXCLUDED', executed: false }
          : source.processing?.status === 'failed' ? { error: source.processing.notice, code: 'FILE_FAILED', executed: false }
          : source.processing?.status === 'preparing' ? { error: 'The document is still preparing.', code: 'FILE_PREPARING', executed: false }
          : args.version && args.version !== version ? { error: 'The document changed. Read its current first page before continuing.', code: 'SOURCE_CHANGED', executed: false }
          : { sourceId: source.id, title: source.title, citation: `[${source.title}](tinygpt-source:${source.id})`, version, processing: source.processing ?? { status: 'ready' }, ...(source.processing&&source.mime?.startsWith('image/')?{imageReference:'tinygpt-image:'+source.id,extraction:'ocr',visualVerification:{recommended:source.processing.status==='partial',guidance:'This text is OCR-derived, not a visual inspection. If layout, column ownership or critical values are uncertain, call view_image with this imageReference and a focused question before making a comparison. A ready status does not guarantee OCR accuracy.'}}:{}), offset: args.offset, totalCharacters: source.text.length, text: source.text.slice(args.offset, args.offset + args.limit), ...(args.offset + args.limit < source.text.length ? { nextOffset: args.offset + args.limit } : {}) };
      }
      else if (name === 'read_observation') {
        const args = toolArguments.read_observation.parse(request.input);
        let record;
        try { record = await this.observations.get(context.conversationId, args.id); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          let sourceExists = false;
          try { this.history.sources.detail(context.conversationId, args.id); sourceExists = true; } catch { /* No cross-conversation reference discovery. */ }
          result = sourceExists ? { error: 'This is a saved source ID, not an observation ID. Use read_source.', code: 'REFERENCE_TYPE_MISMATCH', nextRead: { tool: 'read_source', input: { sourceId: args.id, offset: args.offset, limit: args.limit } } } : { error: 'This saved observation is unavailable. Use the observationId returned by a tool in this conversation. A sourceId belongs to read_source; no Project file needs to be created.', code: 'OBSERVATION_UNAVAILABLE' };
        }
        if (record) {
        if (!this.history.conversation(context.conversationId).messages.some(message => message.runId === record.runId)) throw new Error('Observation is not on the selected conversation branch.');
        if (this.settings().toolPermissions[record.permission] === 'deny') throw new Error('Observation access was revoked.');
        if (record.workspace && fileDestination(this.history, context.conversationId).root !== record.workspace) throw new Error('The observation belongs to a different workspace.');
        if (record.workspace) for (const path of record.paths ?? []) await nativeCodePath(record.workspace, path, true);
        result = this.observations.page(record, args.offset, args.limit, args.query);
        }
      }
      else if (name === 'view_image') {
        const options = toolArguments.view_image.parse(request.input);
        const viewed = await this.images.view(context.conversationId, input.image, context.signal, options.crop);
        if (imageAssistant?.available()) {
          try {
            const question = options.question ?? 'Describe the visible image and any clearly readable text. Say which details are unclear.';
            const analysis = this.imageUnderstanding
              ? await this.imageUnderstanding.analyze(viewed, question, imageAssistant, context.signal, context.imageModel !== 'pro')
              : await imageAssistant.analyze(viewed.transport.image, question, context.signal);
            const result = { type: 'tinygpt-vision-result', ...viewed.metadata, model: context.imageModel === 'pro' ? builtInModels.pro.name : visionManifest.name, revision: context.imageModel === 'pro' ? proModelRevision : visionManifest.revision, question, ...analysis, notice: analysis.incomplete ? 'Analysis was truncated. Ask a narrower question or inspect a crop before drawing conclusions.' : 'Local model interpretation of untrusted pixels, not a host-verified fact. Verify exact values with readable source text where available.' };
            if ('notice' in analysis) result.notice = String(analysis.notice);
            this.history.finishTool(request.id, 'success', JSON.stringify(result)); return JSON.stringify(result);
          } catch (error) {
            if (context.signal.aborted) throw error;
            const result = { error: error instanceof VisionFailure ? error.message : 'Local image analysis was interrupted or timed out. Try a focused crop or question.', code: error instanceof VisionFailure ? error.code : 'VISION_INTERRUPTED' };
            this.history.finishTool(request.id, 'error', JSON.stringify(result)); return JSON.stringify(result);
          }
        }
        this.history.finishTool(request.id, 'success', JSON.stringify(viewed.metadata));
        return JSON.stringify(viewed.transport);
      }
      else if (name === 'browser_screenshot') result = await this.images.screenshot(context.conversationId, input.tabId, context.signal);
      else if (name === 'search_web') result = await this.browser.search(context.conversationId, partition, this.settings().browser.engine, input.query, context.signal, context.runId);
      else if (name === 'read_page') result = await this.savePage(context, await this.browser.page(context.conversationId, partition, input.url, context.signal, context.runId));
      else if (name === 'browser_preview') {
        const destination = workspace ?? await prepareFileDestination(this.history, context.conversationId, context.signal);
        const args = toolArguments.browser_preview.parse(request.input);
        result = await this.browser.preview(context.conversationId, partition, destination.root, args.path, context.signal, context.runId, () => {
          if (this.settings().toolPermissions.read === 'deny' || this.settings().toolPermissions.browser === 'deny' || fileDestination(this.history, context.conversationId).root !== destination.root) throw new Error('Local preview access was revoked or the workspace changed.');
        });
      }
      else if (name === 'browser_tabs') result = this.browser.listTabs(context.conversationId, partition, toolArguments.browser_tabs.parse(request.input));
      else if (name === 'browser_open') result = await this.browser.open(context.conversationId, partition, input.url, context.signal, context.runId);
      else if (name === 'browser_navigate') { const args = toolArguments.browser_navigate.parse(request.input); result = await this.browser.navigateAgent(context.conversationId, args.tabId, args.url, context.signal, args.reload === true); }
      else if (name === 'browser_snapshot') {
        const args = toolArguments.browser_snapshot.parse(request.input);
        if (args.waitUntil) {
          const waited = await waitForObservation(args.waitUntil, context.signal, async signal => {
            if (setting() === 'deny') throw Error('Browser reading was disabled while waiting.');
            const snapshot = await this.browser.snapshot(context.conversationId, args.tabId, signal, args);
            if (setting() === 'deny') throw Error('Browser reading was disabled while waiting.');
            return snapshot;
          }, snapshotEvidence);
          result = { pending: !waited.wait.matched, wait: waited.wait, ...waited.observation };
        } else result = await this.browser.snapshot(context.conversationId, args.tabId, context.signal, args);
      }
      else if (name === 'browser_click') {
        const args = toolArguments.browser_click.parse(request.input);
        const clicked = await this.browser.click(context.conversationId, args.tabId, args.elementId, context.signal, target);
        if (args.waitUntil) {
          let first = true;
          const waited = await waitForObservation(args.waitUntil, context.signal, async signal => {
            if (this.settings().toolPermissions.browser === 'deny') throw Error('Browser reading was disabled while waiting.');
            if (first) { first = false; return clicked; }
            return this.browser.snapshot(context.conversationId, args.tabId, signal);
          }, snapshotEvidence);
          result = { actionDispatched: true, pending: !waited.wait.matched, wait: waited.wait, ...waited.observation };
        } else result = clicked;
      }
      else if (name === 'browser_type') result = await this.browser.type(context.conversationId, input.tabId, input.elementId, input.text, context.signal, target);
      else if (name === 'browser_scroll') { const args = toolArguments.browser_scroll.parse(request.input); result = await this.browser.scrollAgent(context.conversationId, args.tabId, args.direction, args.pixels, context.signal); }
      else if (name === 'browser_hover') result = await this.browser.hover(context.conversationId, input.tabId, input.elementId, context.signal, target);
      else if (name === 'browser_press_key') result = await this.browser.pressKey(context.conversationId, input.tabId, input.key, context.signal);
      else if (name === 'browser_close') { this.browser.closeTab(context.conversationId, input.tabId); result = { closed: true }; }
      else if (name === 'list_files') result = await this.files.list(workspace!.root, input.path, context.signal);
      else if (name === 'read_file') { const args = toolArguments.read_file.parse(request.input); result = await this.workspaceFiles.read(context.conversationId, context.runId, args.path, args.offset, args.limit, context.signal); }
      else if (name === 'search_files') result = await this.workspaceFiles.search(context.conversationId, input.query, input.path, context.signal);
      else if (name === 'write_file' || name === 'edit_file') {
        const args = name === 'write_file' ? toolArguments.write_file.parse(request.input) : toolArguments.edit_file.parse(request.input);
        result = await this.workspaceFiles.write(context.conversationId, context.runId, args.path, 'content' in args ? args.content : '', context.signal, 'oldText' in args ? args : undefined);
      }
      else if (name === 'run_command') { const args = toolArguments.run_command.parse(request.input); const execute = (signal: AbortSignal, output?: (text: string) => void) => this.code.command(workspace!.root, args.executable, args.args, args.cwd, args.background ? args.timeoutSeconds : Math.min(120, args.timeoutSeconds), signal, output); result = args.background ? this.commandJobs.start(context.conversationId, context.runId, context.signal, execute) : await execute(context.signal); }
      else if (name === 'list_project_files') result = await this.files.list((await prepareFileDestination(this.history, context.conversationId, context.signal)).root, input.path, context.signal);
      else if (name === 'read_project_file') result = await this.files.read(context.conversationId, (await prepareFileDestination(this.history, context.conversationId, context.signal)).root, input.path, context.signal,conversation.mode === 'code' ? 100000 : 24000);
      else if (name === 'create_project_directory') result = await this.files.createDirectory(workspace?.root ?? project?.rootPath ?? null, input.path, context.signal);
      else if (name === 'edit_project_file') { const args = toolArguments.edit_project_file.parse(request.input); result = await this.code.edit(context.conversationId, context.runId, args.path, args.expectedContent, args.content, context.signal,args.expectedSha256); }
      else if (name === 'review_project_changes') result = { changes: this.history.codeChanges(context.conversationId).slice(-12) };
      else if (name === 'run_project_command') { const args = toolArguments.run_project_command.parse(request.input); const execute = (signal: AbortSignal, output?: (text: string) => void) => this.code.command(workspace?.root ?? project?.rootPath ?? null, args.executable, args.args, args.cwd, args.background ? args.timeoutSeconds : Math.min(120, args.timeoutSeconds), signal, output); result = args.background ? this.commandJobs.start(context.conversationId, context.runId, context.signal, execute) : await execute(context.signal); }
      else if (name === 'command_status') { const args = toolArguments.command_status.parse(request.input); result = await this.commandJobs.observe(context.conversationId, args.jobId, args.waitSeconds, context.signal); }
      else if (name === 'command_stop') { const args = toolArguments.command_stop.parse(request.input); result = await this.commandJobs.stop(context.conversationId, args.jobId); }
      else if (name === 'write_project_file') result = await this.code.write(context.conversationId, context.runId, input.path, input.content, context.signal);
      else {
        const args = toolArguments.search_sources.parse(request.input);
        const requested = args.sourceIds?.map(id => this.history.sources.detail(context.conversationId, id));
        const pending = requested?.filter(source => source.processing?.status === 'preparing' && !source.excluded).map(source => source.id) ?? [];
        if (pending.length) await this.prepareSources?.(pending, context.signal);
        result = { passages: this.memory ? await this.memory.search(context.conversationId, args.query, 8, context.signal, args.sourceIds) : args.sourceIds?.length ? this.history.sources.targetedLexical(context.conversationId, args.sourceIds, args.query).slice(0, 8) : this.history.sources.search(context.conversationId, args.query),
          ...(requested ? { files: requested.map(item => { const source = this.history.sources.detail(context.conversationId, item.id); return { sourceId: source.id, status: source.excluded ? 'excluded' : source.processing?.status ?? 'ready', ...(source.processing?.notice ? { notice: source.processing.notice } : {}) }; }) } : {}) };
      }
      context.signal.throwIfAborted();
      const serialized = JSON.stringify(result); this.history.finishTool(request.id, operationOutcome(result).status === 'failed' || operationOutcome(result).status === 'cancelled' ? 'error' : 'success', serialized); return serialized;
    } catch (error) {
      if (context.signal.aborted) { this.history.finishTool(request.id, 'cancelled', 'Cancelled.'); throw error; }
      if (error instanceof WorkspaceFileError) {
        const result = JSON.stringify({ error: error.message, code: error.code, tool: name, path: input.path, executed: false, nextAction: error.nextAction }); this.history.finishTool(request.id, 'error', result); return result;
      }
      if (['list_files', 'read_file', 'search_files', 'write_file', 'edit_file'].includes(name) && ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        const result = JSON.stringify({ error: `File or directory ${input.path} does not exist. Nothing was written.`, code: 'FILE_NOT_FOUND', tool: name, path: input.path, executed: false, nextAction: 'Use list_files to check the path, or write_file to create the file directly.' }); this.history.finishTool(request.id, 'error', result); return result;
      }
      const message = error instanceof BrowserActionError ? error.message : safeToolError(error); this.history.finishTool(request.id, 'error', message);
      if (name.startsWith('browser_') && message === 'This browser tab is not available to the conversation.') {
        return JSON.stringify({ error: message, code: 'BROWSER_TAB_UNAVAILABLE', retryable: true, nextAction: 'Browser tabs are temporary. Open the intended page again with browser_open and use its new tabId and accessibility references. Do not reuse historical references.' });
      }
      if (['browser_click', 'browser_type', 'browser_hover'].includes(name) && (error instanceof BrowserActionError || ['The element changed. Read a new browser snapshot.', 'The element is no longer visible. Read a new browser snapshot.'].includes(message))) {
        let snapshot: PageSnapshot | undefined;
        // Refresh only within an existing read grant. An interaction approval
        // never grants page reading, and a refresh never retries an action.
        if (this.settings().toolPermissions.browser === 'allow' || this.settings().toolPermissions.browser === 'ask' && (this.grants.get(context.runId)?.has('browser') || this.history.hasConversationGrant(context.conversationId, this.conversationScope(context, 'browser_snapshot')))) {
          try { snapshot = await this.browser.snapshot(context.conversationId, input.tabId, context.signal); }
          catch { if (context.signal.aborted) { this.history.finishTool(request.id, 'cancelled', 'Cancelled.'); throw new Error('Cancelled.'); } }
        }
        return JSON.stringify({ error: message, code: error instanceof BrowserActionError ? error.code : 'BROWSER_TARGET_STALE', retryable: true, ...(error instanceof BrowserActionError ? { actionDispatched: false, blockingDialog: error.blockingDialog } : {}), tabId: input.tabId, nextAction: error instanceof BrowserActionError ? 'Inspect the active dialog/overlay in the fresh snapshot. Do not retry the covered background control or close a dialog automatically. Choose a visible control consistent with the user’s task.' : snapshot ? 'Inspect the fresh accessibility snapshot and verify the page outcome. Retry only if still needed, using a current reference.' : 'Call browser_snapshot and verify the page outcome. Retry only if still needed, using a current reference.', ...(snapshot ? { snapshot } : {}) });
      }
      return JSON.stringify({ error: message });
    } finally { this.changed(context.conversationId); }
  }
  private async performComputer(context: ToolContext, request: ToolRequest, name: ComputerToolName): Promise<string> {
    if (!this.computer || !['chat', 'code'].includes(this.history.conversation(context.conversationId).mode ?? 'chat')) return JSON.stringify({ error: 'Desktop tools are available in Chat and Work.' });
    this.history.addTool(request.id, context.conversationId, context.runId, name, computerToolLabel(name, true)!, toolDisplayText(request.displayText));
    this.changed(context.conversationId);
    let started = false;
    try {
      let result = await this.computer.execute({ ...context, operationId: request.id, work: this.history.conversation(context.conversationId).mode === 'code' }, name, request.input, async authorization => {
        const rule = () => this.computer?.enabled() ? this.settings().toolPermissions[authorization.permission] : 'deny';
        if (rule() === 'deny') return false;
        // Scope desktop grants to the concrete native window. A browser grant,
        // another window or another tool category cannot authorize this call.
        const scope = () => this.conversationScope(context, 'computer_read_window', JSON.stringify([authorization.permission, authorization.scope, context.inferenceScope ?? [this.settings().route, this.settings().local.endpoint, this.settings().byok.endpoint]]));
        let approved = !authorization.forceOnce && (this.extensionGrants.get(context.runId)?.has(`computer:${scope()}`) || this.history.hasConversationGrant(context.conversationId, scope()));
        if (authorization.forceOnce || rule() === 'ask' && !approved) approved = await this.ask(context, request.id, name, authorization.summary, authorization.details, () => { if (rule() === 'deny') throw Error('Revoked.'); }, undefined, authorization.forceOnce ? undefined : scope, undefined, authorization.forceOnce === true);
        context.signal.throwIfAborted();
        if (rule() === 'deny' || (authorization.forceOnce || rule() === 'ask') && !approved) return false;
        if (!started) { started = true; this.history.finishTool(request.id, 'running'); this.trace(context, { event: 'tool-start', operationId: request.id, tool: name }); this.changed(context.conversationId); }
        return true;
      });
      if (name === 'computer_screenshot' && result && typeof result === 'object' && 'image' in result && typeof result.image === 'string') {
        const pixels = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(result.image);
        if (!pixels || pixels[1].length > 20971520) throw new ComputerFailure('COMPUTER_CAPTURE_UNAVAILABLE', 'The window screenshot was too large or unreadable.');
        result = this.images.saveCapture(context.conversationId, Buffer.from(pixels[1], 'base64'), 'Window screenshot', { windowId: String((request.input as { windowId: string }).windowId) });
        this.computer.retainCapture(context.runId, request.id, result);
      }
      const output = JSON.stringify(result);
      this.history.finishTool(request.id, result && typeof result === 'object' && 'error' in result ? 'error' : 'success', output);
      return output;
    } catch (error) {
      if (context.signal.aborted) { this.history.finishTool(request.id, 'cancelled', 'Cancelled.'); throw error; }
      const message = error instanceof ComputerFailure ? error.message : 'The computer-use runtime could not finish. Check Settings → Computer use, then read a fresh window state before retrying.';
      const failure = { ...(error instanceof ComputerFailure && error.recovery ? { recovery: error.recovery } : {}), error: message, code: error instanceof ComputerFailure ? error.code : 'COMPUTER_UNAVAILABLE', ...(error instanceof ComputerFailure && error.manualDraft !== undefined ? { manualDraft: error.manualDraft, instruction: 'Offer manualDraft verbatim for the user to paste. It is the requested replacement, not the current field contents. Do not offer to retry the edit.' } : {}), ...(error instanceof ComputerFailure && error.snapshot ? { snapshot: error.snapshot, verified: false, retryAllowed: false } : {}) };
      const output = JSON.stringify(failure);
      this.history.finishTool(request.id, error instanceof ComputerFailure && error.code === 'COMPUTER_DENIED' ? 'denied' : 'error', error instanceof ComputerFailure ? output : message);
      return output;
    } finally { this.changed(context.conversationId); }
  }
  private async performExtension(context: ToolContext, request: ToolRequest): Promise<string> {
    let added = false;
    try {
      if (!this.plugins) throw new Error('Plugins are unavailable.');
      const authorization = () => this.plugins!.authorizedTool(context.runId, context.conversationId, request.name, request.input);
      const first = authorization();
      const summary = `${first.tool.label} · ${this.plugins.store.entry(first.tool.pluginId).manifest.name}`;
      this.history.addTool(request.id, context.conversationId, context.runId, request.name, summary, toolDisplayText(request.displayText), first.tool.label); added = true; this.changed(context.conversationId);
      const rule = () => { const global = this.settings().toolPermissions[first.tool.category]; const local = authorization().rule; return global === 'deny' || local === 'deny' ? 'deny' : global === 'ask' || local === 'ask' ? 'ask' : 'allow'; };
      if (rule() === 'deny') { this.history.finishTool(request.id, 'denied', 'Blocked by your tool preference.'); return JSON.stringify({ error: 'This plugin tool is blocked. Do not bypass the decision.' }); }
      if (!await this.ensurePluginUse(context, first.tool.pluginId)) { const result = JSON.stringify({ error: 'The user declined this plugin for the task. Do not bypass this decision.', code: 'PLUGIN_USE_DENIED', executed: false }); this.history.finishTool(request.id, 'denied', result); return result; }
      const scope = () => this.conversationScope(context, request.name, authorization().grantScope);
      const usage = this.plugins.useAuthorization(context.conversationId, first.tool.pluginId);
      let approved = first.tool.category === 'read' && !!usage && this.history.hasConversationGrant(context.conversationId, usage.scope) || this.extensionGrants.get(context.runId)?.has(request.name) || this.history.hasConversationGrant(context.conversationId, scope());
      if (rule() === 'ask' && !approved) approved = await this.ask(context, request.id, request.name, summary, first.details, () => { if (rule() === 'deny') throw new Error('Revoked.'); }, request.approvalText, scope);
      context.signal.throwIfAborted();
      if (rule() === 'deny' || rule() === 'ask' && !approved) { this.history.finishTool(request.id, 'denied', 'Denied by the user.'); return JSON.stringify({ error: 'The user denied this action. Do not perform it or work around the denial.' }); }
      this.history.finishTool(request.id, 'running'); this.changed(context.conversationId);
      this.trace(context, { event: 'tool-start', operationId: request.id, tool: 'extension' });
      const result = await this.plugins.execute(context.runId, context.conversationId, request.name, request.input, context.signal); this.history.finishTool(request.id, 'success', result); return result;
    } catch (error) {
      const text = context.signal.aborted ? 'Cancelled.' : JSON.stringify(connectorFailure(error));
      if (added) this.history.finishTool(request.id, context.signal.aborted ? 'cancelled' : 'error', text);
      if (context.signal.aborted) throw error; return text;
    } finally { this.changed(context.conversationId); }
  }
  private async savePage(context: ToolContext, page: PageSnapshot) {
    context.signal.throwIfAborted();
    if (page.challenge) throw new Error('The page still needs manual login, consent, or verification.');
    const source = this.history.sources.add(context.conversationId, { kind: 'page', title: page.title, text: page.text, url: page.url });
    return { ...page, sourceId: source.id, citation: `[${source.title}](tinygpt-source:${source.id})` };
  }
  async userPage(conversationId: string, url: string): Promise<{ page: PageSnapshot; sourceId?: string }> {
    const controller = new AbortController(); const runId = randomUUID(); this.manual.set(runId, controller); this.manualConversations.set(runId, conversationId); const finished = this.trackManual();
    try {
      const result = JSON.parse(await this.perform({ conversationId, runId, signal: controller.signal }, { id: randomUUID(), name: 'read_page', input: { url } }, true));
      if (result.error) throw new Error(result.error); return { page: result, sourceId: result.sourceId };
    } finally { this.manual.delete(runId); this.endRun(runId); finished(); }
  }
  async userSearch(conversationId: string, query: string, engine: SearchEngine): Promise<WebSearch> {
    passwordPrivacy.assert();
    if (this.settings().toolPermissions.browser === 'deny') throw new Error('Browser tools are disabled in Settings.');
    const controller = new AbortController(); const runId = randomUUID(); this.manual.set(runId, controller); this.manualConversations.set(runId, conversationId); const finished = this.trackManual();
    try {
      const conversation = this.history.conversation(conversationId); const project = conversation.projectId ? this.history.project(conversation.projectId) : null;
      const id = randomUUID(); this.history.addTool(id, conversationId, runId, 'search_web', `Search the web for “${query}”`); this.history.finishTool(id, 'running'); this.changed(conversationId);
      try { const result = await this.browser.search(conversationId, this.browser.partition(project?.id ?? null, project?.browserIsolated ?? false), engine, query, controller.signal, runId); this.history.finishTool(id, 'success', JSON.stringify(result)); return result; }
      catch (error) { this.history.finishTool(id, controller.signal.aborted ? 'cancelled' : 'error', safeToolError(error)); throw error; }
    } finally { this.manual.delete(runId); this.endRun(runId); this.changed(conversationId); finished(); }
  }
  cancelManual(conversationId?: string): void { for (const [runId, controller] of this.manual) if (!conversationId || this.manualConversations.get(runId) === conversationId) controller.abort(); }
  endRun(runId: string): void { const retainBotTabs = this.retainedBotBrowserRuns.delete(runId); this.workspaceFiles.endRun(runId); void this.commandJobs.endRun(runId); this.computer?.endRun(runId); this.native.endRun(runId); this.browser.endRun?.(runId, id => { try { return retainBotTabs && this.history.conversation(id).mode === 'bot'; } catch { return false; } }); this.connectionWaits.delete(runId); this.grants.delete(runId); this.extensionGrants.delete(runId); this.deniedPluginUses.delete(runId); this.manualConversations.delete(runId); this.plugins?.endRun(runId); }
  async shutdown(): Promise<void> { await this.commandJobs.shutdown(); this.computer?.stop(); this.revokeUnavailableExtensions(); this.imageGeneration?.close(); this.cancelManual(); this.browser.shutdown(); this.imageUnderstanding?.close(); await this.localVision?.close(); await Promise.allSettled([...this.inflight, ...this.manualDone]); await this.computer?.shutdown(); }
}

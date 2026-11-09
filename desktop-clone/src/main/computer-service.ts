import { passwordPrivacy } from './password-privacy';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import { computerAppName, computerArguments, type ComputerElement, type ComputerReadOptions, type ComputerSnapshot, type ComputerStatus, type ComputerToolName, type ComputerWindow } from '../shared/computer';
import { projectComputerRead } from './computer-read';
import { activateComputerWindow, type ActivateWindow } from './computer-window';
import { WAIT_EVIDENCE, outlineTexts, snapshotEvidence, waitForObservation, type WithWaitEvidence } from '../core/wait-until';
import type { Settings } from '../shared/config';
import { ComputerFailure, CUA_VERSION, type ComputerDriver, type ComputerDriverFactory, type ComputerResource, type NativeComputerTool } from './computer-driver';

export interface ComputerContext { conversationId: string; runId: string; signal: AbortSignal; operationId: string; work?: boolean }
export interface ComputerAuthorization { permission: keyof Settings['toolPermissions']; scope: string; summary: string; details: string; forceOnce?: boolean }
export type ComputerAuthorize = (request: ComputerAuthorization) => Promise<boolean>;
type NativeWindow = { pid: number; window_id: number; app_name: string; title: string; minimized?: boolean; bundle_id?: string | null };
type Target = { public: ComputerWindow; native: NativeWindow; resource: ComputerResource };
type Element = ComputerElement & { nativeId: string; identity: string; fingerprint: string; fullValue?: string };
type Snapshot = { public: ComputerSnapshot; elements: Map<string, Element>; context: string; fullContext: string; capturedAt: number; options: ComputerReadOptions };
type DriverLease = { opened: number; used: number };
// The pinned driver grants 15 minutes total and 5 minutes idle. Renew before
// either native ceiling, never by retrying a rejected or ambiguous operation.
const expiredLease = (lease: DriverLease) => Date.now() - lease.used >= 4 * 60_000 || Date.now() - lease.opened >= 14 * 60_000;
type Run = { conversationId: string; controller: AbortController; windows: Map<string, Target>; snapshots: Map<string, Snapshot>; drivers: Map<string, Promise<ComputerDriver>>; operations: Map<string, { fingerprint: string; result: Promise<unknown> }>; actions: number; writes: Map<string, string>; reads: number; denied: boolean; expires: number; elementPrefix: string; nextElement: number; blockedWrites: Set<string>; staleActions: Map<string, number>; failedReads: Map<string, { state: string; count: number }> };
const nativeWindowsSchema = z.object({ windows: z.array(z.object({ pid: z.number().int().positive(), window_id: z.number().int().nonnegative(), app_name: z.string(), title: z.string(), minimized: z.boolean().optional(), bundle_id: z.string().nullable().optional() }).passthrough()) }).passthrough();
const terminal = /(?:^|[\\/\s.])(cmd|powershell|pwsh|windowsterminal|conhost|terminal|iterm2?|wezterm|alacritty|bash|zsh|wsl)(?:[\\/\s.]|$)/i;
const text = (value: unknown, limit = 500) => typeof value === 'string' ? value.slice(0, limit) : '';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const resourceKey = (resource: ComputerResource) => resource.bundleId ?? resource.executable!;
const elementIdentity = (value: Record<string, unknown>) => digest([text(value.role, 80), text(value.label ?? value.name, 240), value.automation_id ?? value.identifier, value.frame]);
const blockedWriteKey = (target: Target, element: ComputerElement) => digest([target.public.id, element.role, element.label]);
// UIA may expose a transfer counter as a Button rather than static text. Its
// changing number must not invalidate a different, unchanged action control.
// Its own label/fingerprint still changes, so old references to it remain stale.
const measurementLabel = /^\s*[+-]?[\d,.]+\s*(?:%|(?:[kmgt]?i?[bB]|[kmgt]?[bB]ps|[kmgt]?Hz|ms|s|sec|seconds?)(?:\/s)?)\s*$/i;
function observedChanges(before: ComputerSnapshot, after: ComputerSnapshot) {
  const rows = (snapshot: ComputerSnapshot) => snapshot.elements.filter(element => !element.protected).map(({ role, label, value }) => ({ role, label, ...(value !== undefined ? { value } : {}) }));
  const old = rows(before), current = rows(after);
  const oldKeys = new Set(old.map(row => JSON.stringify(row))), currentKeys = new Set(current.map(row => JSON.stringify(row)));
  return { added: current.filter(row => !oldKeys.has(JSON.stringify(row))).slice(0, 20), removed: old.filter(row => !currentKeys.has(JSON.stringify(row))).slice(0, 20), notice: 'Observed changes are evidence to assess the requested outcome, not automatic proof of task completion.' };
}
export function computerRisk(label: string): ComputerAuthorization['permission'] | undefined {
  label = label.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ');
  if (/\b(buy|purchase|pay|checkout|transfer|order now)\b/i.test(label)) return 'purchase';
  if (/\b(send|submit|publish|post|share|invite|reply all)\b/i.test(label)) return 'send';
  if (/\b(delete|remove|erase|trash|discard|overwrite|replace|save|close|reset)\b/i.test(label)) return 'write';
  if (/\b(run|execute|install|uninstall|authorize|grant|approve|confirm|proceed|continue|accept|apply|finish|done|yes|ok)\b/i.test(label)) return 'execute';
}

export class ComputerService {
  // Remember metadata aliases, never control snapshots, native clients or grants.
  private knownWindows = new Map<string, Map<string, Target>>();
  private referenceSession = randomBytes(2).toString('hex');
  private nextWindow = 0;
  private runs = new Map<string, Run>();
  private ended = new Set<string>();
  private discovery?: Promise<ComputerDriver>;
  private discoveryLease?: DriverLease;
  private driverLeases = new WeakMap<Run, Map<string, DriverLease>>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = new Set<Promise<unknown>>();
  private lease?: string;
  private paused = false;
  private closed = false;
  constructor(private factory: ComputerDriverFactory, private settings: () => Settings, private executable: (pid: number) => string | undefined, private platform = process.platform, private ownPid = process.pid, private permissionsReady: () => boolean = () => true, private activate: ActivateWindow = activateComputerWindow) {}
  enabled(): boolean { return !this.closed && !this.paused && this.settings().computer.enabled && this.permissionsReady(); }
  async status(): Promise<ComputerStatus> {
    const available = await this.factory.available();
    return { available, enabled: this.settings().computer.enabled, paused: this.paused, platform: this.platform, version: CUA_VERSION, activeSessions: this.runs.size, stopShortcut: 'CommandOrControl+Shift+Backspace', message: !available ? 'The bundled computer-use runtime is unavailable.' : this.paused ? 'Computer use is stopped. Resume it here when ready.' : this.settings().computer.enabled ? 'Computer tools are available in regular Chat. Window reading and control have separate approvals.' : 'Computer tools are turned off.' };
  }
  private assertEnabled(): void {
    passwordPrivacy.assert();
    if (!this.enabled()) throw new ComputerFailure('COMPUTER_DISABLED', 'Computer use is off or stopped. Enable or resume it in Settings → Computer use.');
  }
  private run(context: ComputerContext): Run {
    this.assertEnabled();
    if (this.ended.has(context.runId)) throw new ComputerFailure('COMPUTER_SESSION_ENDED', 'This computer session ended. Start a new chat request; do not resume old actions.');
    let run = this.runs.get(context.runId);
    if (!run) {
      if (this.runs.size >= 8) throw new ComputerFailure('COMPUTER_BUSY', 'Finish the current computer-use chats before starting another.');
      run = { conversationId: context.conversationId, controller: new AbortController(), windows: new Map(), snapshots: new Map(), drivers: new Map(), operations: new Map(), actions: 0, writes: new Map(), reads: 0, denied: false, expires: Date.now() + 15 * 60_000, elementPrefix: `s${randomBytes(4).toString('hex')}`, nextElement: 0, blockedWrites: new Set(), staleActions: new Map(), failedReads: new Map() };
      this.runs.set(context.runId, run);
    }
    if (context.work && run.conversationId === context.conversationId && !run.denied && Date.now() >= run.expires) run.expires = Date.now() + 15 * 60_000;
    if (run.conversationId !== context.conversationId || run.denied || Date.now() >= run.expires) throw new ComputerFailure('COMPUTER_SESSION_ENDED', 'This computer session expired or was denied. Do not bypass the decision. Start a new request when ready.');
    context.signal.throwIfAborted(); run.controller.signal.throwIfAborted();
    return run;
  }
  execute(context: ComputerContext, name: ComputerToolName, raw: unknown, authorize: ComputerAuthorize): Promise<unknown> {
    let run: Run;
    try { run = this.run(context); } catch (error) { return Promise.reject(error); }
    const fingerprint = digest([name, raw]);
    const prior = run.operations.get(context.operationId);
    if (prior) return prior.fingerprint === fingerprint ? prior.result : Promise.reject(new ComputerFailure('COMPUTER_OPERATION_CONFLICT', 'This operation ID was already used for a different action.'));
    const result = this.queue.catch(() => undefined).then(() => this.perform(context, run, name, raw, authorize)).catch(error => {
      if (error instanceof ComputerFailure && ['permission_denied', 'capability_denied'].includes(error.code)) run.denied = true;
      throw error;
    });
    run.operations.set(context.operationId, { fingerprint, result });
    this.queue = result;
    return result;
  }
  private async approve(context: ComputerContext, run: Run, authorize: ComputerAuthorize, request: ComputerAuthorization): Promise<void> {
    const signal = AbortSignal.any([context.signal, run.controller.signal]);
    let abort = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new ComputerFailure('COMPUTER_CANCELLED', 'Computer use was stopped. No further desktop actions will run for this request.')); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); });
    let approved: boolean;
    try { approved = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return authorize(request); }), cancelled]); }
    finally { signal.removeEventListener('abort', abort); }
    if (!approved) { run.denied = true; throw new ComputerFailure('COMPUTER_DENIED', 'The user denied this computer action. Do not repeat it or use another tool to bypass the decision.'); }
    run.controller.signal.throwIfAborted();
    this.run(context); this.assertEnabled();
  }
  private async discoveryDriver(): Promise<ComputerDriver> {
    if (this.discovery && this.discoveryLease && expiredLease(this.discoveryLease)) { this.trackClose(this.discovery); this.discovery = undefined; }
    if (!this.discovery) { this.discoveryLease = { opened: Date.now(), used: Date.now() }; this.discovery = this.factory.open().catch(error => { this.discovery = undefined; throw error; }); }
    this.discoveryLease!.used = Date.now();
    return this.discovery;
  }
  private async driver(run: Run, target: Target, work = false): Promise<ComputerDriver> {
    const key = resourceKey(target.resource);
    let driver = run.drivers.get(key);
    let leases = this.driverLeases.get(run);
    if (!leases) { leases = new Map(); this.driverLeases.set(run, leases); }
    const lease = leases.get(key);
    if (driver && lease && expiredLease(lease)) { this.trackClose(driver); run.drivers.delete(key); driver = undefined; }
    if (!driver) {
      if (run.drivers.size >= 2) {
        if (!work) throw new ComputerFailure('COMPUTER_APP_LIMIT', 'This task reached its two-application limit. Finish this request before working in another app.');
        const oldest = [...run.drivers.keys()].sort((a, b) => (leases!.get(a)?.used ?? 0) - (leases!.get(b)?.used ?? 0))[0];
        this.trackClose(run.drivers.get(oldest)!); run.drivers.delete(oldest); leases.delete(oldest);
        for (const [windowId, window] of run.windows) if (resourceKey(window.resource) === oldest) run.snapshots.delete(windowId);
      }
      driver = this.factory.open(target.resource);
      run.drivers.set(key, driver);
      leases.set(key, { opened: Date.now(), used: Date.now() });
    }
    leases.get(key)!.used = Date.now();
    return driver;
  }
  private claim(context: ComputerContext): void {
    if (this.lease && this.lease !== context.runId) throw new ComputerFailure('COMPUTER_BUSY', 'Another chat is using the computer. Finish or stop that reply first.');
    this.lease = context.runId;
  }
  private target(run: Run, windowId: string): Target {
    const target = run.windows.get(windowId) ?? this.knownWindows.get(run.conversationId)?.get(windowId);
    if (!target) throw new ComputerFailure('COMPUTER_WINDOW_STALE', 'This window reference is no longer available. Use computer_list_windows to find the current window.');
    if (this.platform === 'win32' && this.executable(target.native.pid)?.toLowerCase() !== target.resource.executable?.toLowerCase()) throw new ComputerFailure('COMPUTER_WINDOW_STALE', 'The application identity changed or its window closed. List windows again.');
    run.windows.set(windowId, target);
    return target;
  }
  private async capture(context: ComputerContext, run: Run, target: Target, options: ComputerReadOptions = {}, policy: { countRead?: boolean; scanAll?: boolean } = {}): Promise<Snapshot> {
    const signal = AbortSignal.any([context.signal, run.controller.signal]);
    if (policy.countRead !== false && ++run.reads > 50 && !context.work) throw new ComputerFailure('COMPUTER_READ_LIMIT', 'This task reached its desktop observation limit. Review progress before continuing.');
    const driver = await this.driver(run, target, context.work);
    signal.throwIfAborted(); this.assertEnabled();
    const previous = run.snapshots.get(target.public.id);
    run.snapshots.delete(target.public.id);
    const scanLimit = policy.scanAll || options.query || options.filter === 'inputs' || (options.offset ?? 0) > 0 || (options.textOffset ?? 0) > 0 ? 5000 : 1500;
    // Search/project the collected tree locally, before response caps. Native
    // query projection can otherwise hide the wider context used by preflight.
    const raw = await driver.call('get_window_state', { pid: target.native.pid, window_id: target.native.window_id, include_screenshot: false, include_accessibility_tree: true, full_output: true, tree_format: 'elements', max_elements: scanLimit, max_depth: 30, timeout_ms: 5000 }, signal);
    signal.throwIfAborted(); this.assertEnabled();
    if (raw.degraded || raw.pid !== undefined && raw.pid !== target.native.pid || raw.window_id !== undefined && raw.window_id !== target.native.window_id) throw new ComputerFailure('COMPUTER_STATE_UNAVAILABLE', 'The window could not be read reliably. Do not act on the previous snapshot.');
    const elements = new Map<string, Element>();
    if (!Array.isArray(raw.elements)) throw new ComputerFailure('COMPUTER_STATE_UNAVAILABLE', 'This window did not expose accessible elements. Use manual interaction.');
    if (run.nextElement + Math.min(raw.elements.length, 5000) * 2 > 999999) throw new ComputerFailure('COMPUTER_READ_LIMIT', 'This task reached its desktop observation limit. Review progress before continuing.');
    const identities = new Map<string, number>();
    for (const item of raw.elements) if (item && typeof item === 'object') { const identity = elementIdentity(item); identities.set(identity, (identities.get(identity) ?? 0) + 1); }
    const previousByIdentity = new Map<string, Element[]>();
    for (const element of previous?.elements.values() ?? []) previousByIdentity.set(element.identity, [...(previousByIdentity.get(element.identity) ?? []), element]);
    // Cua indexes actionable controls; readable static text lives only in the
    // outline. Keep those non-action rows and never leak native action indices.
    let readableText = typeof raw.tree_markdown === 'string' ? raw.tree_markdown.split('\n').filter(line => !/^\s*-\s*\[\d+\]/.test(line) && !/password|secure.?text/i.test(line)).join('\n') : '';
    for (const item of raw.elements) {
      if (!item || typeof item !== 'object') continue;
      const value = item as Record<string, unknown>;
      if (value.is_password === true || value.password === true || value.protected === true || /password|secure.?text/i.test(String(value.role) + ' ' + String(value.label ?? value.name))) {
        if (typeof value.value === 'string' && value.value) { readableText = readableText.replaceAll(value.value, '[protected]').replaceAll(JSON.stringify(value.value).slice(1, -1), '[protected]'); }
      }
    }
    for (const item of raw.elements.slice(0, 5000)) {
      if (!item || typeof item !== 'object') continue;
      const value = item as Record<string, unknown>;
      const nativeId = text(value.element_token, 32);
      if (!/^s[a-f0-9]{8}:\d{1,6}$/.test(nativeId)) continue;
      const identity = elementIdentity(value);
      const matches = previousByIdentity.get(identity) ?? [];
      const role = text(value.role, 80), label = text(value.label ?? value.name, 240);
      const protectedField = value.is_password === true || value.password === true || value.protected === true || /password|secure.?text/i.test(role + ' ' + label);
      const fullValue = protectedField ? undefined : typeof value.value === 'string' ? value.value : undefined;
      const fingerprint = digest([role, label, fullValue, value.frame, value.parent_index, value.enabled, value.readonly, value.read_only, value.is_read_only, protectedField]);
      const token = identities.get(identity) === 1 && matches.length === 1 && matches[0].fingerprint === fingerprint ? matches[0].id : `${run.elementPrefix}:${run.nextElement++}`;
      const element: Element = { id: token, nativeId, identity, role, label, ...(fullValue !== undefined ? { value: fullValue.slice(0, 2000), fullValue, ...(fullValue.length > 2000 ? { valueTruncated: true } : {}) } : {}), ...(protectedField ? { protected: true } : {}), ...(value.enabled === false || value.disabled === true || value.is_enabled === false ? { disabled: true } : {}), ...(value.readonly === true || value.read_only === true || value.is_read_only === true ? { readonly: true } : {}), fingerprint };
      if (run.blockedWrites.has(blockedWriteKey(target, element))) { element.writeSupport = 'manual'; element.writeNotice = 'Direct text replacement failed for this editor. Offer a draft to paste manually; do not retry the write.'; }
      elements.set(token, element);
    }
    // Passive status labels (timers, transfer rates) may update continuously.
    // Keep unchanged controls addressable; document, layout and interactive
    // changes still invalidate every old action reference. Consequential actions
    // and text replacements additionally compare the full observation below.
    const contextState = digest([readableText, [...elements.values()].filter(element => !/^(?:text|statictext|static text)$/i.test(element.role) && !(element.role.toLowerCase() === 'button' && measurementLabel.test(element.label))).map(element => element.fingerprint)]);
    const fullContext = digest([contextState, [...elements.values()].map(element => element.fingerprint)]);
    if (previous && previous.context !== contextState) {
      const ordered = [...elements.values()]; elements.clear();
      for (const element of ordered) {
        if (previous.elements.has(element.id)) element.id = `${run.elementPrefix}:${run.nextElement++}`;
        elements.set(element.id, element);
      }
    }
    const publicElements = [...elements.values()].map(({ nativeId: _nativeId, identity: _identity, fingerprint: _fingerprint, fullValue: _fullValue, ...element }) => element);
    const projection = projectComputerRead(target.public.id, publicElements, readableText, options, raw.elements_complete === true && raw.truncated !== true && raw.elements.length <= 5000, scanLimit);
    // Only controls actually returned to this model call are authorized targets.
    const visible = new Map(projection.elements.map(element => [element.id, { ...elements.get(element.id)!, ...element }]));
    const observedStatus = publicElements.filter(element => !element.protected && /^(?:text|statictext|static text|status|statusbar)$/i.test(element.role) && /^(?:unprotected|protected|not connected|disconnected|connected|connecting|disconnecting|offline|online|paused|running|stopped|ready|loading|saving|saved|failed|completed)$/i.test(element.label)).map(element => element.label);
    const snapshot: Snapshot = { public: { observedStatus: [...new Set(observedStatus)], windowId: target.public.id, app: computerAppName(text(raw.app_name, 120) || target.public.app, target.public.title), title: text(raw.window_title ?? raw.title, 300) || target.public.title, ...projection }, elements: visible, context: contextState, fullContext, capturedAt: Date.now(), options };
    (snapshot.public as ComputerSnapshot & WithWaitEvidence)[WAIT_EVIDENCE] = {
      texts: [...outlineTexts(readableText), ...publicElements.flatMap(element => element.protected ? [] : [element.label, element.value ?? ''])],
      complete: projection.coverage?.sourceComplete === true && !publicElements.some(element => element.valueTruncated),
    };
    signal.throwIfAborted();
    run.snapshots.set(target.public.id, snapshot);
    return snapshot;
  }
  private async perform(context: ComputerContext, run: Run, name: ComputerToolName, raw: unknown, authorize: ComputerAuthorize): Promise<unknown> {
    run.controller.signal.throwIfAborted();
    this.run(context);
    const args = computerArguments[name].parse(raw);
    if (name === 'computer_activate_window') {
      const { windowId } = computerArguments.computer_activate_window.parse(raw), target = this.target(run, windowId);
      await this.approve(context, run, authorize, { permission: 'desktopInteract', scope: `activate:${resourceKey(target.resource)}`, summary: `Restore ${target.public.app}`, details: `Restore the existing window “${target.public.title}” and bring it to the front. This may interrupt your typing. No controls will be clicked.`, forceOnce: true });
      await this.approve(context, run, authorize, { permission: 'desktop', scope: `read:${target.native.pid}:${target.native.window_id}:${resourceKey(target.resource)}`, summary: `Read ${target.public.app}`, details: 'Verify the restored window and return its current controls.' });
      this.claim(context); this.target(run, windowId); run.snapshots.delete(windowId);
      const result = await this.activate(target.native.pid, target.native.window_id, AbortSignal.any([context.signal, run.controller.signal]));
      context.signal.throwIfAborted(); this.assertEnabled(); this.target(run, windowId);
      if (result.restored) { target.public.minimized = false; target.native.minimized = false; }
      return { actionDispatched: true, ...result, verified: result.restored, ...(result.restored ? { snapshot: (await this.capture(context, run, target)).public } : { error: 'The window could not be restored. No control action was dispatched.', code: 'COMPUTER_ACTIVATION_UNAVAILABLE' }), notice: result.foreground ? 'The existing window was restored and brought to the front. Use the fresh controls.' : 'Foreground focus was not confirmed. Inspect the returned state before acting; do not assume input focus.' };
    }
    if (name === 'computer_open_app') {
      const opening = computerArguments.computer_open_app.parse(raw), requested = opening.app;
      await this.approve(context, run, authorize, { permission: 'desktop', scope: 'discover', summary: `Find ${computerAppName(requested)}`, details: 'Look up the installed app by name so it can be opened.' });
      const signal = AbortSignal.any([context.signal, run.controller.signal]);
      const result = await (await this.discoveryDriver()).call('list_apps', {}, signal);
      const normalize = (name: string) => name.toLowerCase().replace(/\.(exe|app)$/, '').replace(/[^a-z0-9]/g, '');
      const apps = Array.isArray(result.apps) ? result.apps.filter((app): app is Record<string, unknown> => !!app && typeof app === 'object') : [];
      const appId = (app: Record<string, unknown>) => 'app_' + digest([app.name, app.bundle_id, app.launch_path]).slice(0, 12);
      const matches = apps.filter(app => typeof app.name === 'string' && normalize(app.name) === normalize(requested) && (!opening.appId || appId(app) === opening.appId));
      if (matches.length > 1) { const error = new ComputerFailure('COMPUTER_APP_AMBIGUOUS', 'More than one installed app matches. Ask the user which app to open with work_ask_user, then call computer_open_app with the chosen appId.'); error.recovery = { kind: 'choose-app', candidates: matches.slice(0, 8).map(app => ({ appId: appId(app), label: String(app.name) + ' · ' + String(app.launch_path ?? app.bundle_id ?? 'Installed app') })) }; throw error; }
      let resource: ComputerResource | undefined;
      if (this.platform === 'win32' && ['notepad', 'calculator', 'calc'].includes(normalize(requested))) {
        resource = { executable: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', normalize(requested) === 'notepad' ? 'notepad.exe' : 'calc.exe'), launchOnly: true };
      } else if (matches.length === 1) {
        const app = matches[0];
        if (this.platform === 'darwin' && typeof app.bundle_id === 'string') resource = { bundleId: app.bundle_id, launchOnly: true };
        else if (typeof app.launch_path === 'string') {
          // Only a bare installed executable is accepted. Shortcut arguments,
          // shell links and document/URL launchers require manual opening.
          const executable = app.launch_path.replace(/^"([^"]+)"$/, '$1');
          if (/^[a-z]:\\[^"\r\n]+\.exe$/i.test(executable)) resource = { executable, launchOnly: true };
        }
      }
      if (!resource || terminal.test(`${requested} ${resource.executable ?? resource.bundleId}`)) throw new ComputerFailure('COMPUTER_MANUAL_REQUIRED', 'Open this application manually. Only an unambiguous installed app with a direct launcher is supported; terminals and shortcut arguments are not available.');
      if (resource.executable && !(await stat(resource.executable).catch(() => undefined))?.isFile()) throw new ComputerFailure('COMPUTER_MANUAL_REQUIRED', 'This launcher is not a direct application file. Open the app manually.');
      await this.approve(context, run, authorize, { permission: 'desktopInteract', scope: `launch:${resourceKey(resource)}`, summary: `Open ${computerAppName(requested)}`, details: `Launch ${computerAppName(requested)}. This may bring the app to the front.`, forceOnce: true });
      this.claim(context);
      if (run.actions++ >= 10 && !context.work) throw new ComputerFailure('COMPUTER_ACTION_LIMIT', 'This task reached its ten-action limit. Review progress before continuing.');
      const driver = await this.factory.open(resource);
      try {
        signal.throwIfAborted(); this.assertEnabled();
        await driver.call('launch_app', resource.bundleId ? { bundle_id: resource.bundleId } : { path: resource.executable }, signal);
        return { actionDispatched: true, app: requested, nextAction: 'Use computer_list_windows to find and read the application window. Do not repeat launch without checking whether it already opened.' };
      } finally { await driver.close(); }
    }
    if (name === 'computer_list_windows') {
      const app = 'app' in args ? args.app : undefined;
      await this.approve(context, run, authorize, { permission: 'desktop', scope: 'discover', summary: 'See which windows are open', details: `See app names and window titles${app ? ` matching “${computerAppName(app)}”` : ''}. Reading a window’s contents requires separate permission.` });
      const signal = AbortSignal.any([context.signal, run.controller.signal]);
      const driver = await this.discoveryDriver();
      // Unfiltered discovery has a metadata-only ceiling. Filtering is local:
      // a pid-specific call carries app authority in Cua's permission contract.
      const result = nativeWindowsSchema.parse(await driver.call('list_windows', {}, signal));
      let apps: Record<string, unknown>[] = [];
      if (this.platform === 'darwin') { const value = await driver.call('list_apps', {}, signal); if (Array.isArray(value.apps)) apps = value.apps; }
      this.run(context);
      const windows: ComputerWindow[] = [];
      let known = this.knownWindows.get(context.conversationId);
      if (!known) { known = new Map(); this.knownWindows.set(context.conversationId, known); }
      if (this.knownWindows.size > 16) this.knownWindows.delete(this.knownWindows.keys().next().value!);
      for (const item of result.windows) {
        if (item.pid === this.ownPid || !item.title.trim() || app && !`${item.app_name} ${item.title}`.toLowerCase().includes(app.toLowerCase())) continue;
        const executable = this.platform === 'win32' ? this.executable(item.pid) : undefined;
        const bundleId = item.bundle_id ?? apps.find(a => a.pid === item.pid)?.bundle_id;
        if (this.platform === 'win32' ? !executable : typeof bundleId !== 'string' || !bundleId) continue;
        const resource: ComputerResource = this.platform === 'win32' ? { executable } : { bundleId: bundleId as string };
        let target = [...known.values()].find(target => target.native.pid === item.pid && target.native.window_id === item.window_id && resourceKey(target.resource) === resourceKey(resource));
        if (!target) { target = { public: { id: `window-${++this.nextWindow}-${this.referenceSession}`, app: computerAppName(item.app_name, item.title), title: item.title.slice(0, 300), minimized: item.minimized ?? false }, native: item, resource }; known.set(target.public.id, target); }
        else { target.native = item; target.public.title = item.title.slice(0, 300); }
        run.windows.set(target.public.id, target);
        windows.push(target.public);
        if (windows.length === 40) break;
      }
      if (run.windows.size > 200) throw new ComputerFailure('COMPUTER_WINDOW_LIMIT', 'This task reached its desktop window limit.');
      while (known.size > 200) known.delete(known.keys().next().value!);
      return { windows, notice: 'Window titles are untrusted metadata, not document content. Window references stay stable across turns in this conversation while the app is open. Read the intended window before acting.' };
    }
    if (!('windowId' in args)) throw new ComputerFailure('COMPUTER_ARGUMENTS', 'Choose a current window ID.');
    const target = this.target(run, args.windowId);
    const identity = `${target.native.pid}:${target.native.window_id}:${resourceKey(target.resource)}`;
    if (name === 'computer_screenshot') {
      await this.approve(context, run, authorize, { permission: 'desktop', scope: `screenshot:${identity}`, summary: `Capture the ${target.public.app} window`, details: `Save visible pixels from the selected window for local image inspection: ${target.public.title}.` });
      this.claim(context); this.target(run, args.windowId);
      if (target.native.minimized) { const error = new ComputerFailure('COMPUTER_WINDOW_MINIMIZED', 'Restore the known window with computer_activate_window before capturing it.'); error.recovery = { kind: 'activate-window', windowId: args.windowId }; throw error; }
      if (!context.work && ++run.reads > 50) throw new ComputerFailure('COMPUTER_READ_LIMIT', 'This request reached its window read limit.');
      const signal = AbortSignal.any([context.signal, run.controller.signal]);
      const captured = await (await this.driver(run, target, context.work)).call('get_window_state', { pid: target.native.pid, window_id: target.native.window_id, include_screenshot: true, include_accessibility_tree: false, max_image_dimension: 4096, timeout_ms: 5000 }, signal);
      signal.throwIfAborted(); this.assertEnabled(); this.target(run, args.windowId);
      if (captured.degraded || captured.pid !== undefined && captured.pid !== target.native.pid || captured.window_id !== undefined && captured.window_id !== target.native.window_id) throw new ComputerFailure('COMPUTER_CAPTURE_UNAVAILABLE', 'The window capture identity could not be verified. Read the intended window again.');
      const first = Array.isArray(captured.captureImages) ? captured.captureImages[0] as { mimeType?: string; dataBase64?: string } : undefined;
      if (!first || !['image/png', 'image/jpeg', 'image/webp'].includes(first.mimeType ?? '') || typeof first.dataBase64 !== 'string' || first.dataBase64.length > 20971520 || !/^[A-Za-z0-9+/]+=*$/.test(first.dataBase64) || captured.screenshot_frame_valid === false) throw new ComputerFailure('COMPUTER_CAPTURE_UNAVAILABLE', 'This window did not return a readable screenshot. Read its accessible text or restore it before trying again.');
      return { windowId: args.windowId, title: target.public.title, image: `data:${first.mimeType};base64,${first.dataBase64}` };
    }
    if (name === 'computer_read_window') {
      const { windowId: _windowId, waitUntil, ...options } = computerArguments.computer_read_window.parse(raw);
      await this.approve(context, run, authorize, { permission: 'desktop', scope: `read:${identity}`, summary: `Read the ${target.public.app} window`, details: `Window: ${target.public.title}\nLet the selected model read the text and available controls in this window.${waitUntil ? `\nCheck for “${waitUntil.text}” to be ${waitUntil.state === 'absent' ? 'absent' : 'present'} for up to ${waitUntil.timeoutMs / 1000} seconds.` : ''}` });
      this.claim(context); this.target(run, args.windowId);
      if (waitUntil) {
        let first = true;
        const result = await waitForObservation(waitUntil, AbortSignal.any([context.signal, run.controller.signal]), async signal => {
          this.run({ ...context, signal }); this.target(run, args.windowId);
          if (this.settings().toolPermissions.desktop === 'deny') throw new ComputerFailure('COMPUTER_DENIED', 'Window reading was disabled while waiting.');
          const countRead = first; first = false;
          const snapshot = (await this.capture({ ...context, signal }, run, target, options, { countRead, scanAll: true })).public;
          if (this.settings().toolPermissions.desktop === 'deny') throw new ComputerFailure('COMPUTER_DENIED', 'Window reading was disabled while waiting.');
          return snapshot;
        }, snapshotEvidence);
        if (result.wait.timedOut) {
          // A cancelled native read can terminate its owned worker. Drop that
          // session and its control tokens before any later read or action.
          const key = resourceKey(target.resource), driver = run.drivers.get(key);
          run.drivers.delete(key); if (driver) this.trackClose(driver);
          for (const [id, window] of run.windows) if (resourceKey(window.resource) === key) run.snapshots.delete(id);
        }
        return { wait: result.wait, ...result.observation };
      }
      const snapshot = (await this.capture(context, run, target, options)).public;
      if (snapshot.elements.some(element => element.writeSupport === 'manual')) {
        const state = digest([snapshot.text, snapshot.elements.map(({ id: _id, ...element }) => element)]);
        const prior = run.failedReads.get(args.windowId);
        const count = prior?.state === state ? prior.count + 1 : 1;
        run.failedReads.set(args.windowId, { state, count });
        if (count >= 3) throw new ComputerFailure('COMPUTER_NO_PROGRESS', 'This editor still requires manual text entry and its contents have not changed. Stop rereading it. Give the user the draft to paste; do not try browser tools or another input method.');
      }
      return snapshot;
    }
    if (!('elementId' in args) || typeof args.elementId !== 'string') throw new ComputerFailure('COMPUTER_ARGUMENTS', 'Choose a current element reference.');
    if ((run.staleActions.get(args.windowId) ?? 0) >= 3) throw new ComputerFailure('COMPUTER_NO_PROGRESS', 'This window kept changing before its controls could be used. Stop retrying desktop actions in this window for this request. Explain the issue and offer manual steps; do not switch input tools.');
    const before = run.snapshots.get(args.windowId), element = before?.elements.get(args.elementId);
    if (!before || !element || Date.now() - before.capturedAt > 60_000) throw new ComputerFailure('COMPUTER_ELEMENT_STALE', 'The element reference is stale. Read the window again before acting.');
    if (name === 'computer_type' && run.blockedWrites.has(blockedWriteKey(target, element))) throw new ComputerFailure('COMPUTER_TEXT_WRITE_UNSUPPORTED', 'This editor could not accept direct text replacement. Stop retrying and give the user a draft to paste manually.');
    if (element.protected || element.disabled || terminal.test(`${target.public.app} ${target.resource.executable ?? target.resource.bundleId}`)) throw new ComputerFailure('COMPUTER_MANUAL_REQUIRED', 'Protected controls, disabled controls and terminal interaction require manual input.');
    if (name === 'computer_type' && (element.readonly || !/edit|text.?box|text.?field|text.?area|document|combo.?box/i.test(element.role))) throw new ComputerFailure('COMPUTER_MANUAL_REQUIRED', 'This accessible control is not a writable text field.');
    if (name === 'computer_type' && (element.valueTruncated || (element.fullValue?.length ?? 0) > 2000)) throw new ComputerFailure('COMPUTER_MANUAL_REQUIRED', 'This field is too long for a fully observed replacement. Use a smaller field or edit it manually.');
    const delivery = 'delivery' in args ? args.delivery : 'background';
    const key = name === 'computer_press_key' ? computerArguments.computer_press_key.parse(raw).key : undefined;
    const committingKey = key !== undefined && ['Enter', 'Space'].includes(key);
    const risk = committingKey ? computerRisk(element.label) ?? 'send' : name === 'computer_click' ? computerRisk(element.label) ?? (!element.label.trim() ? 'execute' : undefined) : undefined;
    const details = `Window: ${target.public.title}\n${name === 'computer_type' ? 'Text field' : 'Control'}: ${element.label || 'Selected control'}${'text' in args ? `\n\nReplace the field’s text with:\n${args.text}` : ''}${'key' in args ? `\nPress ${args.key}.` : ''}\n\n${delivery === 'foreground' ? 'This will bring the window to the front and may interrupt your typing.' : 'This will run in the background.'}${risk ? '\nThis may send, save, or confirm a change. Allow it only if that is what you intend.' : ''}`;
    await this.approve(context, run, authorize, { permission: 'desktopInteract', scope: `control:${identity}:${delivery}`, summary: `${name === 'computer_type' ? 'Write text in' : name === 'computer_click' ? 'Click a control in' : name === 'computer_scroll' ? 'Scroll' : 'Press a key in'} ${target.public.app}`, details, forceOnce: delivery === 'foreground' });
    if (risk) await this.approve(context, run, authorize, { permission: risk, scope: `commit:${context.operationId}`, summary: `Confirm ${risk === 'send' ? 'submission' : risk === 'purchase' ? 'purchase' : risk === 'write' ? 'change' : 'confirmation'} in ${target.public.app}`, details, forceOnce: true });
    this.claim(context); this.target(run, args.windowId);
    if (run.actions >= 10 && !context.work) throw new ComputerFailure('COMPUTER_ACTION_LIMIT', 'This task reached its ten-action limit. Review the observed result before continuing.');
    // Re-read after approval: never act on content the user changed while a card waited.
    const current = await this.capture(context, run, target, before.options);
    const fresh = [...current.elements.values()].find(candidate => candidate.id === element.id && candidate.fingerprint === element.fingerprint);
    if (!fresh || before.public.title !== current.public.title || before.context !== current.context || (risk || name === 'computer_type') && before.fullContext !== current.fullContext) {
      const attempts = (run.staleActions.get(args.windowId) ?? 0) + 1;
      run.staleActions.set(args.windowId, attempts);
      if (attempts >= 3) {
        const error = new ComputerFailure('COMPUTER_NO_PROGRESS', 'This window changed before three attempted actions. No action was dispatched. Stop retrying this window for this request and offer manual steps; do not switch input tools.');
        error.snapshot = current.public;
        throw error;
      }
      return { error: 'The window context or control changed while waiting. Inspect this fresh state before deciding what to do.', code: 'COMPUTER_ELEMENT_STALE', snapshot: current.public, actionDispatched: false };
    }
    run.staleActions.delete(args.windowId);
    if (name === 'computer_type' && 'text' in args) {
      const wanted = computerArguments.computer_type.parse(raw).text;
      if (fresh.fullValue === wanted) return { actionDispatched: false, verified: true, verification: 'The freshly observed field already contains the requested full text. No write was needed.', snapshot: current.public };
      const writeKey = digest([identity, element.identity]);
      if (run.writes.get(writeKey) === digest(wanted)) throw new ComputerFailure('COMPUTER_WRITE_ALREADY_ATTEMPTED', 'This same text was already submitted to this control in this task without a verified match. Do not repeat it; inspect the current state or use manual interaction.');
      run.writes.set(writeKey, digest(wanted));
    }
    const signal = AbortSignal.any([context.signal, run.controller.signal]);
    this.assertEnabled(); signal.throwIfAborted(); run.actions++;
    const nativeArgs: Record<string, unknown> = { target: { kind: 'window', pid: target.native.pid, window_id: target.native.window_id }, element_token: fresh.nativeId, delivery_mode: delivery };
    let tool: NativeComputerTool;
    if (name === 'computer_click') { tool = 'click'; nativeArgs.button = 'left'; nativeArgs.count = 1; }
    else if (name === 'computer_type' && 'text' in args) {
      // type_text is a keystroke/append API on some native controls. The public
      // tool promises replacement, so use the canonical UIA/AX value operation.
      tool = 'set_value'; delete nativeArgs.target;
      nativeArgs.pid = target.native.pid; nativeArgs.window_id = target.native.window_id; nativeArgs.value = args.text;
    }
    else if (key) { tool = 'press_key'; nativeArgs.key = ({ Enter: 'return', Escape: 'escape', ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', PageUp: 'pageup', PageDown: 'pagedown', Tab: 'tab', Home: 'home', End: 'end', Space: 'space' } as const)[key]; }
    else if (name === 'computer_scroll') { const scroll = computerArguments.computer_scroll.parse(raw); tool = 'scroll'; nativeArgs.direction = scroll.direction; nativeArgs.amount = scroll.amount; nativeArgs.by = 'line'; }
    else throw new ComputerFailure('COMPUTER_ARGUMENTS', 'The computer action is invalid.');
    // A dispatched/ambiguous mutation invalidates all old references, even on refusal.
    run.snapshots.delete(args.windowId);
    const driver = await this.driver(run, target, context.work);
    try { await driver.call(tool, nativeArgs, signal); }
    catch (error) {
      if (tool === 'set_value' && error instanceof ComputerFailure && error.code === 'COMPUTER_TEXT_WRITE_UNSUPPORTED') {
        run.blockedWrites.add(blockedWriteKey(target, element));
        error.manualDraft = String(nativeArgs.value);
        // A failed dispatch is not proof that the field stayed unchanged.
        // Supply fresh evidence once, without asking the model to retry writes.
        try { error.snapshot = (await this.capture(context, run, target, before.options)).public; } catch { /* Preserve the original failure when observation is unavailable. */ }
      }
      if (error instanceof ComputerFailure && error.code === 'COMPUTER_WINDOW_MINIMIZED') error.recovery = { kind: 'activate-window', windowId: args.windowId };
      throw error;
    }
    let after = await this.capture(context, run, target, before.options);
    const condition = name === 'computer_click' ? computerArguments.computer_click.parse(raw).waitUntil : undefined;
    if (condition) {
      let first = true;
      const waited = await waitForObservation(condition, signal, async () => {
        if (first) { first = false; return after.public; }
        after = await this.capture(context, run, target, before.options, { countRead: false, scanAll: true });
        return after.public;
      }, snapshotEvidence);
      return { actionDispatched: true, verified: waited.wait.matched, wait: waited.wait, observedChanges: observedChanges(current.public, after.public), snapshot: after.public };
    }
    const writtenMatches = name === 'computer_type' && 'text' in args ? [...after.elements.values()].filter(candidate => candidate.identity === fresh.identity) : [];
    const written = writtenMatches.length === 1 ? writtenMatches[0] : undefined;
    const verified = written !== undefined && 'text' in args && written.fullValue === args.text;
    return { actionDispatched: true, verified, verification: name === 'computer_type' ? verified ? 'The accessible field equals the requested full text.' : 'The field value was not verified. Do not type again without inspecting the current state.' : 'Input was dispatched. No expected postcondition was supplied, so verified:false does not mean the click failed. Assess observedChanges and the fresh snapshot before taking another action; do not click a completed step again.', observedChanges: observedChanges(current.public, after.public), snapshot: after.public };
  }
  retainCapture(runId: string, operationId: string, reference: unknown) { const operation = this.runs.get(runId)?.operations.get(operationId); if (operation) operation.result = Promise.resolve(reference); }
  endRun(runId: string): void {
    const run = this.runs.get(runId);
    if (!run) return;
    this.ended.add(runId); if (this.ended.size > 1024) this.ended.delete(this.ended.values().next().value!);
    run.controller.abort(); this.runs.delete(runId);
    if (this.lease === runId) this.lease = undefined;
    for (const driver of run.drivers.values()) this.trackClose(driver);
    if (!this.runs.size && this.discovery) { this.trackClose(this.discovery); this.discovery = undefined; }
  }
  private trackClose(driver: Promise<ComputerDriver>): void {
    const close = driver.then(value => value.close()).catch(() => undefined).finally(() => this.closing.delete(close));
    this.closing.add(close);
  }
  stop(): void {
    this.paused = true;
    for (const runId of [...this.runs.keys()]) this.endRun(runId);
    if (this.discovery) { this.trackClose(this.discovery); this.discovery = undefined; }
  }
  resume(): void { if (!this.closed) this.paused = false; }
  async shutdown(): Promise<void> { this.closed = true; this.stop(); this.knownWindows.clear(); await Promise.allSettled([this.queue, ...this.closing]); }
}

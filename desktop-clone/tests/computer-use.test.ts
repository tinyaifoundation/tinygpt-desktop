import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ComputerService, type ComputerAuthorization, type ComputerContext } from '../src/main/computer-service';
import { ComputerFailure, type ComputerDriverFactory, type ComputerResource } from '../src/main/computer-driver';
import { computerAppName, computerArguments, type ComputerSnapshot, type ComputerToolName, type ComputerWindow } from '../src/shared/computer';
import { defaultSettings, settingsSchema } from '../src/shared/config';
import { HistoryStore } from '../src/main/history';
import { ProjectFiles } from '../src/main/files';
import { ToolBroker } from '../src/main/tool-broker';
import { ChatService } from '../src/main/chat-service';
import type { BrowserController } from '../src/main/browser';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.useRealTimers(); });
function setup(activate = vi.fn(async (_pid: number, _window: number, signal: AbortSignal) => { signal.throwIfAborted(); return { restored: true, foreground: true }; })) {
  const settings = structuredClone(defaultSettings);
  const calls: { name: string; args: Record<string, unknown>; resource?: ComputerResource }[] = [];
  const state = { value: '', title: 'Test note', clicks: 0, sends: 0, extraControls: 0, nativeComplete: true, telemetry: false, telemetryRole: 'Text', mutateThenThrow: false, refuse: false, nativeDenied: false, unsupportedWrite: false, echo: true, executable: 'C:\\Fixture\\Notes.exe', statusLabel: '', duplicateApps: false };
  const closed = vi.fn(); const opened: (ComputerResource | undefined)[] = [];
  const factory: ComputerDriverFactory = { available: async () => true, open: async resource => {
    opened.push(resource); let sequence = 0;
    return { close: async () => { closed(); }, call: async (name, args, signal) => {
      signal.throwIfAborted(); calls.push({ name, args, resource });
      if (name === 'list_windows') return { windows: [
        { pid: 21, window_id: 101, app_name: 'Notes', title: 'Test note' },
        { pid: 22, window_id: 102, app_name: 'Other', title: 'Other document' },
        { pid: 99, window_id: 103, app_name: 'TinyGPT', title: 'This host' },
      ] };
      if (name === 'list_apps') return { apps: [{ name: 'Editor', launch_path: process.execPath, running: false }, ...(state.duplicateApps ? [{ name: 'Editor', launch_path: 'C:\\Fixture\\Other.exe', running: false }] : [])] };
      if (name === 'launch_app') return { pid: 25 };
      if (name === 'get_window_state') {
        if (args.include_screenshot === true) return { pid: 21, window_id: 101, screenshot_frame_valid: true, captureImages: [{ mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' }] };
        const prefix = `s${(++sequence).toString(16).padStart(8, '0')}`;
        return { pid: args.pid, window_id: args.window_id, window_title: state.title, tree_markdown: '- Text "Read-only document content"\n- [0] Edit "Draft"\n- [3] Edit "Password" [value="fixture-secret"]', elements_complete: state.nativeComplete, elements: [
          ...Array.from({ length: state.extraControls }, (_, i) => ({ element_token: `${prefix}:${i + 10}`, role: 'Button', label: `Sidebar ${i}`, enabled: true })),
          { element_token: `${prefix}:0`, role: 'Edit', label: 'Draft', value: state.value, enabled: true },
          { element_token: `${prefix}:1`, role: 'Button', label: 'Increment', enabled: true },
          { element_token: `${prefix}:2`, role: 'Button', label: 'Send', enabled: true },
          { element_token: `${prefix}:3`, role: 'Edit', label: 'Password', value: 'fixture-secret', is_password: true },
          { element_token: `${prefix}:4`, role: 'Text', label: 'Count', value: String(state.clicks) },
          ...(state.statusLabel ? [{ element_token: `${prefix}:6`, role: 'Text', label: state.statusLabel }] : []),
          ...(state.telemetry ? [{ element_token: `${prefix}:5`, role: state.telemetryRole, label: `${sequence} KB/s` }] : []),
        ] };
      }
      if (state.nativeDenied) throw new ComputerFailure('permission_denied', 'Native policy denied the operation.');
      if (state.refuse) throw new ComputerFailure('background_unavailable', 'Background delivery is unavailable.');
      if (name === 'set_value' && state.unsupportedWrite) {
        if (state.mutateThenThrow) state.value = String(args.value).slice(0, 5);
        throw new ComputerFailure('COMPUTER_TEXT_WRITE_UNSUPPORTED', 'This editor cannot accept direct text replacement. Paste the draft manually.');
      }
      if (name === 'set_value' && state.echo) state.value = String(args.value);
      if (name === 'click') { if (String(args.element_token).endsWith(':2')) state.sends++; else state.clicks++; }
      if (state.mutateThenThrow) throw new ComputerFailure('COMPUTER_ACTION_UNCERTAIN', 'The action may already have completed.');
      return { status: 'dispatched' };
    } };
  } };
  const service = new ComputerService(factory, () => settings, pid => pid === 21 ? state.executable : 'C:\\Fixture\\Other.exe', 'win32', 99, () => true, activate);
  cleanups.push(() => service.shutdown());
  const context = { conversationId: randomUUID(), runId: randomUUID(), signal: new AbortController().signal };
  const approvals: ComputerAuthorization[] = [];
  const allow = async (request: ComputerAuthorization) => { approvals.push(request); return true; };
  const call = (name: ComputerToolName, input: unknown, authorize = allow, extra: Partial<ComputerContext> = {}) => service.execute({ ...context, operationId: randomUUID(), ...extra }, name, input, authorize);
  async function read() {
    const result = await call('computer_list_windows', { app: 'Notes' }) as { windows: ComputerWindow[] };
    const windowId = result.windows[0].id;
    return { windowId, snapshot: await call('computer_read_window', { windowId }) as ComputerSnapshot };
  }
  return { service, settings, state, calls, closed, opened, context, approvals, call, read, activate };
}

it('restores only the observed window after foreground approval and returns fresh controls', async () => {
  const t = setup(); const { windowId } = await t.read();
  expect(await t.call('computer_activate_window', { windowId })).toMatchObject({ restored: true, foreground: true, verified: true, snapshot: { windowId } });
  expect(t.activate).toHaveBeenCalledWith(21, 101, expect.any(AbortSignal));
  expect(t.approvals.some(approval => approval.permission === 'desktopInteract' && approval.forceOnce)).toBe(true);
  expect(t.calls.filter(call => ['click', 'press_key', 'launch_app'].includes(call.name))).toEqual([]);
});

it('captures only a known window after its separate read approval without input or desktop-wide access', async () => {
  const t = setup(); const { windowId } = await t.read();
  const before = t.calls.length;
  const result = await t.call('computer_screenshot', { windowId });
  expect(result).toMatchObject({ windowId, image: 'data:image/png;base64,iVBORw0KGgo=' });
  expect(t.approvals.at(-1)).toMatchObject({ permission: 'desktop', scope: expect.stringContaining('screenshot:21:101:') });
  expect(t.calls.slice(before)).toEqual([expect.objectContaining({ name: 'get_window_state', args: expect.objectContaining({ pid: 21, window_id: 101, include_screenshot: true, include_accessibility_tree: false }) })]);
  expect(t.calls.at(-1)?.resource).toEqual({ executable: t.state.executable });
});

it('does not capture a window whose screenshot approval is denied', async () => {
  const t = setup(); const { windowId } = await t.read(), before = t.calls.length;
  await expect(t.call('computer_screenshot', { windowId }, async () => false)).rejects.toMatchObject({ code: 'COMPUTER_DENIED' });
  expect(t.calls).toHaveLength(before);
});
it('never activates a denied window or one whose process identity changed during approval', async () => {
  const denied = setup(); const { windowId } = await denied.read();
  await expect(denied.call('computer_activate_window', { windowId }, async () => false)).rejects.toMatchObject({ code: 'COMPUTER_DENIED' }); expect(denied.activate).not.toHaveBeenCalled();
  const stale = setup(); const target = await stale.read();
  await expect(stale.call('computer_activate_window', { windowId: target.windowId }, async () => { stale.state.executable = 'C:\\Changed.exe'; return true; })).rejects.toMatchObject({ code: 'COMPUTER_WINDOW_STALE' }); expect(stale.activate).not.toHaveBeenCalled();
});
it('returns app candidates for a user decision and accepts only a catalog-matching selected app', async () => {
  const t = setup(); t.state.duplicateApps = true;
  const error = await t.call('computer_open_app', { app: 'Editor' }).then(() => undefined, error => error);
  expect(error.code).toBe('COMPUTER_APP_AMBIGUOUS'); expect(error.recovery.candidates).toHaveLength(2);
  expect(t.calls.filter(call => call.name === 'launch_app')).toHaveLength(0);
  await t.call('computer_open_app', { app: 'Editor', appId: error.recovery.candidates[0].appId });
  expect(t.calls.filter(call => call.name === 'launch_app')).toHaveLength(1);
});
it('keeps authorized Work desktop actions usable after a user question outlives a native lease', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
  const t = setup(); const windows = await t.call('computer_list_windows', { app: 'Notes' }, undefined, { work: true }) as { windows: ComputerWindow[] }; const windowId = windows.windows[0].id;
  vi.setSystemTime(new Date('2026-11-02T12:30:00Z'));
  const read = await t.call('computer_read_window', { windowId }, undefined, { work: true }) as ComputerSnapshot;
  expect(read.elements.some(element => element.label === 'Increment')).toBe(true);
});

it('waits for a connection using fresh reads, one authorization, and no repeated input', async () => {
  const t = setup(); const { windowId } = await t.read(); const before = t.approvals.length;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  setTimeout(() => { t.state.statusLabel = 'Connected'; }, 1500);
  const pending = t.call('computer_read_window', { windowId, waitUntil: { text: 'Connected' } });
  await vi.advanceTimersByTimeAsync(2000);
  const result = await pending as ComputerSnapshot & { wait: { matched: boolean; polls: number } };
  expect(result.wait).toMatchObject({ matched: true, timedOut: false, polls: 3, evidence: 'Connected' });
  expect(t.approvals).toHaveLength(before + 1);
  expect(t.calls.filter(call => call.name === 'click')).toHaveLength(0);
  const button = result.elements.find(element => element.label === 'Increment')!;
  await t.call('computer_click', { windowId, elementId: button.id });
  expect(t.state.clicks).toBe(1);
});

it('checks full approved window evidence beyond the returned page and protects private fields', async () => {
  const t = setup(); const { windowId } = await t.read(); t.state.extraControls = 2000; t.state.statusLabel = 'Connected';
  const found = await t.call('computer_read_window', { windowId, waitUntil: { text: 'Connected' } }) as ComputerSnapshot & { wait: { matched: boolean } };
  expect(found.elements.some(element => element.label === 'Connected')).toBe(false);
  expect(found.wait).toMatchObject({ matched: true, evidence: 'Connected' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const secret = t.call('computer_read_window', { windowId, waitUntil: { text: 'fixture-secret', timeoutMs: 1000 } });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await secret as { wait: { matched: boolean } }).wait).toMatchObject({ matched: false, timedOut: true });
});

it('does not confirm disappearance when native accessibility coverage is incomplete', async () => {
  const t = setup(); const { windowId } = await t.read(); t.state.nativeComplete = false;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const pending = t.call('computer_read_window', { windowId, waitUntil: { text: 'Loading', state: 'absent', timeoutMs: 1000 } });
  await vi.advanceTimersByTimeAsync(1000);
  expect((await pending as { wait: unknown }).wait).toMatchObject({ matched: false, timedOut: true, observationComplete: false });
});

it('cancels a wait with Stop computer use and does not resume its polling', async () => {
  const t = setup(); const { windowId } = await t.read();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const pending = t.call('computer_read_window', { windowId, waitUntil: { text: 'Connected' } });
  const stopped = expect(pending).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(10); t.service.stop(); await stopped;
  const count = t.calls.length; await vi.advanceTimersByTimeAsync(20000); expect(t.calls).toHaveLength(count);
});

it('stops a desktop wait when its reading permission is revoked', async () => {
  const t = setup(); const { windowId } = await t.read();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const pending = t.call('computer_read_window', { windowId, waitUntil: { text: 'Connected' } });
  const revoked = expect(pending).rejects.toThrow('disabled while waiting');
  await vi.advanceTimersByTimeAsync(10); t.settings.toolPermissions.desktop = 'deny'; await vi.advanceTimersByTimeAsync(1000); await revoked;
});

it('counts bounded waits as observation calls rather than exhausting the model read budget with internal polls', async () => {
  const t = setup(); const { windowId } = await t.read();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  for (let i = 0; i < 2; i++) {
    const pending = t.call('computer_read_window', { windowId, waitUntil: { text: 'Connected', timeoutMs: 30000 } });
    await vi.advanceTimersByTimeAsync(30000);
    expect((await pending as { wait: unknown }).wait).toMatchObject({ matched: false, timedOut: true });
  }
  expect(t.calls.filter(call => call.name === 'get_window_state').length).toBeGreaterThan(50);
  const fresh = await t.call('computer_read_window', { windowId }) as ComputerSnapshot;
  await t.call('computer_click', { windowId, elementId: fresh.elements.find(element => element.label === 'Increment')!.id });
  expect(t.state.clicks).toBe(1);
});

it('migrates existing settings without granting desktop access through browser approval presets', () => {
  const prior = structuredClone(defaultSettings) as Record<string, unknown>; delete prior.computer;
  const parsed = settingsSchema.parse(prior);
  expect(parsed.computer.enabled).toBe(true); expect(parsed.toolPermissions.desktop).toBe('ask');
  expect(computerArguments.computer_type.safeParse({ windowId: 'w_012345abcdef', elementId: 's01234567:0', text: 'hello', pid: 21 }).success).toBe(false);
  expect(computerArguments.computer_press_key.safeParse({ windowId: 'w_012345abcdef', elementId: 's01234567:0', key: 'Ctrl+Enter' }).success).toBe(false);
});

it('discovers only matching external windows, reads text without screenshots, and redacts protected values', async () => {
  const t = setup(); const { snapshot } = await t.read();
  expect(snapshot.elements.find(element => element.label === 'Draft')?.value).toBe('');
  expect(snapshot.elements.find(element => element.label === 'Password')).toMatchObject({ protected: true });
  expect(JSON.stringify(snapshot)).not.toContain('fixture-secret');
  expect(snapshot.text).toContain('Read-only document content'); expect(snapshot.text).not.toContain('[0]');
  expect(t.calls.find(call => call.name === 'get_window_state')?.args).toMatchObject({ include_screenshot: false, tree_format: 'elements' });
  expect(t.approvals.map(item => item.permission)).toEqual(['desktop', 'desktop']);
});

it('uses recognizable application names and keeps native identities out of approval copy', async () => {
  expect(computerAppName('ApplicationFrameHost.exe', 'Sticky Notes')).toBe('Sticky Notes');
  expect(computerAppName('C:\\Apps\\Microsoft.Notes.exe')).toBe('Sticky Notes');
  expect(computerAppName('my-editor.exe')).toBe('my editor');
  const t = setup(); const { windowId, snapshot } = await t.read();
  await t.call('computer_type', { windowId, elementId: snapshot.elements[0].id, text: 'A readable draft' });
  for (const approval of t.approvals) expect(approval.summary + approval.details).not.toMatch(/\.exe|Identity:|Delivery:|w_[a-f0-9]{12}|s[a-f0-9]{8}:\d/);
  expect(t.approvals.at(-1)?.details).toContain('A readable draft');
});

it('keeps window aliases across turns without carrying control authority or sharing aliases with another chat', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read();
  expect(windowId).toMatch(/^window-\d+-[a-f0-9]{4}$/);
  t.service.endRun(t.context.runId);
  const next = { runId: randomUUID() };
  await expect(t.call('computer_type', { windowId, elementId: snapshot.elements[0].id, text: 'Old control' }, undefined, next)).rejects.toMatchObject({ code: 'COMPUTER_ELEMENT_STALE' });
  const read = await t.call('computer_read_window', { windowId }, undefined, next) as ComputerSnapshot;
  expect(read.windowId).toBe(windowId); expect(read.elements[0].id).not.toBe(snapshot.elements[0].id);
  const list = await t.call('computer_list_windows', { app: 'Notes' }, undefined, next) as { windows: ComputerWindow[] };
  expect(list.windows[0].id).toBe(windowId);
  await expect(t.call('computer_read_window', { windowId }, undefined, { runId: randomUUID(), conversationId: randomUUID() })).rejects.toMatchObject({ code: 'COMPUTER_WINDOW_STALE' });
});

it('retains unchanged control aliases while dispatching through the latest native snapshot token', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read();
  const fresh = await t.call('computer_read_window', { windowId }) as ComputerSnapshot;
  expect(fresh.elements.map(element => element.id)).toEqual(snapshot.elements.map(element => element.id));
  const result = await t.call('computer_type', { windowId, elementId: fresh.elements[0].id, text: 'New text' });
  expect(result).toMatchObject({ verified: true });
  expect(t.calls.find(call => call.name === 'set_value')?.args.element_token).toBe('s00000003:0');
});

it('allows an unchanged ordinary button through passive status updates using its fresh native token', async () => {
  const t = setup(); t.state.telemetry = true; const { windowId, snapshot } = await t.read();
  const fresh = await t.call('computer_read_window', { windowId }) as ComputerSnapshot;
  expect(fresh.elements[1].id).toBe(snapshot.elements[1].id);
  expect(fresh.elements.at(-1)?.label).not.toBe(snapshot.elements.at(-1)?.label);
  const result = await t.call('computer_click', { windowId, elementId: snapshot.elements[1].id });
  expect(result).toMatchObject({ actionDispatched: true }); expect(t.state.clicks).toBe(1);
  expect(t.calls.find(call => call.name === 'click')?.args.element_token).toBe('s00000003:1');
});

it.each(['computer_type', 'computer_click'] as const)('keeps strict full-context checks for %s when editing or sending', async name => {
  const t = setup(); t.state.telemetry = true; const { windowId, snapshot } = await t.read();
  const result = await t.call(name, { windowId, elementId: snapshot.elements[name === 'computer_type' ? 0 : 2].id, ...(name === 'computer_type' ? { text: 'Do not dispatch' } : {}) });
  expect(result).toMatchObject({ code: 'COMPUTER_ELEMENT_STALE', actionDispatched: false });
  expect(t.calls.some(call => call.name === 'click' || call.name === 'set_value')).toBe(false);
});

it('keeps an unchanged action addressable when a native app exposes live measurements as buttons', async () => {
  const t = setup(); t.state.telemetry = true; t.state.telemetryRole = 'Button';
  const { windowId, snapshot } = await t.read();
  const result = await t.call('computer_click', { windowId, elementId: snapshot.elements[1].id });
  expect(result).toMatchObject({ actionDispatched: true, observedChanges: { added: expect.arrayContaining([{ role: 'Text', label: 'Count', value: '1' }]), removed: expect.arrayContaining([{ role: 'Text', label: 'Count', value: '0' }]) } });
  expect(t.state.clicks).toBe(1);
});

it('verifies an explicit click postcondition by observing state without repeating the click', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read();
  const result = await t.call('computer_click', { windowId, elementId: snapshot.elements[1].id, waitUntil: { text: '1', timeoutMs: 1000 } });
  expect(result).toMatchObject({ actionDispatched: true, verified: true, wait: { matched: true } });
  expect(t.calls.filter(call => call.name === 'click')).toHaveLength(1);
});

it('reports a timed-out click postcondition as unverified and never retries the action', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read();
  const result = await t.call('computer_click', { windowId, elementId: snapshot.elements[1].id, waitUntil: { text: 'Never observed', timeoutMs: 1000 } });
  expect(result).toMatchObject({ actionDispatched: true, verified: false, wait: { matched: false, timedOut: true } });
  expect(t.state.clicks).toBe(1);
});

it('explains empty literal queries instead of suggesting unavailable native controls', async () => {
  const t = setup(); const { windowId } = await t.read();
  const result = await t.call('computer_read_window', { windowId, query: 'controls draft send increment' }) as ComputerSnapshot;
  expect(result.elements).toEqual([]); expect(result.notice).toContain('literal substring');
});

it('renews idle native leases before use while retaining the same verified window', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
  const t = setup(); const { windowId } = await t.read(); expect(t.opened).toHaveLength(2);
  vi.setSystemTime(new Date('2026-11-02T12:06:00Z'));
  const snapshot = await t.call('computer_read_window', { windowId }) as ComputerSnapshot;
  const windows = await t.call('computer_list_windows', {}) as { windows: ComputerWindow[] };
  expect(t.opened).toHaveLength(4); expect(windows.windows.some(window => window.id === windowId)).toBe(true);
  expect(await t.call('computer_click', { windowId, elementId: snapshot.elements[1].id })).toMatchObject({ actionDispatched: true });
  expect(t.state.clicks).toBe(1);
});

it('never renews a native policy denial into another attempt', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-02T12:00:00Z'));
  const t = setup(); const { windowId, snapshot } = await t.read(); t.state.nativeDenied = true;
  await expect(t.call('computer_click', { windowId, elementId: snapshot.elements[1].id })).rejects.toMatchObject({ code: 'permission_denied' });
  vi.setSystemTime(new Date('2026-11-02T12:06:00Z'));
  await expect(t.call('computer_read_window', { windowId })).rejects.toMatchObject({ code: 'COMPUTER_SESSION_ENDED' });
  expect(t.opened).toHaveLength(2); expect(t.state.clicks).toBe(0);
});

it('surfaces observed status separately from window visibility', async () => {
  const t = setup(); t.state.statusLabel = 'Unprotected'; const { snapshot } = await t.read();
  expect(snapshot.observedStatus).toEqual(['Unprotected']);
});

it('ends repeated stale preflight attempts without dispatching or allowing an input-tool fallback', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read(); let current = snapshot;
  const change = async (request: ComputerAuthorization) => { if (request.permission === 'desktopInteract') t.state.value += 'Changed'; return true; };
  for (let i = 0; i < 2; i++) {
    const result = await t.call('computer_click', { windowId, elementId: current.elements[1].id }, change) as { snapshot: ComputerSnapshot };
    current = result.snapshot;
  }
  await expect(t.call('computer_click', { windowId, elementId: current.elements[1].id }, change)).rejects.toMatchObject({ code: 'COMPUTER_NO_PROGRESS' });
  const approvals = t.approvals.length, reads = t.calls.length;
  await expect(t.call('computer_press_key', { windowId, elementId: current.elements[1].id, key: 'Space' })).rejects.toMatchObject({ code: 'COMPUTER_NO_PROGRESS' });
  expect(t.approvals).toHaveLength(approvals); expect(t.calls).toHaveLength(reads);
  expect(t.calls.some(call => call.name === 'click' || call.name === 'press_key')).toBe(false);
});

it('finds an input behind a large sidebar, focuses it and revalidates with the same deep read', async () => {
  const t = setup(); t.state.extraControls = 600; const { windowId, snapshot } = await t.read();
  expect(snapshot).toMatchObject({ truncated: true, coverage: { sourceComplete: true, collectedControls: 605 }, suggestedRead: { filter: 'inputs' } });
  expect(snapshot.elements.some(element => element.label === 'Draft')).toBe(true);
  const inputs = await t.call('computer_read_window', snapshot.suggestedRead) as ComputerSnapshot;
  expect(inputs.elements.map(element => element.label)).toEqual(['Draft', 'Password']);
  expect(JSON.stringify(inputs)).not.toContain('fixture-secret');
  expect(inputs).toMatchObject({ truncated: false, coverage: { matchingControls: 2, scanLimit: 5000 } });
  expect(await t.call('computer_type', { windowId, elementId: inputs.elements[0].id, text: 'Found the actual input' })).toMatchObject({ verified: true });
  expect(t.calls.filter(call => call.name === 'get_window_state').slice(-3).every(call => call.args.max_elements === 5000)).toBe(true);
});

it('searches beyond a displayed prefix and never authorizes an old page after paging forward', async () => {
  const t = setup(); t.state.extraControls = 600; const { windowId, snapshot } = await t.read();
  expect(snapshot.nextRead).toBeDefined();
  await t.call('computer_read_window', snapshot.nextRead);
  await expect(t.call('computer_click', { windowId, elementId: snapshot.elements[0].id })).rejects.toMatchObject({ code: 'COMPUTER_ELEMENT_STALE' });
  const found = await t.call('computer_read_window', { windowId, query: 'Sidebar 599' }) as ComputerSnapshot;
  expect(found.elements.map(element => element.label)).toEqual(['Sidebar 599']);
  t.state.nativeComplete = false;
  const partial = await t.call('computer_read_window', { windowId, filter: 'inputs', query: 'missing' }) as ComputerSnapshot;
  expect(partial).toMatchObject({ elements: [], truncated: true, coverage: { sourceComplete: false } });
  expect(partial.notice).toContain('does not prove a control is unavailable');
});

it('explains an unsupported editor, blocks write retries and ends repeated unchanged recovery reads', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read(); t.state.unsupportedWrite = true;
  await expect(t.call('computer_type', { windowId, elementId: snapshot.elements[0].id, text: 'A draft' })).rejects.toMatchObject({ code: 'COMPUTER_TEXT_WRITE_UNSUPPORTED', manualDraft: 'A draft', snapshot: { elements: expect.arrayContaining([expect.objectContaining({ value: '', writeSupport: 'manual' })]) } });
  const fresh = await t.call('computer_read_window', { windowId }) as ComputerSnapshot;
  expect(fresh.elements[0].writeSupport).toBe('manual');
  await expect(t.call('computer_type', { windowId, elementId: fresh.elements[0].id, text: 'A different draft' })).rejects.toMatchObject({ code: 'COMPUTER_TEXT_WRITE_UNSUPPORTED' });
  expect(t.calls.filter(call => call.name === 'set_value')).toHaveLength(1);
  await t.call('computer_read_window', { windowId });
  await expect(t.call('computer_read_window', { windowId })).rejects.toMatchObject({ code: 'COMPUTER_NO_PROGRESS' });
});

it('observes partial changes after a failed write and keeps the requested manual draft separate', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read();
  t.state.unsupportedWrite = true; t.state.mutateThenThrow = true;
  const error = await t.call('computer_type', { windowId, elementId: snapshot.elements[0].id, text: 'A replacement' }).catch(error => error) as ComputerFailure;
  expect(error).toMatchObject({ manualDraft: 'A replacement', snapshot: { elements: expect.arrayContaining([expect.objectContaining({ label: 'Draft', value: 'A rep', writeSupport: 'manual' })]) } });
  expect(JSON.stringify(error.snapshot)).not.toContain('fixture-secret');
});

it('writes once, verifies the observed field, and never confuses dispatch with successful text replacement', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read();
  const input = { windowId, elementId: snapshot.elements[0].id, text: 'Tuesday works.' };
  const operationId = randomUUID();
  const result = await t.call('computer_type', input, undefined, { operationId });
  expect(result).toMatchObject({ actionDispatched: true, verified: true });
  expect(await t.call('computer_type', input, undefined, { operationId })).toEqual(result);
  expect(t.calls.filter(call => call.name === 'set_value')).toHaveLength(1);
  await expect(t.call('computer_type', { ...input, text: 'Different' }, undefined, { operationId })).rejects.toMatchObject({ code: 'COMPUTER_OPERATION_CONFLICT' });
  t.state.echo = false;
  const next = result as { snapshot: ComputerSnapshot };
  expect(await t.call('computer_type', { windowId, elementId: next.snapshot.elements[0].id, text: 'Not accepted' })).toMatchObject({ actionDispatched: true, verified: false });
});

it('rejects stale references and changed user content after an approval wait', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read();
  const changed = await t.call('computer_type', { windowId, elementId: snapshot.elements[0].id, text: 'Replacement' }, async request => { if (request.permission === 'desktopInteract') t.state.value = 'User changed this'; return true; });
  expect(changed).toMatchObject({ code: 'COMPUTER_ELEMENT_STALE', actionDispatched: false });
  expect(t.calls.filter(call => call.name === 'set_value')).toHaveLength(0);
  await expect(t.call('computer_click', { windowId, elementId: snapshot.elements[1].id })).rejects.toMatchObject({ code: 'COMPUTER_ELEMENT_STALE' });
});

it('skips a verified identical value and blocks repeating an unverified semantic write with new references', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read();
  const written = await t.call('computer_type', { windowId, elementId: snapshot.elements[0].id, text: 'Once' }) as { snapshot: ComputerSnapshot };
  expect(await t.call('computer_type', { windowId, elementId: written.snapshot.elements[0].id, text: 'Once' })).toMatchObject({ actionDispatched: false, verified: true });
  expect(t.calls.filter(call => call.name === 'set_value')).toHaveLength(1);
  t.state.echo = false;
  const current = await t.call('computer_read_window', { windowId }) as ComputerSnapshot;
  const failed = await t.call('computer_type', { windowId, elementId: current.elements[0].id, text: 'Unaccepted' }) as { snapshot: ComputerSnapshot };
  await expect(t.call('computer_type', { windowId, elementId: failed.snapshot.elements[0].id, text: 'Unaccepted' })).rejects.toMatchObject({ code: 'COMPUTER_WRITE_ALREADY_ATTEMPTED' });
  expect(t.calls.filter(call => call.name === 'set_value')).toHaveLength(2);
});

it('does not retry refused background input through another input route', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read(); t.state.refuse = true;
  await expect(t.call('computer_type', { windowId, elementId: snapshot.elements[0].id, text: 'No fallback' })).rejects.toMatchObject({ code: 'background_unavailable' });
  expect(t.calls.filter(call => call.name === 'set_value')).toHaveLength(1);
  expect(t.calls.filter(call => call.name === 'press_key')).toHaveLength(0);
});

it('keeps element references unique across per-app drivers whose native snapshot counters restart', async () => {
  const t = setup();
  const list = await t.call('computer_list_windows', {}) as { windows: ComputerWindow[] };
  const a = await t.call('computer_read_window', { windowId: list.windows[0].id }) as ComputerSnapshot;
  const b = await t.call('computer_read_window', { windowId: list.windows[1].id }) as ComputerSnapshot;
  expect(a.elements[0].id).not.toBe(b.elements[0].id);
  await expect(t.call('computer_type', { windowId: list.windows[0].id, elementId: b.elements[0].id, text: 'wrong target' })).rejects.toMatchObject({ code: 'COMPUTER_ELEMENT_STALE' });
  expect(t.calls.filter(call => call.name === 'set_value')).toHaveLength(0);
});

it('refuses a different document in the same native window even when the editable field still looks identical', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read();
  const result = await t.call('computer_type', { windowId, elementId: snapshot.elements[0].id, text: 'For the old document' }, async () => { t.state.title = 'Another document'; return true; });
  expect(result).toMatchObject({ code: 'COMPUTER_ELEMENT_STALE', actionDispatched: false });
  expect(t.calls.filter(call => call.name === 'set_value')).toHaveLength(0);
});

it('requires separate commit and foreground approvals and refuses protected fields', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read();
  await expect(t.call('computer_type', { windowId, elementId: snapshot.elements[3].id, text: 'secret' })).rejects.toMatchObject({ code: 'COMPUTER_MANUAL_REQUIRED' });
  await t.call('computer_click', { windowId, elementId: snapshot.elements[2].id, delivery: 'foreground' });
  expect(t.approvals.slice(-2).map(item => [item.permission, item.forceOnce])).toEqual([['desktopInteract', true], ['send', true]]);
});

it('never switches to foreground or repeats a mutation after a refusal or uncertain result', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read();
  t.state.mutateThenThrow = true;
  await expect(t.call('computer_type', { windowId, elementId: snapshot.elements[0].id, text: 'Already happened' })).rejects.toMatchObject({ code: 'COMPUTER_ACTION_UNCERTAIN' });
  expect(t.state.value).toBe('Already happened');
  await expect(t.call('computer_type', { windowId, elementId: snapshot.elements[0].id, text: 'Already happened' })).rejects.toMatchObject({ code: 'COMPUTER_ELEMENT_STALE' });
  expect(t.calls.filter(call => call.name === 'set_value')).toHaveLength(1);
  expect(t.calls.find(call => call.name === 'set_value')?.args.delivery_mode).toBe('background');
});

it('stops pending approvals immediately, closes sessions, and cannot resurrect an old run after resume', async () => {
  const t = setup(); let waiting = false;
  const pending = t.call('computer_list_windows', {}, () => { waiting = true; return new Promise<boolean>(() => {}); });
  const rejected = expect(pending).rejects.toMatchObject({ code: 'COMPUTER_CANCELLED' });
  await vi.waitFor(() => expect(waiting).toBe(true)); t.service.stop(); await rejected;
  t.service.resume();
  await expect(t.call('computer_list_windows', {})).rejects.toMatchObject({ code: 'COMPUTER_SESSION_ENDED' });
  expect(t.calls).toHaveLength(0);
});

it('does not let a denial or a changed process identity authorize another desktop operation', async () => {
  const t = setup(); const { windowId, snapshot } = await t.read();
  t.state.executable = 'C:\\Fixture\\Replaced.exe';
  await expect(t.call('computer_click', { windowId, elementId: snapshot.elements[1].id })).rejects.toMatchObject({ code: 'COMPUTER_WINDOW_STALE' });
  t.state.executable = 'C:\\Fixture\\Notes.exe';
  await expect(t.call('computer_click', { windowId, elementId: snapshot.elements[1].id }, async () => false)).rejects.toMatchObject({ code: 'COMPUTER_DENIED' });
  await expect(t.call('computer_list_windows', {})).rejects.toMatchObject({ code: 'COMPUTER_SESSION_ENDED' });
  expect(t.calls.filter(call => call.name === 'click')).toHaveLength(0);
});

it('bounds action loops and uses a launch-only runtime for direct installed apps', async () => {
  const t = setup(); const launched = await t.call('computer_open_app', { app: 'Editor' });
  expect(launched).toMatchObject({ actionDispatched: true });
  expect(t.opened.find(resource => resource?.launchOnly)).toEqual({ executable: process.execPath, launchOnly: true });
  expect(t.calls.find(call => call.name === 'launch_app')?.args).toEqual({ path: process.execPath });
  const { windowId, snapshot } = await t.read(); let current = snapshot;
  for (let n = 0; n < 9; n++) { const result = await t.call('computer_click', { windowId, elementId: current.elements[1].id }) as { snapshot: ComputerSnapshot }; current = result.snapshot; }
  await expect(t.call('computer_click', { windowId, elementId: current.elements[1].id })).rejects.toMatchObject({ code: 'COMPUTER_ACTION_LIMIT' });
  expect(t.state.clicks).toBe(9);
});

function brokerSetup() {
  const t = setup(); const history = new HistoryStore(':memory:');
  const conversation = history.createConversation(null, 'chat');
  const turn = history.startTurn(conversation.id, 'Use my desktop', 'local');
  const browser = { handoffs: () => [], tasks: () => [], shutdown: () => {} } as unknown as BrowserController;
  const broker = new ToolBroker(history, () => t.settings, browser, new ProjectFiles(history.sources), () => {});
  broker.computer = t.service;
  cleanups.push(() => history.close());
  const context = { conversationId: conversation.id, runId: turn.runId, signal: new AbortController().signal };
  const call = (name: ComputerToolName, input: unknown) => broker.execute(context, { id: randomUUID(), name, input, approvalText: 'Harmless action' }).then(JSON.parse);
  async function grant<T>(pending: Promise<T>, decision: 'allow-once' | 'allow-conversation' = 'allow-once') {
    await vi.waitFor(() => expect(broker.approvals()).toHaveLength(1));
    broker.respond(broker.approvals()[0].id, decision); return pending;
  }
  return { ...t, broker, history, conversation, context, call, grant };
}

it('keeps desktop reading separate from browser grants and scopes persisted grants to a native window', async () => {
  const t = brokerSetup(); t.settings.toolPermissions.browser = 'allow'; t.settings.toolPermissions.interact = 'allow';
  const list = await t.grant(t.call('computer_list_windows', {}), 'allow-conversation');
  await t.grant(t.call('computer_read_window', { windowId: list.windows[0].id }), 'allow-conversation');
  expect(await t.call('computer_read_window', { windowId: list.windows[0].id })).toHaveProperty('elements');
  const other = t.call('computer_read_window', { windowId: list.windows[1].id });
  await vi.waitFor(() => expect(t.broker.approvals()).toHaveLength(1));
  expect(t.broker.approvals()[0].details).toContain('Other document');
  t.broker.respond(t.broker.approvals()[0].id, 'deny');
  expect(await other).toMatchObject({ code: 'COMPUTER_DENIED' });
});

it('cannot persist consequential click approvals or substitute model-written permission text', async () => {
  const t = brokerSetup(); t.settings.toolPermissions.desktop = 'allow'; t.settings.toolPermissions.desktopInteract = 'allow'; t.settings.toolPermissions.send = 'allow';
  const list = await t.call('computer_list_windows', { app: 'Notes' }); const windowId = list.windows[0].id;
  const snapshot = await t.call('computer_read_window', { windowId });
  const first = t.call('computer_click', { windowId, elementId: snapshot.elements[2].id });
  await vi.waitFor(() => expect(t.broker.approvals()).toHaveLength(1));
  expect(t.broker.approvals()[0]).toMatchObject({ onceOnly: true, prompt: undefined });
  expect(t.broker.approvals()[0].details).toContain('Send');
  const result = await t.grant(first, 'allow-conversation');
  const second = t.call('computer_click', { windowId, elementId: result.snapshot.elements[2].id });
  await vi.waitFor(() => expect(t.broker.approvals()).toHaveLength(1));
  expect(t.state.sends).toBe(1); t.broker.respond(t.broker.approvals()[0].id, 'deny');
  expect(await second).toMatchObject({ code: 'COMPUTER_DENIED' }); expect(t.state.sends).toBe(1);
});

it('does not carry a local-model desktop read grant into a different inference connection', async () => {
  const t = brokerSetup();
  const local = (name: ComputerToolName, input: unknown, inferenceScope: string) => t.broker.execute({ ...t.context, inferenceScope }, { id: randomUUID(), name, input }).then(JSON.parse);
  const list = await t.grant(local('computer_list_windows', { app: 'Notes' }, 'local-model'), 'allow-conversation');
  const windowId = list.windows[0].id;
  await t.grant(local('computer_read_window', { windowId }, 'local-model'), 'allow-conversation');
  const remote = local('computer_read_window', { windowId }, 'remote-model');
  await vi.waitFor(() => expect(t.broker.approvals()).toHaveLength(1));
  t.broker.respond(t.broker.approvals()[0].id, 'deny');
  expect(await remote).toMatchObject({ code: 'COMPUTER_DENIED' });
  expect(t.calls.filter(call => call.name === 'get_window_state')).toHaveLength(1);
});

it('revokes pending desktop approval and applies the same disabled policy in Work', async () => {
  const t = brokerSetup(); const pending = t.call('computer_list_windows', {});
  await vi.waitFor(() => expect(t.broker.approvals()).toHaveLength(1));
  t.settings.computer.enabled = false; t.broker.revokeUnavailableExtensions();
  expect(await pending).toMatchObject({ code: 'COMPUTER_DENIED' }); expect(t.calls).toHaveLength(0);
  const work = t.history.createConversation(null, 'code'); const run = t.history.startTurn(work.id, 'Use computer', 'local');
  expect(JSON.parse(await t.broker.execute({ ...t.context, conversationId: work.id, runId: run.runId }, { id: randomUUID(), name: 'computer_list_windows', input: {} })).error).toContain('Computer use is off');
});

it('runs desktop tools through ordinary typed Chat and records the real tool results', async () => {
  const t = brokerSetup(); t.settings.local = { ...t.settings.local, tools: true, model: 'fixture' }; t.settings.toolPermissions.desktop = 'allow'; t.settings.toolPermissions.desktopInteract = 'allow';
  const chat = new ChatService(t.history, () => t.settings, () => undefined, { async run(input, _signal, delta, onTool) {
    expect(input.mode).toBe('chat'); expect(input.computer).toBe(true); expect(input.instructions).toContain('Computer use is available in Chat and Work');
    const invoke = (name: ComputerToolName, args: unknown) => onTool!({ id: randomUUID(), name, input: args }).then(JSON.parse);
    const list = await invoke('computer_list_windows', { app: 'Notes' }); const windowId = list.windows[0].id;
    const snapshot = await invoke('computer_read_window', { windowId });
    const result = await invoke('computer_type', { windowId, elementId: snapshot.elements[0].id, text: 'Hello from regular Chat.' });
    expect(result.verified).toBe(true); delta('The draft field contains your text.');
  } }, () => {}, t.broker);
  const conversation = t.history.createConversation(null, 'chat'); chat.send(conversation.id, 'Write Hello from regular Chat in my Notes draft.');
  await vi.waitFor(() => expect(chat.library().activeRuns).toHaveLength(0));
  const saved = t.history.conversation(conversation.id);
  expect(saved.messages.at(-1)?.text).toBe('The draft field contains your text.');
  expect(saved.tools.map(tool => tool.name)).toEqual(['computer_list_windows', 'computer_read_window', 'computer_type']);
  expect(t.state.value).toBe('Hello from regular Chat.');
});

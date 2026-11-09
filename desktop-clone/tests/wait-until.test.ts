import { afterEach, describe, expect, it, vi } from 'vitest';
import { matchWait, outlineTexts, snapshotEvidence, WAIT_EVIDENCE, waitForObservation } from '../src/core/wait-until';
import { waitUntilSchema, browserWaitUntilSchema } from '../src/shared/wait-until';
import { toolArguments, toolDefinitions } from '../src/shared/tools';
const condition = (extra = {}) => waitUntilSchema.parse({ text: 'Connected', ...extra });
const evidence = (texts: string[], complete = true) => ({ texts, complete });
const clock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
afterEach(() => vi.useRealTimers());

describe('wait conditions', () => {
  it('waits for an actual result URL instead of accepting a progress unit on the page', () => {
    const done = browserWaitUntilSchema.parse({ url: '/result/', match: 'contains' });
    expect(matchWait(done, { texts: ['Mbps', '96.94', 'Over fifty percent complete'], complete: true, url: 'https://example.org/run' }).matched).toBe(false);
    expect(matchWait(done, { texts: [], complete: false, url: 'https://example.org/result/123' })).toMatchObject({ matched: true, evidence: 'https://example.org/result/123' });
    expect(matchWait(done, { texts: ['https://example.org/result/123'], complete: true }).matched).toBe(false);
    expect(snapshotEvidence({ url: 'https://example.org/result/123', [WAIT_EVIDENCE]: evidence(['Done']) }).url).toBe('https://example.org/result/123');
  });
  it('does not mistake disconnected or negative statuses for a successful connection', () => {
    for (const label of ['Disconnected', 'Not connected', 'Connecting', 'Connected to another server']) expect(matchWait(condition(), evidence([label])).matched).toBe(false);
    expect(matchWait(condition(), evidence(['CONNECTED'])).matched).toBe(true);
    expect(matchWait(condition({ text: 'VPN connected' }), evidence(['VPN\u00a0\nCONNECTED']))).toMatchObject({ matched: true });
  });
  it('supports explicit substring matching and conservatively verifies disappearance', () => {
    expect(matchWait(condition({ match: 'contains' }), evidence(['VPN Connected successfully']))).toMatchObject({ matched: true });
    expect(matchWait(condition({ state: 'absent' }), evidence(['Loading'], false)).matched).toBe(false);
    expect(matchWait(condition({ state: 'absent' }), evidence(['Loading'], true)).matched).toBe(true);
    expect(matchWait(condition({ state: 'absent' }), evidence(['Connected'], true)).matched).toBe(false);
  });
  it('extracts readable accessibility labels without treating window titles as contents', () => {
    expect(outlineTexts('- Window "Connected"\n  - Text "Not connected"\n  - Text "Connected"')).toEqual(['Not connected', 'Connected']);
  });
  it('uses host-only full-tree evidence without putting it into tool JSON', () => {
    const snapshot = { text: 'short page', [WAIT_EVIDENCE]: evidence(['Connected']) };
    expect(snapshotEvidence(snapshot)).toEqual(evidence(['Connected']));
    expect(JSON.stringify(snapshot)).toBe('{"text":"short page"}');
  });
  it('rejects unbounded waits and publishes the option on both read tools', () => {
    for (const timeoutMs of [0, -1, 30001, Infinity]) expect(waitUntilSchema.safeParse({ text: 'Done', timeoutMs }).success).toBe(false);
    expect(waitUntilSchema.safeParse({ text: ' ' }).success).toBe(false);
    expect(toolArguments.browser_snapshot.parse({ tabId: '00000000-0000-4000-8000-000000000001', waitUntil: { text: 'Saved' } }).waitUntil?.timeoutMs).toBe(15000);
    for (const name of ['browser_snapshot', 'computer_read_window']) expect(toolDefinitions.find(tool => tool.name === name)?.schema.properties.waitUntil).toBeDefined();
  });
});
describe('bounded observation polling', () => {
  it('distinguishes an observed disappearance from a label that was absent immediately', async () => {
    clock(); let reads = 0;
    const absent = condition({ text: 'Loading', state: 'absent' });
    const pending = waitForObservation(absent, new AbortController().signal, async () => ++reads === 1 ? ['Loading'] : ['Result'], texts => evidence(texts));
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).wait).toMatchObject({ matched: true, transitionObserved: true });
    const immediate = await waitForObservation(absent, new AbortController().signal, async () => ['Result'], texts => evidence(texts));
    expect(immediate.wait).toMatchObject({ matched: true, transitionObserved: false });
  });
  it('returns only the final observation after the expected status appears', async () => {
    clock(); let index = 0;
    const read = vi.fn(async () => ({ index: ++index, texts: [index < 3 ? 'Connecting' : 'Connected'], complete: true }));
    const pending = waitForObservation(condition(), new AbortController().signal, read, value => value);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;
    expect(result.observation?.index).toBe(3); expect(result.wait).toMatchObject({ matched: true, timedOut: false, polls: 3, evidence: 'Connected' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('returns immediately when the condition already holds', async () => {
    const read = vi.fn(async () => evidence(['Connected']));
    expect((await waitForObservation(condition(), new AbortController().signal, read, value => value)).wait).toMatchObject({ matched: true, polls: 1 });
    expect(read).toHaveBeenCalledOnce();
  });
  it('reports a pending state at the deadline without repeating an action', async () => {
    clock(); const read = vi.fn(async () => evidence(['Connecting']));
    const pending = waitForObservation(condition({ timeoutMs: 2000 }), new AbortController().signal, read, value => value);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toMatchObject({ observation: evidence(['Connecting']), wait: { matched: false, timedOut: true, polls: 2, elapsedMs: 2000 } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never treats missing text in incomplete coverage as verified absence', async () => {
    clock(); const pending = waitForObservation(condition({ state: 'absent', timeoutMs: 1000 }), new AbortController().signal, async () => evidence([], false), value => value);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).wait).toMatchObject({ matched: false, observationComplete: false });
  });
  it('bounds an unresponsive read and ignores a late successful result', async () => {
    clock(); let finish!: (value: ReturnType<typeof evidence>) => void;
    const pending = waitForObservation(condition({ timeoutMs: 1000 }), new AbortController().signal, () => new Promise(resolve => { finish = resolve; }), value => value as ReturnType<typeof evidence>);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ observation: undefined, wait: { matched: false, timedOut: true, polls: 1 } });
    finish(evidence(['Connected'])); await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([false, true])('stops promptly when cancellation happens during an %s in-flight read', async inFlight => {
    clock(); const controller = new AbortController();
    const read = vi.fn(() => inFlight ? new Promise<ReturnType<typeof evidence>>(() => {}) : Promise.resolve(evidence(['Connecting'])));
    const pending = waitForObservation(condition(), controller.signal, read, value => value);
    const stopped = expect(pending).rejects.toThrow('User stopped');
    await vi.advanceTimersByTimeAsync(10); controller.abort(Error('User stopped')); await stopped;
    await vi.advanceTimersByTimeAsync(20000); expect(read).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
  it('does not retry a failed or unauthorized read', async () => {
    const read = vi.fn(async () => { throw Error('Window closed or access revoked'); });
    await expect(waitForObservation(condition(), new AbortController().signal, read, value => value as ReturnType<typeof evidence>)).rejects.toThrow('access revoked');
    expect(read).toHaveBeenCalledOnce();
  });
});

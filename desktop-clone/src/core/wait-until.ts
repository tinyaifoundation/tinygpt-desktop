import type { WaitResult, WaitUntil } from '../shared/wait-until';

// Host-only evidence from the full approved accessibility read. Symbols never
// enter JSON tool output, so polling adds only one final snapshot to context.
export const WAIT_EVIDENCE = Symbol('wait evidence');
export interface WaitEvidence { texts: string[]; complete: boolean; url?: string }
export interface WithWaitEvidence { [WAIT_EVIDENCE]?: WaitEvidence }
const normalize = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();

export function outlineTexts(outline: string): string[] {
  return outline.split('\n').flatMap(line => {
    if (/^\s*(?:-\s*)?(?:Window|RootWebArea)\s/i.test(line)) return [];
    const labels = [...line.matchAll(/"(?:[^"\\]|\\.)*"/g)].flatMap(match => { try { return [JSON.parse(match[0]) as string]; } catch { return []; } });
    return labels.length ? labels : [line.trim()];
  });
}
export function snapshotEvidence(snapshot: WithWaitEvidence & { url?: string; text?: string; accessibility?: string; elements?: { label: string; value?: string; protected?: boolean }[]; truncated?: boolean; coverage?: { sourceComplete: boolean } }): WaitEvidence {
  return { ...(snapshot[WAIT_EVIDENCE] ?? {
    texts: [...outlineTexts(snapshot.text ?? ''), ...outlineTexts(snapshot.accessibility ?? ''), ...(snapshot.elements ?? []).flatMap(element => element.protected ? [] : [element.label, element.value ?? ''])],
    complete: snapshot.coverage?.sourceComplete === true && snapshot.truncated === false,
  }), ...(snapshot.url ? { url: snapshot.url } : {}) };
}
export function matchWait(condition: WaitUntil, evidence: WaitEvidence): { matched: boolean; evidence?: string } {
  if ('url' in condition) {
    const matched = typeof evidence.url === 'string' && (condition.match === 'exact' ? evidence.url === condition.url : evidence.url.includes(condition.url));
    return { matched, ...(matched ? { evidence: evidence.url } : {}) };
  }
  const wanted = normalize(condition.text);
  const found = evidence.texts.find(text => condition.match === 'exact' ? normalize(text) === wanted : normalize(text).includes(wanted));
  if (condition.state === 'absent') return { matched: found === undefined && evidence.complete };
  return { matched: found !== undefined, ...(found !== undefined ? { evidence: found.slice(0, 300) } : {}) };
}

function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { abort(); return; }
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation(); }).then(
      value => { signal.removeEventListener('abort', abort); resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
export async function waitForObservation<T>(condition: WaitUntil, external: AbortSignal, observe: (signal: AbortSignal) => Promise<T>, evidence: (observation: T) => WaitEvidence): Promise<{ observation?: T; wait: WaitResult }> {
  const started = performance.now(), deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error('Observation deadline reached.')), condition.timeoutMs);
  const signal = AbortSignal.any([external, deadline.signal]);
  let observation: T | undefined, complete = false, polls = 0, transitionObserved = false;
  const result = (matched: boolean, proof?: string) => ({ observation, wait: {
    matched, timedOut: !matched, condition, elapsedMs: Math.round(performance.now() - started), polls,
    observationComplete: complete, transitionObserved, ...(proof !== undefined ? { evidence: proof } : {}),
    notice: matched ? 'The expected observable condition was seen. Use the final snapshot to assess the requested outcome.' : 'The expected condition was not confirmed before the deadline. Report it as pending or unverified, not completed. Read fresh state before taking another action.',
  } });
  try {
    while (!signal.aborted) {
      polls++;
      const next = await abortable(() => observe(signal), signal);
      signal.throwIfAborted(); observation = next;
      const observed = evidence(next); complete = observed.complete;
      const match = matchWait(condition, observed);
      if ('text' in condition && condition.state === 'absent' && matchWait({ ...condition, state: 'present' }, observed).matched) transitionObserved = true;
      else if (!match.matched && observed.complete) transitionObserved = true;
      if (match.matched) return result(true, match.evidence);
      await pause(Math.min(1000, Math.max(0, condition.timeoutMs - (performance.now() - started))), signal);
    }
  } catch (error) {
    external.throwIfAborted();
    if (!deadline.signal.aborted || error !== deadline.signal.reason) throw error;
  } finally { clearTimeout(timer); }
  external.throwIfAborted(); return result(false);
}

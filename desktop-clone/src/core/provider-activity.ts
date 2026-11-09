import type { ProviderActivity } from '../shared/chat-timeouts';
import type { TraceEvent } from '../shared/diagnostics';
import { randomUUID } from 'node:crypto';
import { promptProgressObserver, workRequestAudit } from './work-request';

/** Observe transport activity before checkpoint validation buffers its body.
 * Forward bytes unchanged; cancellation and backpressure remain with fetch.
 */
export function providerActivityFetch(request: typeof fetch, activity: (type: ProviderActivity) => void, onTrace?: (event: TraceEvent) => void, purpose: () => 'reply' | 'summary' | 'metadata' = () => 'reply'): typeof fetch {
  const audit = workRequestAudit();
  return async (resource, options) => {
    const requestId = randomUUID(); const requestPurpose = purpose(); let bytes = 0; let chunks = 0; let lastProgress = Date.now(); let finished = false;
    // Diagnostic sinks receive counts only, never request bodies, URLs, headers,
    // response text or arbitrary error messages. The stream is forwarded intact.
    const trace = (event: TraceEvent) => { try { onTrace?.({ ...event, requestId, purpose: requestPurpose }); } catch { /* Best effort. */ } };
    const observePrompt = promptProgressObserver(trace);
    const end = (event: 'request-end' | 'request-error' | 'request-closed' | 'request-cancelled') => { if (!finished) { finished = true; trace({ event, bytes, chunks }); } };
    trace({ event: 'request-start' });
    if (typeof options?.body === 'string') { try { const payload = JSON.parse(options.body); if (payload.return_progress === true && Array.isArray(payload.messages)) trace(audit(payload)); } catch { /* Diagnostics never change transport. */ } }
    activity('request');
    let response: Response;
    try { response = await request(resource, options); } catch (error) { end(options?.signal?.aborted ? 'request-cancelled' : 'request-error'); throw error; }
    activity('response');
    trace({ event: 'request-headers', status: response.status });
    if (!response.body) { end('request-end'); return response; }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const value = await reader.read();
          if (value.done) { end('request-end'); controller.close(); reader.releaseLock(); return; }
          if (value.value.byteLength) {
            observePrompt(value.value);
            activity('data'); bytes += value.value.byteLength; chunks++;
            if (chunks === 1) trace({ event: 'request-first-data', bytes, chunks });
            else if (Date.now() - lastProgress >= 5000) { trace({ event: 'request-progress', bytes, chunks }); lastProgress = Date.now(); }
          }
          controller.enqueue(value.value);
        } catch (error) { end(options?.signal?.aborted ? 'request-cancelled' : 'request-error'); controller.error(error); reader.releaseLock(); }
      },
      async cancel(reason) { if (!options?.signal?.aborted) end('request-closed'); else end('request-cancelled'); await reader.cancel(reason); reader.releaseLock(); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

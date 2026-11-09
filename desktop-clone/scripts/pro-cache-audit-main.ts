import { app, safeStorage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withRuntimeContext } from '../src/core/runtime-context';
import { workToolPayload } from '../src/core/work-limits';
app.setPath('userData', process.env.TINYGPT_PRO_TEST_PROFILE!);
app.whenReady().then(async () => {
  const profile = process.env.TINYGPT_PRO_LIVE_PROFILE!;
  const registry = JSON.parse(await readFile(join(profile, 'inference-connections.json'), 'utf8'));
  const connection = registry.connections.find((c: any) => c.config.model === 'tinygpt-pro');
  if (!connection || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connection.config.endpoint).hostname)) throw Error('No local Pro connection.');
  const credentials = JSON.parse(await readFile(join(profile, 'credentials.json'), 'utf8'));
  const encrypted = credentials['connection:' + connection.id] ?? credentials.local;
  const secret = encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : '';
  const base = connection.config.endpoint.replace(/\/v1\/?$/, '');
  if (process.env.TINYGPT_PRO_CACHE_SESSION) {
    const { buildSessionProjection, convertToLlm } = await import('@earendil-works/pi-coding-agent');
    const { stream } = await import('@earendil-works/pi-ai/api/openai-completions');
    const entries = (await readFile(process.env.TINYGPT_PRO_CACHE_SESSION, 'utf8')).trim().split('\n').flatMap(line => { try { const e = JSON.parse(line); return e.type === 'session' ? [] : [e]; } catch { return []; } });
    const targetInputs = [45322, 46837];
    const model = { api: 'openai-completions', provider: 'tinygpt', id: 'tinygpt-pro', name: 'Offline serialization', baseUrl: 'http://127.0.0.1:9/v1', reasoning: true, input: ['text'], contextWindow: 65536, maxTokens: 16384, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' } } as any;
    let previous: number[] | undefined, previousClock: number[] | undefined, previousFixed: number[] | undefined, fixedAt: Date | undefined;
    const proof: object[] = [];
    const post = async (route: '/apply-template' | '/tokenize', body: unknown) => { const r = await fetch(base + route, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) }); if (!r.ok) throw Error(`Formatting endpoint returned ${r.status}`); return r.json(); };
    for (const total of targetInputs) {
      const index = entries.findIndex(e => e.message?.role === 'assistant' && e.message.usage?.input === total);
      if (index < 0) continue;
      let payload: any;
      await stream(model, { messages: convertToLlm(buildSessionProjection(entries.slice(0, index)).messages) }, { apiKey: 'offline-fixture', maxRetries: 0, onPayload: value => { payload = value; }, fetch: async () => new Response('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }) }).result();
      const formatted = await post('/apply-template', { ...payload, reasoning_effort: 'medium', chat_template_kwargs: { enable_thinking: true } });
      const { tokens } = await post('/tokenize', { content: formatted.prompt, add_special: false, parse_special: true });
      let prefix = 0; if (previous) while (prefix < Math.min(previous.length, tokens.length) && previous[prefix] === tokens[prefix]) prefix++;
      console.log(JSON.stringify({ audit: 'template-token-prefix', observedInputTokens: total, reconstructedTokens: tokens.length, commonPrefixTokens: previous ? prefix : null, generationPerformed: false }));
      previous = tokens;
      if (process.env.TINYGPT_PRO_CACHE_CONTEXT_PROOF) {
        const at = new Date(entries[index].timestamp); fixedAt ??= at;
        const prepared = workToolPayload(payload);
        const getTokens = async (body: Record<string, unknown>) => {
          const formatted = await post('/apply-template', { ...body, reasoning_effort: 'medium', chat_template_kwargs: { enable_thinking: true } });
          return (await post('/tokenize', { content: formatted.prompt, add_special: false, parse_special: true })).tokens as number[];
        };
        const clock = await getTokens(withRuntimeContext(prepared, 'chat/completions', at, 'America/New_York'));
        const fixed = await getTokens(withRuntimeContext(prepared, 'chat/completions', fixedAt, 'America/New_York'));
        const common = (a: number[] | undefined, b: number[]) => { if (!a) return null; let n = 0; while (n < Math.min(a.length, b.length) && a[n] === b[n]) n++; return n; };
        const result = { observedInputTokens: total, rollingClockTokens: clock.length, rollingClockPrefix: common(previousClock, clock), fixedClockTokens: fixed.length, fixedClockPrefix: common(previousFixed, fixed), generationPerformed: false };
        proof.push(result); console.log(JSON.stringify(result)); previousClock = clock; previousFixed = fixed;
        await writeFile('artifacts/runtime-clock-cache-proof.json', JSON.stringify(proof, null, 2));
      }
    }
  }
  for (const route of ['/props', '/slots']) {
    const response = await fetch(base + route, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) { console.log(JSON.stringify({ route, status: response.status })); continue; }
    const body = await response.json();
    const rows = Array.isArray(body) ? body : [body.default_generation_settings ?? body];
    // Never print the raw response, prompt, URL configuration, headers or keys.
    const cache: Record<string, number | boolean> = {};
    const walk = (value: any, path = '', depth = 0) => { if (!value || typeof value !== 'object' || depth > 8) return; for (const [key, child] of Object.entries(value)) { const next = path + '.' + key; if (/^(cache_prompt|cache_ram_mib|n_ctx_checkpoints|n_past|n_cache_reuse|n_prompt_tokens_cache|cache_n)$/.test(key) && (typeof child === 'boolean' || typeof child === 'number')) cache[next] = child; if (key !== 'prompt' && key !== 'tokens' && typeof child === 'object') walk(child, next, depth + 1); } };
    walk(body);
    console.log(JSON.stringify({ route, cache, rows: rows.map((row: any) => ({ id: row.id, processing: row.is_processing, context: row.n_ctx, promptTokens: row.n_prompt_tokens, cachedTokens: row.n_prompt_tokens_cache })) }));
  }
}).then(() => app.exit(0)).catch(error => { console.error(error instanceof Error ? error.message : 'Cache audit failed.'); app.exit(1); });

import { app, safeStorage, BrowserWindow } from 'electron';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { runtimeContextFetch, withRuntimeContext } from '../src/core/runtime-context';
import { ImageUnderstanding } from '../src/main/image-understanding';
import { WindowsImageText } from '../src/main/image-text';
app.setPath('userData', process.env.TINYGPT_PRO_TEST_PROFILE!);
app.on('window-all-closed', () => {}); // Capture-window teardown must not end the pending GPU regression.
app.whenReady().then(async () => {
  const profile = process.env.TINYGPT_PRO_LIVE_PROFILE!, conversation = process.env.TINYGPT_PRO_PROBE_CONVERSATION;
  if (!conversation) throw Error('Specify the existing awaiting-input conversation before probing.');
  const db = new DatabaseSync(join(profile, 'library.sqlite'), { readOnly: true });
  let initialRevision: number | undefined;
  const guard = () => {
    const task = db.prepare('SELECT data FROM work_tasks WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1').get(conversation);
    if (!task) throw Error('The audited task is unavailable; probe stopped.');
    const current = JSON.parse(String(task.data)); initialRevision ??= current.revision;
    if (!['awaiting-input', 'cancelled', 'completed', 'paused'].includes(current.status) || current.revision !== initialRevision) throw Error('The live task state changed; probe stopped.');
    if (db.prepare("SELECT id FROM messages WHERE role='assistant' AND status='streaming' AND conversation_id!=? LIMIT 1").get(conversation)) throw Error('Another live reply is active; probe stopped.');
  };
  try {
    guard();
    const registry = JSON.parse(await readFile(join(profile, 'inference-connections.json'), 'utf8'));
    const connection = registry.connections.find((c: any) => c.config.model === 'tinygpt-pro');
    if (!connection || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connection.config.endpoint).hostname)) throw Error('No local Pro connection.');
    const credentials = JSON.parse(await readFile(join(profile, 'credentials.json'), 'utf8'));
    const encrypted = credentials['connection:' + connection.id] ?? credentials.local;
    const key = encrypted ? safeStorage.decryptString(Buffer.from(encrypted, 'base64')) : '';
    const base = connection.config.endpoint.replace(/\/v1\/?$/, '');
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' };
    const idle = async () => {
      guard(); const response = await fetch(base + '/slots', { headers, signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw Error('Cannot verify native model idle state.');
      if ((await response.json()).some((slot: any) => slot.is_processing)) throw Error('The local model is busy; probe stopped.');
    };
    const gpuClockTest = process.env.TINYGPT_PRO_GPU_CLOCK_TEST === '1';
    const visionCacheTest = process.env.TINYGPT_PRO_VISION_CACHE_TEST === '1';
    const results: { name: string; cacheTokens: number; processedTokens: number; promptMs: number; outputTokens: number; generationMs: number }[] = [];
    const proofPath = resolve(visionCacheTest ? 'artifacts/gpu-vision-cache-proof.json' : gpuClockTest ? 'artifacts/gpu-clock-cache-proof.json' : 'artifacts/pro-cache-probe.json');
    const save = (verified = false) => writeFile(proofPath, JSON.stringify({ syntheticOnly: true, taskUnchanged: true, ...(gpuClockTest || visionCacheTest ? { backend: 'CUDA', appManagedServer: true, model: 'tinygpt-pro', verified } : {}), results }, null, 2));
    const run = async (name: string, route: string, payload: object, send: typeof fetch = fetch) => {
      await idle(); const abort = new AbortController();
      const monitor = setInterval(() => { try { guard(); } catch (error) { abort.abort(error); } }, 250);
      try {
        const response = await send(base + route, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180000)]) });
        if (!response.ok) throw Error(`Synthetic probe returned HTTP ${response.status}.`);
        const body = await response.json(), t = body.timings;
        if (!t) throw Error('Native timing counters missing.');
        const result = { name, cacheTokens: t.cache_n, processedTokens: t.prompt_n, promptMs: t.prompt_ms, outputTokens: t.predicted_n, generationMs: t.predicted_ms };
        results.push(result); console.log(JSON.stringify(result));
        await save(); return body;
      } finally { clearInterval(monitor); }
    };
    if (visionCacheTest) {
      const reference = 'A maple tree grows beside a quiet stream. Its leaves change color in autumn.\n'.repeat(1536);
      const body = { model: 'tinygpt-pro', messages: [{ role: 'system', content: 'Read the synthetic reference and reply OK.' }, { role: 'user', content: reference }], max_tokens: 1, cache_prompt: true, temperature: 0, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } };
      const stable = runtimeContextFetch(fetch);
      await run('main-prefix-before-vision', '/v1/chat/completions', body, stable);
      await run('main-prefix-warm-repeat', '/v1/chat/completions', body, stable);
      const window = new BrowserWindow({ width: 700, height: 400, show: false, webPreferences: { sandbox: true, offscreen: true } });
      let image: string, original: Buffer;
      try {
        await window.loadURL('data:text/html,' + encodeURIComponent('<body style="margin:25px;background:white;font:24px sans-serif"><h2>Notification channels</h2><p><input type="checkbox" checked style="width:25px;height:25px"> Email</p><p><input type="checkbox" style="width:25px;height:25px"> On GitHub</p><small>This synthetic settings page tests visible checkbox states. Email delivery is enabled when the first box is selected. In-app delivery is enabled when the second box is selected. These settings belong only to this fixture. Read the actual checks beside the labels to determine which channel is enabled. No account changes or external actions occur during this verification.</small></body>'));
        const pixels = await window.webContents.capturePage(); image = pixels.toDataURL(); original = pixels.toPNG();
      } finally { window.destroy(); }
      const requestedQuestion = 'Is the Email checkbox checked? Answer YES or NO using the visible checkmark.';
      const understanding = new ImageUnderstanding(new WindowsImageText(resolve('scripts/windows-image-ocr.ps1'), join(app.getPath('userData'), 'ocr')));
      try {
        const observation = await understanding.analyze({ original, metadata: { title: 'Synthetic settings', imageReference: 'tinygpt-image:fixture', width: 700, height: 400 }, transport: { type: 'tinygpt-image-result', text: '', image } }, requestedQuestion, {
          available: () => true,
          analyze: async (pixels, question) => {
            assert.equal(question, requestedQuestion, 'Dense OCR must preserve the requested visual question');
            const result = await run('auxiliary-vision', '/v1/chat/completions', { model: 'tinygpt-pro', messages: [{ role: 'system', content: 'Use only the visible image evidence.' }, { role: 'user', content: [{ type: 'image_url', image_url: { url: pixels } }, { type: 'text', text: question }] }], max_tokens: 64, temperature: 0, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } });
            const answer = result.choices[0].message.content as string;
            assert.match(answer, /\bYES\b/i, 'Pro must observe the checked Email fixture');
            return { observation: answer, incomplete: result.choices[0].finish_reason !== 'stop' };
          },
        }, new AbortController().signal, false);
        assert.equal(observation.visualStatus, 'observed', 'The focused vision analysis must succeed');
        assert.match(observation.observation, /\bYES\b/i);
        assert.ok(observation.textRegions.length > 0, 'Real OCR geometry must reach the tool result');
        assert.ok(observation.extractedText.length >= 300, 'The regression must exercise dense OCR');
      } finally { understanding.close(); }
      await run('main-prefix-after-vision', '/v1/chat/completions', body, stable);
      assert.ok(results[3].cacheTokens > 25000 && results[3].processedTokens < 32, 'The large main prompt must survive auxiliary vision inference');
      await save(true); guard(); console.log('PASS: a 26k-token GPU prompt survived a separate image-analysis request.');
      return;
    }
    if (gpuClockTest) {
      const reference = 'A maple tree grows beside a quiet stream. Its leaves change color in autumn.\n'.repeat(512);
      const body = { model: 'tinygpt-pro', messages: [{ role: 'system', content: 'Read the synthetic reference and reply OK.' }, { role: 'user', content: reference }], max_tokens: 1, cache_prompt: true, temperature: 0, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } };
      await run('changing-clock-first', '/v1/chat/completions', withRuntimeContext(body, 'chat/completions', new Date('2026-11-05T15:00:01Z'), 'UTC'));
      await run('changing-clock-next', '/v1/chat/completions', withRuntimeContext(body, 'chat/completions', new Date('2026-11-05T15:01:02Z'), 'UTC'));
      const stable = runtimeContextFetch(fetch, new Date('2026-11-05T16:00:01Z'), 'UTC');
      await run('stable-clock-first', '/v1/chat/completions', body, stable);
      const repeat = await run('stable-clock-repeat', '/v1/chat/completions', body, stable);
      await run('stable-clock-appended-history', '/v1/chat/completions', { ...body, messages: [...body.messages, repeat.choices[0].message, { role: 'user', content: 'Reply OK again.' }] }, stable);
      assert.equal(results[1].cacheTokens, 0);
      assert.ok(results[3].cacheTokens > 8000 && results[3].processedTokens < 32, 'Stable GPU request must reuse the reference');
      assert.ok(results[4].cacheTokens > 8000 && results[4].processedTokens < 100, 'GPU reuse must survive appended history');
      assert.ok(results[3].promptMs < results[1].promptMs / 5, 'Measured GPU prefill must improve substantially');
      await save(true); guard(); console.log('PASS: changing clock reproduces uncached GPU prefill; the updated adapter restores cache reuse and input-processing performance.');
      return;
    }
    const reference = 'A maple tree grows beside a quiet stream. Its leaves change color in autumn.\n'.repeat(70);
    const raw = { prompt: 'Read this reference.\n' + reference + '\nReply OK.\n', n_predict: 1, cache_prompt: true, temperature: 0 };
    await run('raw-cold', '/completion', raw); await run('raw-exact-repeat', '/completion', raw);
    const chat = { model: 'tinygpt-pro', messages: [{ role: 'user', content: 'Read this reference.\n' + reference + '\nReply OK.' }], max_tokens: 1, cache_prompt: true, temperature: 0, reasoning_effort: 'none', chat_template_kwargs: { enable_thinking: false } };
    await run('chat-cold', '/v1/chat/completions', chat); await run('chat-exact-repeat', '/v1/chat/completions', chat);
    await run('chat-appended-message', '/v1/chat/completions', { ...chat, messages: [...chat.messages, { role: 'assistant', content: 'OK' }, { role: 'user', content: 'Reply OK again.' }] });
    guard(); console.log('Synthetic cache probe complete; the live question remains unanswered.');
  } finally { db.close(); }
}).then(() => app.exit(0)).catch(error => { console.error(error instanceof Error ? error.message : 'Cache probe failed.'); app.exit(1); });

import { app, safeStorage } from 'electron';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { chatExecution, closeChatRuntime } from '../src/main/chat-execution';
import { workBlocks } from '../src/core/work-activity';
import { createWorkExecution } from '../src/main/work-execution';
import { ToolBroker } from '../src/main/tool-broker';
import { ProjectFiles } from '../src/main/files';
import { defaultSettings, type Settings } from '../src/shared/config';
import type { BrowserController } from '../src/main/browser';
import type { ChatExecution } from '../src/shared/chat';
import type { TraceEvent, TraceSink } from '../src/shared/diagnostics';
import { WORK_OUTPUT_STALLED_MESSAGE } from '../src/shared/work';

app.setPath('userData', process.env.TINYGPT_PI_TEST_PROFILE!);
app.whenReady().then(async () => {
  const root = app.getPath('userData');
  const history = new HistoryStore(join(root, 'library.sqlite'));
  let scenario = 'native', calls = 0, codeCalls = 0, compactionPass = 0, codeSession: string | undefined;
  const requests: any[] = [];
  let stablePluginWire: string | undefined;
  let warmPrefix: any[] | undefined;
  const server = createServer(async (request, response) => {
    try {
      let raw = ''; for await (const part of request) raw += part;
      const body = JSON.parse(raw); requests.push(body);
      const tools = body.tools?.map((tool: any) => tool.function.name) ?? [];
      if (!tools.length) {
        assert.equal(body.max_tokens, scenario === 'compacting' ? 3250 : 4096, 'Compaction has an independent output allowance');
        assert.equal(body.reasoning_budget_tokens, 0, 'Compaction does not inherit task reasoning');
        const data = { id: 'summary', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: '## Goal\nContinue the task.\n## Progress\nCreated large.txt.\n## Next\nVerify the saved original user constraints and finish.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 500, completion_tokens: 40, total_tokens: 540 } };
        response.writeHead(200, { 'content-type': 'text/event-stream' }).end('data: ' + JSON.stringify(data) + '\n\ndata: [DONE]\n\n'); return;
      }
      if (scenario !== 'byok') { assert.equal(body.cache_prompt, true); assert.equal(body.return_progress, true); }
      if (scenario === 'byok') assert.equal(body.reasoning_budget_tokens, undefined);
      else { assert.equal(body.reasoning_budget_tokens, undefined, 'Task thinking must not force a cutoff'); assert.equal(body.reasoning_effort, 'medium'); assert.equal(body.chat_template_kwargs?.enable_thinking, true); }
      const parent = tools.includes('code_task');
      let name: string | undefined, args: unknown, answer = 'Finished.';
      if (parent) {
        calls++;
        assert.ok(tools.includes('write') && tools.includes('powershell'));
        assert.ok(!tools.includes('write_file') && !tools.includes('run_command') && !tools.includes('work_finish'));
        assert.ok(['system', 'developer'].includes(body.messages[0].role));
        assert.ok(!raw.includes('Shell programs are unavailable'));
        if (scenario === 'plugin-lazy') {
          if (calls === 1) stablePluginWire = JSON.stringify(body.tools);
          assert.equal(JSON.stringify(body.tools), stablePluginWire, 'Discovery must never replace the local wire tool definitions');
          assert.ok(tools.includes('invoke_tool') && tools.includes('browser_click'));
          assert.ok(!tools.some((name: string) => name.startsWith('ext_')));
          if (calls === 1) { assert.ok(!raw.includes('DORMANT_PLUGIN_SCHEMA')); assert.ok(!raw.includes('ext_unused_1_')); name = 'load_tools'; args = { group: 'services', query: 'Fixture selected_action' }; }
          else if (calls === 2) { assert.ok(raw.includes('DORMANT_PLUGIN_SCHEMA')); name = 'invoke_tool'; args = { name: selectedPluginTool, input: {} }; }
          else if (calls === 3) { name = 'load_tools'; args = { group: 'browser', query: 'browser_snapshot' }; }
          else if (calls === 4) { name = 'load_tools'; args = { group: 'images', query: 'generate_image' }; }
          else if (calls === 5) { name = 'load_tools'; args = { group: 'services', query: 'discovery' }; }
          else if (calls === 6) { name = 'invoke_tool'; args = { name: selectedPluginTool, input: {} }; }
        } else if (scenario === 'pruning-resume') {
          assert.ok(!raw.includes('z'.repeat(14000)), 'Forking must retain native context edits');
          if (calls === 1) { const id = raw.match(/Completed write action .*?read_observation id=([a-f0-9-]{36})/)?.[1]; assert.ok(id); name = 'read_observation'; args = { id, offset: 13900, limit: 1000 }; }
          else { assert.ok(raw.includes('_TAIL_ORIGINAL')); answer = 'Recovered the original write after resume and file changes.'; }
        } else if (scenario === 'pruning' || scenario === 'cache-stability') {
          if (scenario === 'cache-stability') {
            if (warmPrefix) assert.deepEqual(body.messages.slice(0, warmPrefix.length), warmPrefix, 'Healthy context must keep the complete previously processed prefix unchanged');
            warmPrefix = body.messages;
          }
          if (calls === 1) { name = 'write'; args = { path: 'large.txt', content: 'ARCHIVE_SENTINEL_' + 'z'.repeat(14000) + '_TAIL_ORIGINAL' }; }
          else if (calls < 7) { name = 'ls'; args = {}; }
          else if (scenario === 'cache-stability') { assert.ok(raw.includes('z'.repeat(14000)) && raw.includes('R'.repeat(12000)), 'Removable history stays unchanged without context pressure'); answer = 'Warm history preserved.'; }
          else if (calls === 7) {
            assert.ok(!raw.includes('z'.repeat(14000)), 'Retired write arguments must leave model context');
            assert.ok(!raw.includes('R'.repeat(12000)), 'Completed reasoning must leave the active context');
            const id = raw.match(/Completed write action .*?read_observation id=([a-f0-9-]{36})/)?.[1]; assert.ok(id, 'Pruned arguments must have a retrievable reference');
            name = 'read_observation'; args = { id, offset: 13900, limit: 1000 };
          } else if (calls === 8) {
            const id = raw.match(/Completed reasoning archived: read_observation id=([a-f0-9-]{36})/)?.[1]; assert.ok(id, 'Retired reasoning must have a retrievable reference');
            name = 'read_observation'; args = { id, query: 'ARCHIVED_REASONING_SENTINEL', limit: 1000 };
          } else { assert.ok(raw.includes('_TAIL_ORIGINAL'), 'Archived arguments must be recovered exactly'); assert.ok(raw.includes('ARCHIVED_REASONING_SENTINEL')); answer = 'Archived write and reasoning recovered without repeating actions.'; }
        } else if (scenario === 'compacting') {
          if (calls <= 2) { name = 'write'; args = { path: calls === 1 ? 'large.txt' : 'supporting.txt', content: 'c'.repeat(12000) }; }
          else if (calls === 3) {
            const id = [...raw.matchAll(/outcomes and questions: read_observation id=([a-f0-9-]{36})/g)].at(-1)?.[1];
            assert.ok(id, 'Native summary must include exact host state');
            name = 'read_observation'; args = { id, offset: 0, limit: 1000 };
          } else { assert.ok(raw.includes('color=blue'), 'Exact original constraints must survive compaction'); answer = 'Compacted and recovered the original constraint.'; }
        } else if (scenario === 'native') {
          const steps: [string, unknown][] = [
            ['work_ask_user', { question: 'Choose a format', options: [{ id: 'text', label: 'Text' }, { id: 'json', label: 'JSON' }] }],
            ['write', { path: 'nested/probe.mjs', content: 'export const verified = true;' }],
            ['powershell', { command: 'node --version' }],
            ['read', { path: 'nested/probe.mjs' }],
            ['find', { pattern: '*.mjs', path: 'nested' }],
            ['grep', { pattern: 'verified', path: 'nested/probe.mjs' }],
          ];
          [name, args] = steps[calls - 1] ?? []; answer = 'Created and verified nested/probe.mjs.';
        } else if (scenario === 'file-pages') {
          const outputs = body.messages.filter((message: any) => message.role === 'tool').map((message: any) => message.content).join('\n');
          if (calls === 1) { name = 'read'; args = { path: 'app.js' }; }
          else if (calls === 2) {
            assert.ok(outputs.includes('DOM_WEEK_SELECT_CONTROL'), 'The middle of a native file page must reach the model intact');
            assert.ok(!outputs.includes('[Middle archived;'), 'No secondary head/tail clipping of file pages');
            name = 'read'; args = { path: 'paging.txt' };
          } else if (calls === 3) {
            assert.ok(outputs.includes('ROW_2000_END'), 'The complete first line page must reach the model');
            assert.ok(!outputs.includes('ROW_2001_END'), 'The file reader remains bounded');
            assert.ok(outputs.includes('offset=2001'), 'Native line continuation must survive unchanged');
            name = 'read'; args = { path: 'paging.txt', offset: 2001, limit: 100 };
          } else {
            assert.ok(outputs.includes('ROW_2001_END') && outputs.includes('ROW_2100_END'), 'The next line page has no gap');
            answer = 'Verified the middle of the app file and both contiguous file pages.';
          }
        } else if (scenario === 'followup') {
          assert.ok(raw.includes('export const verified = true;'), 'Pi must restore its native tool history');
          answer = 'followup-only: I remember the verified module.';
        } else if (scenario === 'regenerate') {
          assert.ok(!raw.includes('followup-only:'), 'Regeneration must fork the selected ancestor');
          answer = 'Regenerated from the correct branch.';
        } else if (scenario === 'denied') {
          if (calls === 1) { name = 'write'; args = { path: 'denied.mjs', content: 'must not exist' }; }
          answer = 'Writing was denied.';
        } else if (scenario === 'bounded-edits') {
          const steps: [string, unknown][] = [
            ['write', { path: 'bounded.txt', content: 'original' }],
            ['edit', { path: 'bounded.txt', edits: [{ oldText: 'original', newText: 'x'.repeat(9000) }, { oldText: 'later', newText: 'y'.repeat(9000) }] }],
            ['edit', { path: 'bounded.txt', edits: [{ oldText: 'original', newText: 'updated' }] }],
            ['read', { path: 'bounded.txt' }],
          ];
          [name, args] = steps[calls - 1] ?? [];
          if (calls === 3) assert.ok(raw.includes('This change exceeds 16 KiB'), 'Oversized batch must be rejected with actionable guidance');
        } else if (scenario === 'truncated' || scenario === 'truncated-repeat') {
          if (calls === 1) { name = 'write'; args = { path: 'must-not-execute.txt', content: 'incomplete response' }; }
          else if (calls === 2) { name = 'write'; args = { path: 'recovered.txt', content: 'Recovered with a complete call.' }; }
          answer = 'Recovered after the output cutoff.';
        } else if (scenario === 'shell-error') {
          if (calls === 1) { name = 'powershell'; args = { command: "Get-Content -LiteralPath '__missing_fixture_file__'\nWrite-Output 'SHOULD_NOT_RUN'" }; }
          answer = 'Observed the expected command failure.';
        } else if (scenario === 'byok') {
          assert.equal(body.model, 'gpt-6.1-sol'); assert.ok(body.max_completion_tokens > 0); assert.equal(body.max_tokens, undefined);
          answer = 'Connected provider adapter verified.';
        } else if (scenario === 'cancel') { name = 'powershell'; args = { command: 'node -e "require(\'fs\').writeFileSync(\'cancel.pid\',String(process.pid));setTimeout(()=>console.log(123),60000)"' }; }
        else if (scenario === 'coding-limit' || scenario === 'coding-limit-continue') {
          if (scenario === 'coding-limit') {
            assert.ok(calls <= 3, 'Repeated output failures must stop before another model request');
            name = calls === 2 ? 'ls' : 'code_task'; args = calls === 2 ? {} : { task: 'Create a small implementation; preserve existing work.' };
          } else if (calls === 1) { name = 'code_task'; args = { task: 'Resume and save a small implementation.' }; }
        }
        else if (scenario === 'coding' || scenario === 'coding-resume' || scenario === 'coding-denied' || scenario === 'code-cancel') {
          if (calls === 1) { name = 'code_task'; args = { task: scenario === 'coding' ? 'Create implementation.mjs and verify it.' : 'Continue the implementation and verify remembered state.', ...(scenario === 'coding-resume' ? { sessionId: codeSession } : {}) }; }
          answer = 'OpenCode finished the implementation.';
        }
      } else {
        assert.ok(!tools.some((name: string) => name.startsWith('chrome_devtools_')), 'Coding-only handoffs must not advertise browser tools');
        codeCalls++;
        assert.equal(body.model, 'fixture-model');
        if (codeCalls === 1) { name = 'write'; args = { filePath: 'implementation.mjs', content: 'export const result = 42;' }; }
        else if (codeCalls === 2) { name = 'read'; args = { filePath: 'implementation.mjs' }; }
        else if (codeCalls === 3 && scenario === 'coding') { name = 'bash'; args = { command: "Get-Content -LiteralPath '__missing_delegated_fixture_file__'\nWrite-Output 'SHOULD_NOT_RUN'", description: 'Check a failing command' }; }
        else answer = 'Implementation verified; coder-remembered-state.';
        if (scenario === 'coding-denied' && codeCalls > 1) { name = undefined; answer = 'Observed the denied write.'; }
        if (scenario === 'coding-resume') {
          assert.ok(raw.includes('coder-remembered-state.'), 'OpenCode must resume its own saved session');
          name = undefined; answer = 'Coding session resumed successfully.';
        }
        if (scenario === 'code-cancel') { name = 'bash'; args = { command: 'node -e "require(\'fs\').writeFileSync(\'cancel-code.pid\',String(process.pid));setTimeout(()=>console.log(123),60000)"', description: 'Wait for cancellation' }; }
        if (scenario === 'coding-limit') {
          name = undefined;
          if (codeCalls > 1) assert.ok(raw.includes('LIMIT_SESSION_SENTINEL'), 'Recovery must reuse the failed native session automatically');
          assert.ok(raw.includes('16 KiB'), 'Coding agent must receive the same incremental-write policy');
        }
        if (scenario === 'coding-limit-continue') assert.ok(raw.includes('LIMIT_SESSION_SENTINEL'), 'Continue must restore recovery metadata from the selected Pi branch');
        if (name) assert.ok(tools.includes(name), `OpenCode must expose native ${name}`);
      }
      const limit = !parent && scenario === 'coding-limit';
      const delta = limit ? { role: 'assistant', reasoning_content: 'LIMIT_SESSION_SENTINEL reasoning budget exhausted.' } : name ? { role: 'assistant', ...(!parent ? { content: `Coding progress ${codeCalls}.` } : {}), tool_calls: [{ index: 0, id: `fixture-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: answer };
      if (['pruning', 'cache-stability'].includes(scenario) && calls === 1) Object.assign(delta, { reasoning_content: 'ARCHIVED_REASONING_SENTINEL ' + 'R'.repeat(scenario === 'pruning' ? 60000 : 12000) });
      const highContext = calls <= 2 || compactionPass === 1 && calls === 3;
      const usage = scenario === 'compacting' ? highContext ? 60000 : 12000 : scenario === 'pruning' && calls === 6 ? 47000 : undefined;
      const frame = (delta: unknown, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: `response-${requests.length}`, object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason }], ...(usage && finish_reason ? { usage: { prompt_tokens: usage, completion_tokens: 100, total_tokens: usage + 100 } } : {}) }) + '\n\n';
      const progressFrame = body.return_progress ? 'data: ' + JSON.stringify({ choices: [], prompt_progress: { total: 12000, cache: 10000, processed: 12000, time_ms: 17 } }) + '\n\n' : '';
      response.writeHead(200, { 'content-type': 'text/event-stream' }).end(progressFrame + frame(delta, null) + frame({}, limit || scenario === 'truncated-repeat' || scenario === 'truncated' && calls === 1 ? 'length' : name ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
    } catch (error) { console.error('Fixture:', error); response.writeHead(500).end(JSON.stringify({ error: String(error) })); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const settings: Settings = { ...defaultSettings, route: 'local', mode: 'code', effort: { ...defaultSettings.effort, code: 'medium' }, local: { ...defaultSettings.local, endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, model: 'fixture-model', tools: true, contextWindowTokens: 64000, maxOutputTokens: 8192, reasoningOverride: { kind: 'llamacpp', efforts: ['medium', 'xhigh'], canDisable: true } }, toolPermissions: { ...defaultSettings.toolPermissions, read: 'allow', write: 'allow', execute: 'allow' } };
  const browser = { partition: () => 'fixture', handoffs: () => [], tasks: () => [], endRun() {}, shutdown() {} } as unknown as BrowserController;
  const broker = new ToolBroker(history, () => settings, browser, new ProjectFiles(history.sources), () => {});
  let secret: string | undefined;
  const traces: TraceEvent[] = [];
  const diagnostics: TraceSink = { begin() {}, record(_runId, event) { traces.push(event); }, stamp() { return undefined; } };
  const selectedPluginTool = 'ext_selected_action_aaaaaaaaaaaaaaaaaaaaaaaa';
  let pluginExecutions = 0;
  const nativeWork = createWorkExecution(history);
  const work: ChatExecution = { run(...args) {
    // Small writes must still exercise native compaction. Use a deliberately
    // smaller fixture context instead of one oversized file argument.
    if (scenario === 'compacting') args[0].contextWindowTokens = 26000;
    if (scenario === 'plugin-lazy') {
      args[0].extensionTools = Array.from({ length: 95 }, (_, i) => ({ name: (i ? `ext_unused_${i}_bbbbbbbbbbbbbbbbbbbbbbbb` : selectedPluginTool) as `ext_${string}`, originalName: i ? `unused_${i}` : 'selected_action', pluginId: 'fixture', label: 'Plugin action', description: 'Plugin action', category: 'read', schema: { type: 'object', properties: { value: { type: 'string', description: 'DORMANT_PLUGIN_SCHEMA_' + 'x'.repeat(2800) } } } }));
      const onTool = args[3];
      args[3] = async request => {
        if (request.name === 'load_tools') return JSON.stringify({ enabled: 'services', toolNames: (request.input as any).query === 'discovery' ? [] : [selectedPluginTool] });
        if (request.name === selectedPluginTool) { pluginExecutions++; return '{"text":"Selected plugin result"}'; }
        return onTool!(request);
      };
    }
    return nativeWork.run(...args);
  } };
  const service = new ChatService(history, () => settings, () => secret, chatExecution, () => {}, broker, undefined, undefined, diagnostics, work);
  async function idle(id: string) {
    const deadline = Date.now() + (process.env.TINYGPT_PI_LIVE_PROFILE ? 240000 : 60000);
    while (service.isActive(id) && Date.now() < deadline) {
      const question = service.library().workQuestions?.find(q => q.conversationId === id);
      if (question) await service.answerWorkQuestion({ questionId: question.id, optionId: 'text' });
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (service.isActive(id)) await service.cancel(id);
    assert.ok(Date.now() < deadline, 'Work must settle');
    const result = service.update(id).conversation.messages.at(-1)!;
    assert.equal(result.status, 'complete', result.error ?? 'Work must complete'); return result;
  }
  async function runningPid(conversationId: string, filename: string) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try { const pid = Number(await readFile(join(history.generatedFilesRoot, conversationId, filename), 'utf8')); if (pid > 0) return pid; } catch {}
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('The native command must actually run before cancellation.');
  }
  async function stoppedPid(pid: number) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) { try { process.kill(pid, 0); } catch { return; } await new Promise(resolve => setTimeout(resolve, 25)); }
    throw new Error('Cancellation left the command process running.');
  }
  try {
    if (process.env.TINYGPT_PI_LIVE_PROFILE) {
      const profile = process.env.TINYGPT_PI_LIVE_PROFILE;
      const registry = JSON.parse(await readFile(join(profile, 'inference-connections.json'), 'utf8'));
      const connection = registry.connections.find((entry: any) => entry.id === registry.selected.local);
      assert.ok(connection && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connection.config.endpoint).hostname));
      settings.local = { ...settings.local, ...connection.config }; settings.effort.code = 'low';
      const credentials = JSON.parse(await readFile(join(profile, 'credentials.json'), 'utf8'));
      const encrypted = credentials['connection:' + registry.selected.local] ?? credentials.local;
      if (encrypted) secret = safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
      const coding = process.env.TINYGPT_PI_LIVE_TASK === 'code';
      const chat = history.createConversation(null, 'code'); const started = Date.now();
      service.start(chat.id, coding
        ? 'Use code_task to delegate this small coding task to OpenCode: create outputs/check.mjs exporting a function add(a,b) that returns a+b, then use Node to import it and verify add(20,22) is 42. No dependencies or research. Finish with one sentence.'
        : 'Create outputs/check.html: a small, attractive standalone HTML page titled "Pi Work Check" displaying three supplied values: Alpha 42, Beta 31, Gamma 27. Use native write, then read it back. No research, commands or delegation are needed. Finish with one sentence.');
      const result = await idle(chat.id);
      const path = coding ? 'outputs/check.mjs' : 'outputs/check.html';
      const content = await readFile(join(history.generatedFilesRoot, chat.id, path), 'utf8'); assert.ok(content.length > 20);
      const tools = history.conversation(chat.id).tools;
      assert.ok(tools.some(tool => tool.name === (coding ? 'code_delegate' : 'code_write') && tool.status === 'success'));
      if (coding) assert.ok(tools.some(tool => tool.name === 'code_bash' && tool.status === 'success' && tool.result?.includes('42')), 'Delegated Node verification must pass through TinyGPT, not just create the file');
      await mkdir(resolve('artifacts'), { recursive: true });
      const proof = { verified: true, runtime: 'Pi + OpenCode', liveTask: coding ? 'code' : 'native', model: settings.local.model, effort: 'low', durationMs: Date.now() - started, artifact: path, bytes: Buffer.byteLength(content), answer: result.text, tools: tools.map(tool => ({ name: tool.name, status: tool.status })) };
      await writeFile(resolve(`artifacts/pi-work-live-${coding ? 'code' : 'native'}-proof.json`), JSON.stringify(proof, null, 2));
      console.log('PASS:', JSON.stringify(proof)); return;
    }
    scenario = 'plugin-lazy'; calls = 0;
    const lazyChat = history.createConversation(null, 'code'); service.start(lazyChat.id, 'Use only the requested plugin action.'); await idle(lazyChat.id);
    assert.equal(pluginExecutions, 2, 'Discovery retains the exact loaded action without executing anything itself');
    scenario = 'cache-stability'; calls = 0;
    const warmChat = history.createConversation(null, 'code'); service.start(warmChat.id, 'Create the synthetic file and inspect the directory.'); await idle(warmChat.id);
    assert.equal(traces.filter(trace => trace.event === 'context-pruned').length, 0, 'Healthy runs must not prune simply because large old entries exist');
    scenario = 'file-pages'; calls = 0;
    const pagedChat = history.createConversation(null, 'code'), pagedRoot = join(history.generatedFilesRoot, pagedChat.id);
    await mkdir(pagedRoot, { recursive: true });
    await writeFile(join(pagedRoot, 'app.js'), Array.from({length:338}, (_,i) => i === 145 ? 'const DOM_WEEK_SELECT_CONTROL = document.getElementById("weekSelect");' : '// Original source row ' + i + ' with meaningful file content.').join('\n'));
    await writeFile(join(pagedRoot, 'paging.txt'), Array.from({length:2100}, (_,i) => 'ROW_' + (i+1) + '_END').join('\n'));
    service.start(pagedChat.id, 'Read the app and inspect the entire large text file using contiguous pages.'); await idle(pagedChat.id);
    assert.equal(history.conversation(pagedChat.id).tools.filter(tool => tool.name === 'code_read' && tool.status === 'success').length, 3);
    scenario = 'native'; calls = 0;
    const chat = history.createConversation(null, 'code');
    service.start(chat.id, 'Create and verify a JavaScript module.'); await idle(chat.id);
    assert.equal(await readFile(join(history.generatedFilesRoot, chat.id, 'nested/probe.mjs'), 'utf8'), 'export const verified = true;');
    assert.ok(history.conversation(chat.id).tools.some(tool => tool.name === 'code_bash' && tool.status === 'success'));
    assert.ok(history.conversation(chat.id).tools.some(tool => tool.name === 'code_glob' && tool.status === 'success' && tool.result?.includes('probe.mjs')));
    assert.ok(history.conversation(chat.id).tools.some(tool => tool.name === 'code_grep' && tool.status === 'success' && tool.result?.includes('verified')));
    const change = history.codeChanges(chat.id)[0]; assert.equal(change.state, 'applied');
    scenario = 'followup'; calls = 0; service.start(chat.id, 'What did you just create?'); const followup = await idle(chat.id);
    scenario = 'regenerate'; calls = 0; service.start(chat.id, null, [], { type: 'regenerate', messageId: followup.id }); await idle(chat.id);
    await broker.code.undo(chat.id, change.id); await assert.rejects(stat(join(history.generatedFilesRoot, chat.id, 'nested/probe.mjs')));
    scenario = 'denied'; calls = 0; settings.toolPermissions.write = 'deny';
    const denied = history.createConversation(null, 'code'); service.start(denied.id, 'Write a file.'); await idle(denied.id);
    assert.ok(history.conversation(denied.id).tools.some(tool => tool.status === 'denied')); await assert.rejects(stat(join(history.generatedFilesRoot, denied.id, 'denied.mjs'))); settings.toolPermissions.write = 'allow';
    scenario = 'truncated'; calls = 0;
    const truncated = history.createConversation(null, 'code'); service.start(truncated.id, 'Create a report.'); await idle(truncated.id);
    await assert.rejects(stat(join(history.generatedFilesRoot, truncated.id, 'must-not-execute.txt')));
    assert.equal(await readFile(join(history.generatedFilesRoot, truncated.id, 'recovered.txt'), 'utf8'), 'Recovered with a complete call.');
    scenario = 'bounded-edits'; calls = 0;
    const bounded = history.createConversation(null, 'code'); service.start(bounded.id, 'Create and edit a small file.'); await idle(bounded.id);
    assert.equal(await readFile(join(history.generatedFilesRoot, bounded.id, 'bounded.txt'), 'utf8'), 'updated');
    assert.equal(history.codeChanges(bounded.id).filter(change => change.state === 'applied').length, 2, 'Rejected batch must not mutate or create a snapshot');
    scenario = 'truncated-repeat'; calls = 0;
    const repeated = history.createConversation(null, 'code'); service.start(repeated.id, 'Create a small file.');
    const repeatedDeadline = Date.now() + 20000;
    while (service.isActive(repeated.id) && Date.now() < repeatedDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(!service.isActive(repeated.id)); assert.equal(calls, 2);
    assert.equal(history.conversation(repeated.id).messages.at(-1)?.error, WORK_OUTPUT_STALLED_MESSAGE);
    await assert.rejects(stat(join(history.generatedFilesRoot, repeated.id, 'must-not-execute.txt')));
    await assert.rejects(stat(join(history.generatedFilesRoot, repeated.id, 'recovered.txt')));
    scenario = 'shell-error'; calls = 0;
    const shellError = history.createConversation(null, 'code'); service.start(shellError.id, 'Check a failing command.'); await idle(shellError.id);
    const failedCommand = history.conversation(shellError.id).tools.find(tool => tool.name === 'code_bash');
    assert.equal(failedCommand?.status, 'error'); assert.notEqual(JSON.parse(failedCommand!.result!).exitCode, 0);
    assert.ok(!JSON.parse(failedCommand!.result!).output.split('\n').some((line: string) => line.trim() === 'SHOULD_NOT_RUN'));
    scenario = 'byok'; calls = 0; settings.route = 'byok'; secret = 'fixture-key';
    settings.byok = { ...settings.byok, provider: 'openai', protocol: 'openai-compatible', endpoint: settings.local.endpoint, model: 'gpt-6.1-sol', tools: true, contextWindowTokens: 64000, maxOutputTokens: 8192 };
    const byok = history.createConversation(null, 'code'); service.start(byok.id, 'Reply with one sentence.'); await idle(byok.id); settings.route = 'local'; secret = undefined;
    scenario = 'pruning'; calls = 0;
    const pruned = history.createConversation(null, 'code'); service.start(pruned.id, 'Create a file, inspect the folder, and recover the original write.'); await idle(pruned.id);
    assert.equal(await readFile(join(history.generatedFilesRoot, pruned.id, 'large.txt'), 'utf8'), 'ARCHIVE_SENTINEL_' + 'z'.repeat(14000) + '_TAIL_ORIGINAL');
    assert.equal(history.conversation(pruned.id).tools.filter(tool => tool.name === 'code_write').length, 1, 'Retrieval must not repeat the write');
    await writeFile(join(history.generatedFilesRoot, pruned.id, 'large.txt'), 'Changed after the original observation.');
    scenario = 'pruning-resume'; calls = 0; service.start(pruned.id, 'Recover the original write again.'); await idle(pruned.id);
    scenario = 'compacting'; calls = 0;
    const compacted = history.createConversation(null, 'code'); service.start(compacted.id, 'Preserve color=blue. ' + 'Historical context. '.repeat(1500)); await idle(compacted.id);
    assert.ok(history.conversation(compacted.id).contextActivities?.some(activity => activity.status === 'complete'), 'Actual Pi compaction must finish');
    calls = 0; compactionPass = 1; service.start(compacted.id, 'Recheck the original constraint. ' + 'Later history. '.repeat(3000)); await idle(compacted.id);
    assert.ok((history.conversation(compacted.id).contextActivities?.filter(activity => activity.status === 'complete').length ?? 0) >= 2, 'Repeated compaction must preserve exact state');
    scenario = 'cancel'; calls = 0; const cancelled = history.createConversation(null, 'code'); service.start(cancelled.id, 'Run a long command.');
    const nativePid = await runningPid(cancelled.id, 'cancel.pid');
    await service.cancel(cancelled.id); await stoppedPid(nativePid); assert.equal(history.conversation(cancelled.id).messages.at(-1)?.status, 'cancelled');
    scenario = 'coding-limit'; calls = 0; codeCalls = 0;
    const limited = history.createConversation(null, 'code'); service.start(limited.id, 'Delegate a small implementation.');
    const limitDeadline = Date.now() + 60000;
    while (service.isActive(limited.id) && Date.now() < limitDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(!service.isActive(limited.id), 'Repeated exhaustion must pause');
    assert.equal(codeCalls, 2); assert.equal(calls, 3, 'A directory listing must not reset recovery');
    const limitedReply = history.conversation(limited.id).messages.at(-1)!;
    assert.equal(limitedReply.status, 'interrupted'); assert.equal(limitedReply.error, WORK_OUTPUT_STALLED_MESSAGE);
    const failedDelegates = history.conversation(limited.id).tools.filter(tool => tool.name === 'code_delegate');
    const failures = failedDelegates.map(tool => JSON.parse(JSON.parse(tool.result!).output).error);
    assert.equal(failures[0].sessionId, failures[1].sessionId); assert.equal(failures[0].stage, 'thinking');
    scenario = 'coding-limit-continue'; calls = 0; codeCalls = 0;
    service.start(limited.id, null, [], { type: 'continue', messageId: limitedReply.id }); await idle(limited.id);
    assert.equal(await readFile(join(history.generatedFilesRoot, limited.id, 'implementation.mjs'), 'utf8'), 'export const result = 42;');
    scenario = 'coding'; calls = 0; codeCalls = 0;
    const coding = history.createConversation(null, 'code'); service.start(coding.id, 'Delegate the implementation to OpenCode.'); await idle(coding.id);
    assert.equal(await readFile(join(history.generatedFilesRoot, coding.id, 'implementation.mjs'), 'utf8'), 'export const result = 42;');
    const delegate = history.conversation(coding.id).tools.find(tool => tool.name === 'code_delegate');
    assert.equal(delegate?.status, 'success'); codeSession = JSON.parse(JSON.parse(delegate!.result!).output).sessionId; assert.ok(codeSession);
    for (const name of ['code_write', 'code_read']) assert.ok(history.conversation(coding.id).tools.some(tool => tool.name === name && tool.status === 'success'), `Delegated ${name} must use the host bridge`);
    const codingReply = history.conversation(coding.id).messages.at(-1)!;
    for (const child of history.conversation(coding.id).tools.filter(tool => tool.id !== delegate!.id)) assert.ok(codingReply.workActivity?.some(entry => entry.toolId === child.id && entry.agentId === delegate!.id), 'Coding tools must retain their owning agent in saved activity');
    assert.equal(delegate?.summary, 'Work on code');
    const agent = workBlocks(codingReply.workActivity ?? [], history.conversation(coding.id).tools).find(block => block.kind === 'agent');
    assert.ok(agent?.kind === 'agent' && agent.blocks.filter(block => block.kind === 'prose').length >= 2, 'Native coding progress must retain separate inline prose entries');
    const delegatedFailure = history.conversation(coding.id).tools.find(tool => tool.name === 'code_bash');
    assert.equal(delegatedFailure?.status, 'error'); assert.notEqual(JSON.parse(delegatedFailure!.result!).exitCode, 0);
    assert.ok(!JSON.parse(delegatedFailure!.result!).output.split('\n').some((line: string) => line.trim() === 'SHOULD_NOT_RUN'));
    scenario = 'coding-resume'; calls = 0; codeCalls = 0; service.start(coding.id, 'Continue the coding task.'); await idle(coding.id);
    const resumedReply = history.conversation(coding.id).messages.at(-1)!;
    const resumedAgent = history.conversation(coding.id).tools.filter(tool => tool.name === 'code_delegate').at(-1)!;
    const resumedParts = resumedReply.workActivity?.filter(entry => entry.agentId === resumedAgent.id && entry.kind === 'prose') ?? [];
    assert.ok(resumedParts.length > 0 && resumedParts.every(entry => (entry.startedAt ?? 0) >= resumedAgent.createdAt), 'Resuming must not replay the previous agent prose into the new section');
    const delegatedChange = history.codeChanges(coding.id)[0]; assert.equal(delegatedChange.state, 'applied');
    await broker.code.undo(coding.id, delegatedChange.id); await assert.rejects(stat(join(history.generatedFilesRoot, coding.id, 'implementation.mjs')));
    scenario = 'coding-denied'; calls = 0; codeCalls = 0; settings.toolPermissions.write = 'deny';
    const codeDenied = history.createConversation(null, 'code'); service.start(codeDenied.id, 'Delegate a file write.'); await idle(codeDenied.id);
    assert.ok(history.conversation(codeDenied.id).tools.some(tool => tool.name === 'code_write' && tool.status === 'denied'));
    await assert.rejects(stat(join(history.generatedFilesRoot, codeDenied.id, 'implementation.mjs'))); settings.toolPermissions.write = 'allow';
    scenario = 'code-cancel'; calls = 0; codeCalls = 0;
    const codeCancel = history.createConversation(null, 'code'); service.start(codeCancel.id, 'Delegate a long coding task.');
    const delegatedPid = await runningPid(codeCancel.id, 'cancel-code.pid');
    const cancelledAt = Date.now(); await service.cancel(codeCancel.id); assert.ok(Date.now() - cancelledAt < 10000, 'Cancellation must stop the delegated runtime promptly');
    await stoppedPid(delegatedPid); assert.equal(history.conversation(codeCancel.id).messages.at(-1)?.status, 'cancelled');
    assert.ok(traces.some(event => event.event === 'context-pruned' && (event.savedCharacters ?? 0) > 10000));
    assert.ok(traces.filter(event => event.event === 'compaction-detail').length >= 2);
    assert.ok(traces.some(event => event.event === 'context-measure-end' && event.contextAfterTokens));
    assert.ok(traces.some(event => event.event === 'delegated-usage' && event.runtime === 'opencode'));
    assert.ok(traces.some(event => event.event === 'prompt-progress' && event.cacheReadTokens === 10000 && event.promptProcessedTokens === 2000));
    assert.ok(traces.some(event => event.event === 'request-shape' && (event.stablePrefixMessages ?? 0) > 0));
    await mkdir(resolve('artifacts'), { recursive: true });
    await writeFile(resolve('artifacts/pi-work-proof.json'), JSON.stringify({ verified: true, profile: root, nativePiTools: true, contiguousFilePages: true, pairedActionArchives: true, managedWorkspace: true, mjsFiles: true, bundledNode: true, question: true, nativeHistory: true, regenerationBranch: true, undo: true, denial: true, cancellation: true, truncatedCallsNotExecuted: true, nativeTruncationRecovery: true, openCodeDelegation: true, openCodeResume: true, openCodeCancellation: true, nativeThinkingEffort: 'medium', forcedTaskThinkingCutoff: false, recoverableContextPruning: true, archivedArgumentsSurviveForkAndFileChanges: true, exactConstraintsSurviveRepeatedCompaction: true, independentCompactionBudget: 3250, failedCodingSessionReused: true, repeatedOutputFailurePauses: true, continueRestoresFailedSession: true, compactions: traces.filter(event => event.event === 'compaction-detail'), retiredCharacters: traces.filter(event => event.event === 'context-pruned').reduce((sum,event)=>sum+(event.savedCharacters??0),0), delegatedUsageEvents: traces.filter(event => event.event === 'delegated-usage').length, requests: requests.length }, null, 2));
    console.log('PASS: Pi tools, history, branches, questions, Undo, denial, cancellation, OpenCode delegation and resume.');
  } finally { await service.shutdown(); await broker.shutdown(); closeChatRuntime(); history.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}).then(() => app.quit(), error => { console.error(error); app.exit(1); });

// Read-only audit of an existing Work run. Never sends inference or app actions.
// Output contains timings, tool metadata and counts, not credentials or thoughts.
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const [profile, conversationId, output = 'artifacts/ongoing-work-diagnosis.json'] = process.argv.slice(2);
if (!profile || !conversationId) throw Error('Pass profile and conversation ID.');
const history = new DatabaseSync(join(profile, 'library.sqlite'), { readOnly: true });
const diagnostics = new DatabaseSync(join(profile, 'diagnostics.sqlite'), { readOnly: true });
try {
  const taskRow = history.prepare('SELECT * FROM work_tasks WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1').get(conversationId);
  if (!taskRow) throw Error('No Work task found.');
  const task = JSON.parse(taskRow.data), runId = task.runId;
  const run = diagnostics.prepare('SELECT * FROM reply_traces WHERE run_id=?').get(runId);
  const events = diagnostics.prepare('SELECT data FROM reply_trace_events WHERE run_id=? ORDER BY sequence').all(runId).map(row => JSON.parse(row.data));
  const requestMap = new Map(), toolTimes = new Map(), queuedTimes = new Map(), endedTimes = new Map();
  const approvals = new Map(); let approvalMs = 0;
  for (const event of events) {
    if (event.event === 'request-start') requestMap.set(event.requestId, { id: event.requestId, at: event.elapsedMs, runtime: event.runtime, purpose: event.purpose });
    const request = requestMap.get(event.requestId);
    if (request && ['request-end', 'request-closed', 'request-error', 'request-cancelled'].includes(event.event) && request.end === undefined) { request.end = event.elapsedMs; request.durationMs = request.end - request.at; }
    if (event.event === 'tool-queued') queuedTimes.set(event.operationId, event.elapsedMs);
    if (event.event === 'tool-end') endedTimes.set(event.operationId, event.elapsedMs);
    if (event.event === 'tool-start') toolTimes.set(event.operationId, { at: event.elapsedMs });
    if (event.event === 'tool-end' && toolTimes.has(event.operationId)) toolTimes.get(event.operationId).durationMs = event.elapsedMs - toolTimes.get(event.operationId).at;
    if (event.event === 'approval-start') approvals.set(event.operationId, event.elapsedMs);
    if (event.event === 'approval-end' && approvals.has(event.operationId)) approvalMs += event.elapsedMs - approvals.get(event.operationId);
  }
  const questions = history.prepare('SELECT data FROM work_questions WHERE task_id=?').all(task.id).map(row => JSON.parse(row.data));
  const operations = new Map(history.prepare('SELECT id,input,result,status FROM work_operations WHERE task_id=?').all(task.id).map(row => [row.id, row]));
  const tools = history.prepare('SELECT id,name,status,created_at,result FROM tool_calls WHERE run_id=? ORDER BY created_at').all(runId).map(row => {
    const operation = operations.get(row.id); let args = {}; try { args = JSON.parse(operation?.input ?? '{}'); } catch {}
    let result; try { result = JSON.parse(row.result); } catch {}
    return { id: row.id, name: row.name, status: row.status, at: row.created_at - run.started_at, durationMs: toolTimes.get(row.id)?.durationMs,
      inputKeys: Object.keys(args), ...(typeof args.url === 'string' ? { url: args.url } : {}), ...(args.group ? { group: args.group, query: args.query } : {}),
      ...(args.elementId ? { elementId: args.elementId, tabId: args.tabId } : {}),
      ...(result?.title ? { pageTitle: result.title } : {}), ...(result?.code ? { code: result.code } : {}),
      ...(row.status === 'error' ? { error: String(result?.error ?? row.result).slice(0, 260) } : {}),
      ...(result?.toolNames ? { loadedTools: result.toolNames, offeredTools: result.tools?.map(tool => tool.name) } : {}), resultCharacters: row.result?.length ?? 0 };
  });
  const sessions = join(profile, 'work-runtime', conversationId, 'sessions');
  const sessionFile = (await readdir(sessions)).filter(file => file.endsWith('.jsonl')).sort().at(-1);
  const entries = (await readFile(join(sessions, sessionFile), 'utf8')).trim().split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const assistants = entries.filter(entry => entry.message?.role === 'assistant').map(entry => {
    const m = entry.message;
    return { at: entry.timestamp, usage: m.usage, stop: m.stopReason, thinkingCharacters: m.content.filter(p => p.type === 'thinking').reduce((s, p) => s + p.thinking.length, 0), textCharacters: m.content.filter(p => p.type === 'text').reduce((s, p) => s + p.text.length, 0), tools: m.content.filter(p => p.type === 'toolCall').map(p => ({ name: p.name, argumentCharacters: JSON.stringify(p.arguments).length })) };
  });
  const serverLog = await readFile(join(profile, 'local-models', 'pro', 'server.log'), 'utf8');
  const timings = new Map();
  for (const line of serverLog.split('\n')) {
    const match = line.match(/task\s+(\d+).*?(prompt eval time|\beval time)\s*=\s*([\d.]+) ms\s*\/\s*(\d+) tokens/);
    if (!match) continue;
    const row = timings.get(match[1]) ?? { task: Number(match[1]) };
    if (match[2] === 'prompt eval time') { row.promptMs = Number(match[3]); row.promptTokens = Number(match[4]); }
    else { row.generationMs = Number(match[3]); row.outputTokens = Number(match[4]); }
    timings.set(match[1], row);
  }
  const unused = [...timings.values()];
  for (const assistant of assistants) {
    const index = unused.findIndex(row => row.promptTokens === assistant.usage.input && Math.abs(row.outputTokens - assistant.usage.output) <= 1);
    if (index >= 0) assistant.server = unused.splice(index, 1)[0];
  }
  const requests = [...requestMap.values()];
  const total = field => assistants.reduce((sum, a) => sum + (a.server?.[field] ?? 0), 0);
  const answeredAt = new Map(entries.filter(e => e.message?.role === 'toolResult' && e.message.toolName === 'work_ask_user').flatMap(e => e.message.content.flatMap(part => { if (part.type !== 'text') return []; try { const result = JSON.parse(part.text); return [[result.workEvidenceId ?? e.message.toolCallId, Date.parse(e.timestamp)]]; } catch { return []; } })));
  const finishedAt = ['cancelled', 'completed', 'blocked'].includes(task.status) ? task.updatedAt : Date.now();
  const questionWaits = questions.map(q => ({ id: q.id, question: q.question, status: q.status, createdAt: q.createdAt, waitMs: answeredAt.has(q.operationId) ? Math.max(0, answeredAt.get(q.operationId) - q.createdAt) : endedTimes.has(q.operationId) && queuedTimes.has(q.operationId) ? endedTimes.get(q.operationId) - queuedTimes.get(q.operationId) : ['pending', 'dismissed'].includes(q.status) ? Math.max(0, finishedAt - q.createdAt) : null }));
  const summary = { capturedAt: new Date().toISOString(), conversationId, runId, status: task.status, startedAt: new Date(run.started_at).toISOString(), wallMs: finishedAt - run.started_at,
    requestCount: requests.length, requestMs: requests.reduce((sum, r) => sum + (r.durationMs ?? 0), 0),
    matchedServerRequests: assistants.filter(a => a.server).length, assistantRequests: assistants.length, matchedPromptMs: total('promptMs'), matchedGenerationMs: total('generationMs'),
    compaction: events.filter(e => e.event === 'compaction-detail'), contextEdits: events.filter(e => e.event === 'context-pruned').length,
    nonQuestionToolMs: tools.filter(t => t.name !== 'work_ask_user').reduce((s, t) => s + (t.durationMs ?? 0), 0), approvalMs,
    inputTokens: assistants.reduce((sum,a) => sum + a.usage.input, 0), cachedTokens: assistants.reduce((sum,a) => sum + a.usage.cacheRead, 0),
    outputTokens: assistants.reduce((sum,a) => sum + a.usage.output, 0), thinkingCharacters: assistants.reduce((sum,a) => sum + a.thinkingCharacters, 0),
    tools: tools.length, failedTools: tools.filter(t => t.status === 'error').length, pendingQuestion: questionWaits.find(q => q.status === 'pending'),
  };
  const report = { summary, questionWaits, tools, requests, assistants };
  await writeFile(resolve(output), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(summary));
  console.log(JSON.stringify({ questions: questionWaits, failures: tools.filter(t => t.status === 'error'), slowestRequests: requests.filter(r => r.durationMs).sort((a,b) => b.durationMs - a.durationMs).slice(0,5) }));
} finally { history.close(); diagnostics.close(); }

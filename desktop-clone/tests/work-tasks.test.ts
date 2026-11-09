import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryStore } from '../src/main/history';
import { WorkTaskController } from '../src/main/work-tasks';
import { ToolLoopGuard } from '../src/core/tool-loop';
import { operationOutcome } from '../src/core/operation-outcome';
import { agentTools } from '../src/core/agent-tools';

const stores: HistoryStore[] = [], folders: string[] = [];
afterEach(() => { stores.splice(0).forEach(h => h.close()); folders.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function setup(path = ':memory:') {
  const history = new HistoryStore(path); stores.push(history);
  const conversation = history.createConversation(null, 'code'), turn = history.startTurn(conversation.id, 'Create a dashboard', 'local');
  const task = history.workTasks.begin(conversation.id, turn.assistantId, turn.runId, 'Create a dashboard');
  return { history, conversation, turn, task, controller: new WorkTaskController(history.workTasks, task.id) };
}
it('records an optional plan without gating actions or creating criteria', () => {
  const { controller } = setup();
  expect(controller.beforeOperation('write_file', {})).toBeUndefined();
  expect(JSON.parse(controller.update('work_plan', { steps: ['Create the file'], criteria: ['Legacy checklist'] })).accepted).toBe(true);
  expect(controller.task.steps).toEqual(['Create the file']); expect(controller.task.criteria).toEqual([]);
});
it('preserves failed attempts in history without making them completion obligations', () => {
  const { history, task, controller } = setup();
  for (const [path, result] of [['/skill/frontend-design/dashboard.html', { error: 'Invalid path' }], ['dashboard.html', { action: 'created' }]] as const) {
    const id = randomUUID(); history.workTasks.startOperation(task.id, id, 'write_file', { path }); history.workTasks.finishOperation(task.id, id, JSON.stringify(result));
  }
  expect(JSON.parse(controller.update('work_finish', { answer: 'Created dashboard.html.' })).accepted).toBe(true);
  expect(history.workTasks.operations(task.id).map(op => op.status)).toEqual(['failed', 'succeeded']);
  expect(controller.decision()).toMatchObject({ action: 'stop', outcome: { answer: 'Created dashboard.html.' } });
});
it('stores a normal final answer and prevents further actions without rewriting the answer', () => {
  const { history, task, controller } = setup();
  controller.finish('Here is the result.');
  expect(controller.task.answer).toBe('Here is the result.'); expect(controller.task.criteria).toEqual([]);
  expect(controller.beforeOperation('write_file', {})).toContain('run has ended');
  expect(() => history.workTasks.save(task, task.revision)).toThrow('Work state changed');
});
it('keeps history retrieval available without evidence submission or replay', () => {
  const { history, task, controller } = setup(), id = randomUUID();
  history.workTasks.startOperation(task.id, id, 'read_file', { path: 'notes.txt' }); history.workTasks.finishOperation(task.id, id, '{"text":"Saved observation"}');
  expect(JSON.parse(controller.update('work_history', { query: 'notes.txt' })).text).toContain('Saved observation');
  expect(JSON.parse(controller.update('work_evidence', { evidenceId: id })).status).toBe('succeeded');
  expect(history.workTasks.operations(task.id)).toHaveLength(1);
});
it('persists interruption as unknown and resumes only the chosen ancestor', () => {
  const root = mkdtempSync(join(tmpdir(), 'tinygpt-work-state-')); folders.push(root); const path = join(root, 'history.sqlite');
  const { history, task, turn, conversation } = setup(path), id = randomUUID();
  history.workTasks.startOperation(task.id, id, 'ext_mutation', { password: 'must-not-persist', value: 1 });
  history.saveReply(turn.assistantId, 'In progress', 'interrupted', null);
  history.close(); stores.splice(stores.indexOf(history), 1);
  const reopened = new HistoryStore(path); stores.push(reopened);
  expect(reopened.workTasks.get(task.id).status).toBe('paused');
  expect(reopened.workTasks.operations(task.id)[0]).toMatchObject({ status: 'unknown', input: { password: '[redacted]', value: 1 } });
  const next = reopened.startTurn(conversation.id, 'Continue', 'local');
  const child = reopened.workTasks.begin(conversation.id, next.assistantId, next.runId, task.goal, reopened.workTasks.get(task.id));
  expect(reopened.workTasks.operations(child.id, true).map(op => op.id)).toEqual([id]);
  reopened.saveReply(next.assistantId, 'Paused', 'interrupted', null);
  const sibling = reopened.startTurn(conversation.id, null, 'local');
  const unrelated = reopened.workTasks.begin(conversation.id, sibling.assistantId, sibling.runId, 'New branch');
  expect(reopened.workTasks.operations(unrelated.id, true)).toEqual([]);
});
it('does not inject task state, force continuation, or score activity', () => {
  const { controller } = setup();
  for (let i = 0; i < 50; i++) expect(controller.decision('batch')).toEqual({ action: 'continue' });
  expect(controller.task.revision).toBe(0);
  controller.steer('Use a single HTML file'); expect(controller.task.goal).toContain('Use a single HTML file');
});
it('retains one generic identical-failure guard, including invalid finish calls', () => {
  const guard = new ToolLoopGuard(true);
  for (let i = 0; i < 40; i++) { guard.record('read_file', { path: 'x' }, '{"text":"same"}'); expect(guard.blocked('read_file', { path: 'x' })).toBe(false); }
  for (let i = 0; i < 3; i++) guard.record('work_finish', {}, '{"error":"Supply answer"}');
  expect(guard.blocked('work_finish', {})).toBe(true);
  expect(guard.blocked('work_finish', { answer: 'Finished.' })).toBe(false);
});
it('keeps Chat tools unchanged and advertises simple Work actions', () => {
  const chat = agentTools({ mode: 'chat', computer: true }).map(t => t.name);
  const work = agentTools({ mode: 'code', computer: true, workTask: {} as never }).map(t => t.name);
  expect(chat).toContain('present'); expect(chat).toContain('write_project_file'); expect(chat).not.toContain('run_command');
  for (const name of ['computer_read_window', 'browser_click', 'run_command', 'write_file', 'work_plan']) expect(work).toContain(name);
  expect(work).not.toContain('present'); expect(work).not.toContain('edit_project_file');
});
it('normalizes command failures, timeouts and uncertain outcomes for history', () => {
  expect(operationOutcome({ exitCode: 1 }).status).toBe('failed'); expect(operationOutcome({ timedOut: true }).status).toBe('failed');
  expect(operationOutcome({ exitCode: null }).status).toBe('unknown'); expect(operationOutcome({ exitCode: 0 }).status).toBe('succeeded');
});

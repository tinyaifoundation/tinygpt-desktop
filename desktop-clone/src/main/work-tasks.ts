import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { operationOutcome, operationSignature } from '../core/operation-outcome';
import { simplePlanSchema, simpleFinishSchema, workHistorySchema, workEvidenceSchema, workAskSchema, workAnswerSchema, isWorkOutcome, isWorkToolEnvelope, type WorkDecision, type WorkOutcome, type WorkOperation, type WorkTask, type WorkQuestion } from '../shared/work';

/** Facts and operation records are branch-scoped. Every attempt gets its own snapshot. */
export class WorkTaskStore {
  constructor(private db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS work_tasks (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE, run_id TEXT NOT NULL UNIQUE,
      parent_id TEXT REFERENCES work_tasks(id) ON DELETE SET NULL, revision INTEGER NOT NULL, data TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS work_operations (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
      name TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL, status TEXT NOT NULL, signature TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS work_operations_task ON work_operations(task_id,sequence);
    CREATE TABLE IF NOT EXISTS work_questions (id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,operation_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL) STRICT;`);
    for (const row of db.prepare('SELECT id,data FROM work_tasks').all()) {
      const task = JSON.parse(String(row.data)) as WorkTask;
      if (task.status === 'running') { task.status = 'paused'; task.summary = 'The app closed during execution. Recheck unfinished operations before continuing.'; this.save(task, task.revision); }
      // Older builds confused a reported blocked/waiting outcome with a cut-off
      // reply. Repair only that exact legacy marker; real interruptions retain
      // their error and partial answer even after an outcome was recorded.
      else if (isWorkOutcome(task.status)) {
        db.prepare("UPDATE messages SET status='complete',error=NULL WHERE id=? AND status='interrupted' AND error=? AND length(trim(text))>0").run(task.messageId, task.summary);
        const message = db.prepare('SELECT text,work_activity FROM messages WHERE id=?').get(task.messageId);
        const answer = task.answer ?? task.summary;
        if (message && isWorkToolEnvelope(String(message.text)) && answer.trim() && !isWorkToolEnvelope(answer)) {
          const activity = JSON.parse(String(message.work_activity)) as { kind: string; text: string }[];
          for (const part of activity) if (part.kind === 'prose' && part.text === message.text) part.text = answer;
          db.prepare("UPDATE messages SET text=?,work_activity=? WHERE id=? AND status='complete'").run(answer, JSON.stringify(activity), task.messageId);
        }
      }
    }
    db.prepare("UPDATE work_operations SET status='unknown',result=? WHERE status='running'").run(JSON.stringify({ error: 'Execution was interrupted; check whether the action completed before retrying.', code: 'OUTCOME_UNKNOWN' }));
  }
  get(id: string): WorkTask { const row = this.db.prepare('SELECT data FROM work_tasks WHERE id=?').get(id); if (!row) throw Error('Work task not found.'); const task = JSON.parse(String(row.data)) as WorkTask; return { ...task, criteria: task.criteria.map((criterion, i) => ({ ...criterion, id: criterion.id ?? `c${i + 1}` })) }; }
  forMessage(id: string): WorkTask | undefined { const row = this.db.prepare('SELECT data FROM work_tasks WHERE message_id=?').get(id); return row ? this.get(JSON.parse(String(row.data)).id) : undefined; }
  begin(conversationId: string, messageId: string, runId: string, goal: string, parent?: WorkTask, capabilities?: WorkTask['capabilities'], simple = false): WorkTask {
    const task: WorkTask = { simple, id: randomUUID(), conversationId, messageId, runId, revision: 0, status: 'running', goal: goal.slice(0, 32000), steps: parent?.steps ?? [], criteria: [], summary: parent?.summary ?? '', capabilities, userAnswers: parent?.userAnswers ?? [], updatedAt: Date.now() };
    this.db.prepare('INSERT INTO work_tasks VALUES(?,?,?,?,?,?,?)').run(task.id, conversationId, messageId, runId, parent?.id ?? null, 0, JSON.stringify(task)); return task;
  }
  save(task: WorkTask, expectedRevision: number): WorkTask {
    const next = { ...task, revision: expectedRevision + 1, updatedAt: Date.now() };
    if (this.db.prepare('UPDATE work_tasks SET revision=?,data=? WHERE id=? AND revision=? AND run_id=?').run(next.revision, JSON.stringify(next), task.id, expectedRevision, task.runId).changes !== 1) throw Error('Work state changed. Read the current state before updating it.');
    return next;
  }
  operations(taskId: string, ancestors = false): WorkOperation[] {
    const ids: string[] = []; let id: string | null = taskId;
    while (id) { if (ids.includes(id)) break; ids.unshift(id); id = this.db.prepare('SELECT parent_id FROM work_tasks WHERE id=?').get(id)?.parent_id as string | null; }
    // References are stable across continuation transcripts as well as live
    // context; a child must not relabel its own first operation as e1.
    return ids.flatMap(owner => this.db.prepare('SELECT id,name,input,result,status,signature FROM work_operations WHERE task_id=? ORDER BY sequence').all(owner).map(row => ({ owner, operation: { ...row, input: JSON.parse(String(row.input)) } as WorkOperation }))).map(({ owner, operation }, index) => ({ owner, operation: { ...operation, ref: `e${index + 1}` } })).filter(row => ancestors || row.owner === taskId).map(row => row.operation);
  }
  questions(): WorkQuestion[] { return this.db.prepare('SELECT data FROM work_questions ORDER BY rowid').all().map(row => JSON.parse(String(row.data))); }
  question(id: string): WorkQuestion { const row = this.db.prepare('SELECT data FROM work_questions WHERE id=?').get(id); if (!row) throw Error('This question is no longer available.'); return JSON.parse(String(row.data)); }
  ask(taskId: string, operationId: string, input: unknown): WorkQuestion {
    const task = this.get(taskId), args = workAskSchema.parse(input);
    if (new Set(args.options.map(option => option.id)).size !== args.options.length) throw Error('Question option IDs must be unique.');
    if (this.questions().some(question => question.taskId === taskId && question.status === 'pending')) throw Error('A question is already waiting for an answer.');
    if (task.status !== 'running') throw Error('This task cannot ask another question now.');
    const question: WorkQuestion = { id: randomUUID(), taskId, operationId, conversationId: task.conversationId, messageId: task.messageId, ...args, status: 'pending', createdAt: Date.now() };
    this.db.exec('BEGIN');
    try { this.db.prepare('INSERT INTO work_questions VALUES(?,?,?,?)').run(question.id, taskId, operationId, JSON.stringify(question)); this.startOperation(taskId, operationId, 'work_ask_user', args); this.save({ ...task, status: 'awaiting-input', summary: '' }, task.revision); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return question;
  }
  answer(input: unknown): WorkQuestion {
    const args = workAnswerSchema.parse(input), question = this.question(args.questionId), task = this.get(question.taskId);
    if (question.status !== 'pending' || task.status !== 'awaiting-input') throw Error('This question has already been answered or stopped.');
    const option = args.optionId ? question.options.find(option => option.id === args.optionId) : undefined;
    if (args.optionId && !option) throw Error('Choose an option from this question.');
    const answer = option?.label ?? args.text!;
    const next = { ...question, status: 'answered' as const, answer };
    const answers = [...(task.userAnswers ?? []), { questionId: question.id, question: question.question, answer }].slice(-24);
    while (answers.length > 1 && JSON.stringify(answers).length > 10000) answers.shift();
    this.db.exec('BEGIN');
    try { this.db.prepare('UPDATE work_questions SET data=? WHERE id=?').run(JSON.stringify(next), question.id); this.db.prepare("UPDATE work_operations SET result=?,status='succeeded' WHERE id=? AND task_id=? AND name='work_ask_user' AND status IN ('running','unknown')").run(JSON.stringify({ questionId: question.id, question: question.question, answer, workEvidenceId: question.operationId }), question.operationId, task.id); this.save({ ...task, status: 'running', userAnswers: answers }, task.revision); this.db.exec('COMMIT'); }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return next;
  }
  dismissQuestions(conversationId: string) {
    for (const question of this.questions().filter(question => question.conversationId === conversationId && question.status === 'pending')) {
      this.db.prepare('UPDATE work_questions SET data=? WHERE id=?').run(JSON.stringify({ ...question, status: 'dismissed' }), question.id);
      this.db.prepare("UPDATE work_operations SET status='cancelled',result=? WHERE id=? AND status IN ('running','unknown')").run('{"cancelled":true}', question.operationId);
      const task = this.get(question.taskId); if (task.status === 'awaiting-input') this.save({ ...task, status: 'cancelled', summary: 'Stopped by the user.' }, task.revision);
    }
  }
  startOperation(taskId: string, id: string, name: string, input: unknown) {
    const safe = (v: unknown): unknown => Array.isArray(v) ? v.map(safe) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([key, value]) => [key, /secret|password|authorization|api.?key|access.?token|refresh.?token/i.test(key) ? '[redacted]' : safe(value)])) : v;
    const args = safe(input && typeof input === 'object' && !Array.isArray(input) ? input : {}); const signature = operationSignature(name, args);
    this.db.prepare("INSERT INTO work_operations VALUES(?, ?, (SELECT COALESCE(MAX(sequence),0)+1 FROM work_operations WHERE task_id=?), ?, ?, '', 'running', ?)").run(id, taskId, taskId, name, JSON.stringify(args), signature);
  }
  finishOperation(taskId: string, id: string, result: string, cancelled = false) {
    const outcome = cancelled ? 'unknown' : operationOutcome(result).status;
    // Keep structured evidence parseable; long snapshots used to be cut in the
    // middle of JSON, losing their status and completion fields.
    const saved = result.length <= 1000000 ? result : JSON.stringify({ proofUnavailable: true, notice: 'Result exceeded the evidence limit. Read a narrower result before verification.' });
    this.db.prepare("UPDATE work_operations SET result=?,status=? WHERE id=? AND task_id=? AND status='running'").run(saved, outcome, id, taskId);
  }
}

/** Presentation and persistence only. The model owns task decisions; the host
 * records them without inventing obligations from failed attempts. */
export class WorkTaskController {
  constructor(readonly store: WorkTaskStore, readonly id: string, _legacyPolicy?: unknown) {}
  get task() { return this.store.get(this.id); }
  context() { const task = this.task; return JSON.stringify({ goal: task.goal, steps: task.steps, userAnswers: task.userAnswers }); }
  steer(text: string) {
    const task = this.task;
    this.store.save({ ...task, goal: task.goal + '\nAdditional user instruction: ' + text, status: 'running', summary: '' }, task.revision);
  }
  finish(answer: string, status: WorkOutcome['status'] = 'completed') {
    const task = this.task;
    if (task.status !== 'running') return task;
    return this.store.save({ ...task, status, summary: answer.slice(0, 2000), answer, criteria: [] }, task.revision);
  }
  update(name: string, input: unknown): string {
    const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
    if (name === 'work_history' || name === 'work_evidence') {
      const operations = this.store.operations(this.id, true);
      if (name === 'work_evidence') {
        const parsed = workEvidenceSchema.safeParse(input);
        const operation = parsed.success ? operations.find(op => op.id === parsed.data.evidenceId || op.ref === parsed.data.evidenceId) : undefined;
        if (!operation || !parsed.success) return JSON.stringify({ error: 'That saved result is unavailable.', code: 'HISTORY_NOT_FOUND' });
        const end = parsed.data.offset + parsed.data.limit;
        return JSON.stringify({ name: operation.name, status: operation.status, result: operation.result.slice(parsed.data.offset, end), ...(end < operation.result.length ? { nextOffset: end } : {}) });
      }
      const parsed = workHistorySchema.safeParse(input);
      if (!parsed.success) return JSON.stringify({ error: 'Use an optional text query and numeric offset.', code: 'INVALID_ARGUMENTS' });
      const query = parsed.data.query.toLowerCase();
      const text = operations.filter(op => !query || (op.name + JSON.stringify(op.input) + op.result).toLowerCase().includes(query)).slice(-24).map(op => JSON.stringify({ tool: op.name, status: op.status, input: op.input, result: op.result })).join('\n');
      const end = parsed.data.offset + 8000;
      return JSON.stringify({ text: text.slice(parsed.data.offset, end), totalLength: text.length, ...(end < text.length ? { nextOffset: end } : {}) });
    }
    if (name === 'work_plan') {
      const parsed = simplePlanSchema.safeParse({ steps: args.steps });
      if (!parsed.success) return JSON.stringify({ error: 'Supply steps as a list of strings.', code: 'INVALID_ARGUMENTS' });
      const task = this.task;
      if (task.status === 'running') this.store.save({ ...task, steps: parsed.data.steps }, task.revision);
      return JSON.stringify({ accepted: true });
    }
    if (name === 'work_finish') {
      // Old callers can still supply summary; old checklist fields are ignored.
      const parsed = simpleFinishSchema.safeParse({ answer: args.answer ?? args.summary, status: args.status });
      if (!parsed.success) return JSON.stringify({ error: 'Supply answer as text; optional status is completed, blocked, or waiting.', code: 'INVALID_ARGUMENTS' });
      const task = this.finish(parsed.data.answer, parsed.data.status);
      return JSON.stringify({ accepted: true, task });
    }
    return JSON.stringify({ error: 'Unknown task tool.', code: 'UNKNOWN_TOOL' });
  }
  beforeOperation(_name: string, _input: unknown): string | undefined {
    if (this.task.status !== 'running') return 'This run has ended. No additional action was executed.';
  }
  decision(_event?: string): WorkDecision {
    const task = this.task;
    return isWorkOutcome(task.status) ? { action: 'stop', outcome: { status: task.status, summary: task.summary, answer: task.answer } } : { action: task.status === 'running' ? 'continue' : 'stop' };
  }
  end(status: 'paused' | 'cancelled', summary: string) {
    const task = this.task;
    if (task.status === 'running') this.store.save({ ...task, status, summary }, task.revision);
  }
}

import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HistoryStore } from '../src/main/history';
import { ChatService } from '../src/main/chat-service';
import { defaultSettings } from '../src/shared/config';
import type { ChatExecution } from '../src/shared/chat';
import { ChatUpdateEncoder, ChatUpdateDecoder } from '../src/core/chat-updates';

const histories: HistoryStore[] = [], services: ChatService[] = [], folders: string[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.shutdown())); histories.splice(0).forEach(history => history.close()); folders.splice(0).forEach(folder => rmSync(folder, { recursive: true, force: true })); });
const settings = { ...defaultSettings, mode: 'code' as const, local: { ...defaultSettings.local, model: 'fixture', tools: true } };
function setup(engine?: ChatExecution, path = ':memory:', freeOnly = false) {
  const history = new HistoryStore(path); histories.push(history);
  const service = new ChatService(history, () => settings, () => undefined, engine ?? { async run(input, _signal, delta, tool) {
    await tool!({ id: randomUUID(), name: 'work_plan', input: { steps: ['Ask for the required choice'], criteria: ['User choice recorded'] } });
    const answer = JSON.parse(await tool!({ id: randomUUID(), name: 'work_ask_user', input: { question: 'Which account should I use?', options: freeOnly ? [] : [{ id: 'personal', label: 'Personal' }, { id: 'work', label: 'Work' }] } }));
    await tool!({ id: randomUUID(), name: 'work_finish', input: { status: 'completed', summary: 'Choice recorded.', criteria: [{ description: 'User choice recorded', evidenceIds: [answer.workEvidenceId], verification: 'The user answered: ' + answer.answer }] } });
    delta('Using ' + answer.answer + '.');
  } }, () => {});
  services.push(service); return { history, service };
}
it.each([false, true])('answers a %s free-text question and continues the same active task without another turn', async freeOnly => {
  const { history, service } = setup(undefined, ':memory:', freeOnly); const conversation = history.createConversation(null, 'code');
  const encoder = new ChatUpdateEncoder(), decoder = new ChatUpdateDecoder(); decoder.decode(encoder.encode(service.start(conversation.id, 'Choose an account.')));
  await vi.waitFor(() => expect(service.library().workQuestions).toHaveLength(1));
  const before = service.update(conversation.id).conversation.messages.at(-1)!; const question = service.library().workQuestions![0];
  expect(decoder.decode(encoder.encode(service.update(conversation.id))).library.workQuestions).toHaveLength(1);
  expect(before.workTask?.status).toBe('awaiting-input'); expect(before.status).toBe('streaming');
  await service.answerWorkQuestion({ questionId: question.id, ...(freeOnly ? { text: 'Shared team account' } : { optionId: 'work' }) });
  await vi.waitFor(() => expect(service.isActive(conversation.id)).toBe(false));
  const after = service.update(conversation.id).conversation.messages.at(-1)!;
  expect(after.id).toBe(before.id); expect(after.workTask?.id).toBe(before.workTask?.id); expect(after.status).toBe('complete'); expect(after.workTask?.status).toBe('completed');
  expect(after.text).toBe('Using ' + (freeOnly ? 'Shared team account' : 'Work') + '.'); expect(service.library().workQuestions).toEqual([]);
  expect(decoder.decode(encoder.encode(service.update(conversation.id))).library.workQuestions).toEqual([]);
});
it('rejects invalid choices and stale branches while preserving the pending answer', async () => {
  const { history, service } = setup(); const conversation = history.createConversation(null, 'code'); service.start(conversation.id, 'Choose.');
  await vi.waitFor(() => expect(service.library().workQuestions).toHaveLength(1)); const question = service.library().workQuestions![0];
  await expect(service.answerWorkQuestion({ questionId: question.id, optionId: 'invented' })).rejects.toThrow('Choose an option');
  expect(service.library().workQuestions).toHaveLength(1);
  history.startTurn(conversation.id, 'Another branch', 'local');
  await expect(service.answerWorkQuestion({ questionId: question.id, text: 'Wrong branch' })).rejects.toThrow('current task branch');
  expect(history.workTasks.question(question.id).status).toBe('pending');
});
it('stops a pending question without advancing the task or accepting a later answer', async () => {
  const { history, service } = setup(); const conversation = history.createConversation(null, 'code'); service.start(conversation.id, 'Choose.');
  await vi.waitFor(() => expect(service.library().workQuestions).toHaveLength(1)); const question = service.library().workQuestions![0];
  await service.cancelWorkQuestion(question.id); expect(service.isActive(conversation.id)).toBe(false); expect(history.workTasks.question(question.id).status).toBe('dismissed');
  await expect(service.answerWorkQuestion({ questionId: question.id, text: 'Too late' })).rejects.toThrow();
  expect(history.workTasks.get(question.taskId).status).toBe('cancelled');
});
it('restores a pending question after shutdown and continues its saved goal, answer and evidence without re-asking', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tinygpt-question-')); folders.push(root); const path = join(root, 'history.sqlite');
  const first = setup(undefined, path); const conversation = first.history.createConversation(null, 'code'); first.service.start(conversation.id, 'Keep this original goal.');
  await vi.waitFor(() => expect(first.service.library().workQuestions).toHaveLength(1)); const question = first.service.library().workQuestions![0];
  await first.service.shutdown(); first.history.close(); histories.splice(histories.indexOf(first.history), 1);
  let runs = 0;
  const second = setup({ async run(input, _signal, delta, tool) {
    runs++; expect(input.workTask?.goal).toBe('Keep this original goal.'); expect(input.workTask?.userAnswers?.at(-1)?.answer).toBe('Recovered answer');
    await tool!({ id: randomUUID(), name: 'work_finish', input: { status: 'completed', summary: 'Recovered.', criteria: [{ description: 'User choice recorded', evidenceIds: [question.operationId], verification: 'The restored user answer is recorded.' }] } }); delta('Recovered and continued.');
  } }, path);
  expect(second.service.library().workQuestions).toHaveLength(1);
  await second.service.answerWorkQuestion({ questionId: question.id, text: 'Recovered answer' });
  await vi.waitFor(() => expect(second.service.isActive(conversation.id)).toBe(false));
  expect(runs).toBe(1); expect(second.history.workTasks.questions()).toHaveLength(1);
  expect(second.service.update(conversation.id).conversation.messages.at(-1)).toMatchObject({ status: 'complete', text: 'Recovered and continued.', workTask: { status: 'completed' } });
});

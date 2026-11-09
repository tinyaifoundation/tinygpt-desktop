import { app, BrowserWindow, ipcMain } from 'electron';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HistoryStore } from '../src/main/history';
import { WorkActivityRecorder } from '../src/core/work-activity';
import type { ChatUpdate, MessageStatus } from '../src/shared/chat';

const profile = process.env.TINYGPT_TOOLS_PROFILE!;
mkdirSync(profile, { recursive: true }); app.setPath('userData', profile); app.setAppPath(resolve(__dirname, '..'));
const history = new HistoryStore(join(profile, 'library.sqlite'));
const project = history.createProject('Work fixture', '', false, resolve(__dirname, '..'));
const chat = history.createConversation(project.id, 'code'); history.renameConversation(chat.id, 'Work response fixture'); history.selectConversation(chat.id);
let turn: ReturnType<HistoryStore['startTurn']>, recorder: WorkActivityRecorder;
let status: MessageStatus = 'streaming'; let answer = ''; let approval = false; let answerVisible = false; let extraProgress = '';
let liveToolId: string; let taskId: string; let codingAgentId: string;
const publish = () => {
  const update: ChatUpdate = { conversation: history.conversation(chat.id), library: {
    projects: history.projects(), conversations: history.conversations(), lastConversationId: chat.id,
    activeRuns: status === 'streaming' ? [{ conversationId: chat.id, runId: turn.runId, phase: answerVisible ? 'answer' : 'prose', textLane: answerVisible ? 'answer' : 'progress', hasVisibleAnswer: answerVisible }] : [],
    workQuestions: history.workTasks.questions().filter(question => question.status === 'pending'), approvals: [], browserHandoffs: approval ? [{ conversationId: chat.id, tabId: randomUUID(), reason: 'Complete the sign-in, then resume.', url: 'https://example.com/login' }] : [], browserTasks: [],
  } };
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('tinygpt:chat-update', update);
  return update;
};
const save = () => { history.saveReply(turn.assistantId, answer, status, status === 'interrupted' ? 'TinyGPT closed before this reply finished. You can retry it.' : status === 'error' ? 'The reply exceeded the supported size.' : null, '', 64000, recorder.snapshot()); publish(); };
const tool = (name: Parameters<HistoryStore['addTool']>[3], target: string, result = 'Fixture completed successfully.', live = false, agentId?: string, displayText?: string) => {
  const id = randomUUID(); recorder.tool(id, agentId); history.addTool(id, chat.id, turn.runId, name, target, displayText); history.finishTool(id, live ? 'running' : 'success', live ? null : result); return id;
};
(globalThis as any).workResponseFixture = {
  begin() { turn = history.startTurn(chat.id, 'Inspect the app and check the implementation.', 'local'); taskId = history.workTasks.begin(chat.id, turn.assistantId, turn.runId, 'Verify Work response display').id; recorder = new WorkActivityRecorder(turn.runId); status = 'streaming'; answer = ''; answerVisible = false; extraProgress = ''; save(); },
  progress() {
    recorder.part('first', 'prose', 'I’ll inspect the app, then check its response rendering.');
    tool('code_bash', 'Run a focused check'); tool('search_web', 'Response rendering documentation');
    recorder.part('second', 'prose', 'The activity is ordered correctly. I’m checking the remaining cases.');
    tool('code_read', 'src/renderer/components/WorkResponse.tsx');
    recorder.part('thinking', 'reasoning', 'I will verify interruption and scrolling behavior.');
    tool('code_edit', 'src/renderer/components/WorkResponse.tsx');
    recorder.part('more-thinking', 'reasoning', 'The edit is ready for verification.');
    liveToolId = tool('code_bash', 'Verify the updated component', undefined, true);
    recorder.part('third', 'prose', 'The last check is underway.'); save();
  },
  coding() {
    recorder.part('parent-intro', 'prose', 'I’ll build the change and check it.');
    codingAgentId = tool('code_delegate', 'Delegate coding to OpenCode', undefined, true);
    recorder.part('coding-first', 'prose', 'I’ll inspect the existing implementation.', undefined, undefined, 0, codingAgentId);
    tool('code_read', 'index.html', undefined, false, codingAgentId);
    recorder.part('coding-second', 'prose', 'The saved state needs a small correction.', undefined, undefined, 0, codingAgentId);
    tool('code_edit', 'index.html', undefined, false, codingAgentId);
    recorder.part('coding-third', 'prose', 'The edit is ready. I’m checking it in the browser.', undefined, undefined, 0, codingAgentId);
    liveToolId = tool('code_devtools', 'Check browser messages', undefined, true, codingAgentId);
    save();
  },
  codingDone() {
    history.finishTool(liveToolId, 'success', 'No console errors.');
    recorder.part('coding-result', 'prose', 'The browser interaction passed.', undefined, undefined, 0, codingAgentId);
    history.finishTool(codingAgentId, 'success', 'Verified the saved implementation.');
    recorder.part('parent-review', 'prose', 'I’m reviewing the result.'); save();
  },
  codingFail() {
    history.finishTool(liveToolId, 'error', 'The browser check was interrupted.');
    history.finishTool(codingAgentId, 'error', 'The coding work was interrupted.');
    (globalThis as any).workResponseFixture.fail();
  },
  browserLanguage() {
    for (const action of ['navigate_page', 'list_console_messages', 'take_snapshot']) {
      liveToolId = tool('code_devtools', `Browser developer tools: ${action}`, undefined, action === 'take_snapshot', undefined, action);
    }
    save();
  },
  pendingLiveTool() { history.finishTool(liveToolId, 'pending'); publish(); },
  finishLiveTool() { history.finishTool(liveToolId, 'success', 'Fixture completed successfully.'); publish(); },
  moreProse() { extraProgress += ' Checking more work.'; recorder.part('third', 'prose', 'The last check is underway.' + extraProgress); save(); },
  long() { recorder.part('third', 'prose', 'The last check is underway.' + extraProgress + '\n\n' + Array.from({ length: 35 }, (_, i) => `Progress detail ${i + 1}. Checking that the chronological feed stays accessible.`).join('\n\n')); save(); },
  confirmFinal() { recorder.part('final', 'prose', 'Implementation verified.'); answer = recorder.complete(['final']); answerVisible = true; save(); },
  approval() { approval = true; publish(); },
  clearApproval() { approval = false; publish(); },
  finish() {
    recorder.part('final', 'prose', 'Implementation verified.\n\n' + Array.from({ length: 25 }, (_, i) => `Final detail ${i + 1}. The response and saved activity are available for review.`).join('\n\n') + '\n\nEnd of final answer.');
    answer = recorder.complete(['final']); const task = history.workTasks.get(taskId); history.workTasks.save({ ...task, status: 'completed', summary: 'Display fixture verified.' }, task.revision); status = 'complete'; save();
  },
  stop() { const task = history.workTasks.get(taskId); history.workTasks.save({ ...task, status: 'cancelled', summary: 'Stopped by the user.' }, task.revision); status = 'cancelled'; save(); },
  interrupt() { const task = history.workTasks.get(taskId); history.workTasks.save({ ...task, status: 'paused', summary: 'Display fixture paused.' }, task.revision); status = 'interrupted'; save(); },
  blocked() { const task = history.workTasks.get(taskId); history.workTasks.save({ ...task, status: 'blocked', summary: 'A required input is unavailable.' }, task.revision); recorder.part('blocked-final', 'prose', 'The result is saved. A required input is unavailable.'); answer = recorder.complete(['blocked-final']); status = 'complete'; save(); },
  fail() { const task = history.workTasks.get(taskId); history.workTasks.save({ ...task, status: 'paused', summary: 'The reply exceeded the supported size.' }, task.revision); status = 'error'; save(); },
  question(freeOnly = false) {
    (globalThis as any).workResponseFixture.begin();
    history.workTasks.ask(taskId, randomUUID(), { question: freeOnly ? 'What should the report include?' : 'Which account should I use?', options: freeOnly ? [] : [{ id: 'personal', label: 'Personal' }, { id: 'work', label: 'Work' }] });
    ipcMain.removeHandler('tinygpt:work-answer');
    ipcMain.handle('tinygpt:work-answer', (_event, input) => { const question = history.workTasks.answer(input); const task = history.workTasks.get(taskId); history.workTasks.save({ ...task, status: 'completed', summary: 'Answer saved.' }, task.revision); recorder.part('question-final', 'prose', 'Continuing with: ' + question.answer); answer = recorder.complete(['question-final']); status = 'complete'; save(); return { ok: true, value: publish() }; });
    save();
  },
};
app.on('browser-window-created', (_event, window) => { window.hide(); window.show = () => {}; window.focus = () => {}; });
require('../out/main/index.js');

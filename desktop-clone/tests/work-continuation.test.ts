import { expect, it } from 'vitest';
import { codePlugin } from '../src/main/code-plugin';
import { WORK_COMPACTION_CONTEXT, WORK_COMPACTION_CONTINUE } from '../src/core/work-instructions';

async function hooks() {
  const factory = new Function('fetch', 'process', codePlugin('http://localhost/native', 'fixture').replace('export default async', 'return async'))(async () => ({ ok: true, json: async () => ({}) }), { platform: 'linux' });
  return factory();
}
const old = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
function message(text: string, synthetic = false, marked = false, role = 'user', agent = 'build') { return { info: { role, agent }, parts: [{ type: 'text', text, synthetic, ...(marked ? { metadata: { compaction_continue: true } } : {}) }] }; }

it('replaces only native generated compaction continuation and retains an attachment warning', async () => {
  const plugin = await hooks(); const warning = 'Attachments exceeded the provider limit.\n\n';
  const output = { messages: [message(warning + old, true, true), message(old), message(old, true), message(old, true, true, 'assistant'), message(old, true, true, 'user', 'compaction')] };
  await plugin['experimental.chat.messages.transform']({}, output);
  expect(output.messages[0].parts[0].text).toBe(warning + WORK_COMPACTION_CONTINUE);
  expect(output.messages.slice(1).every(item => item.parts[0].text === old)).toBe(true);
  await plugin['experimental.chat.messages.transform']({}, output);
  expect(output.messages[0].parts[0].text).toBe(warning + WORK_COMPACTION_CONTINUE);
});

it('adds task and authorization preservation without replacing upstream compaction context', async () => {
  const plugin = await hooks(); const output = { context: ['Prior context'], prompt: undefined };
  await plugin['experimental.session.compacting']({}, output);
  expect(output.context).toEqual(['Prior context', WORK_COMPACTION_CONTEXT]);
  expect(output.prompt).toBeUndefined();
});

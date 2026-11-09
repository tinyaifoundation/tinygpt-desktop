import { afterEach, expect, it, vi } from 'vitest';
import { assertWorkEditSize, WorkLimitRecovery, WORK_EDIT_BYTES, workToolPayload } from '../src/core/work-limits';
import { workEffortPayload } from '../src/core/work-effort';
import type { ChatWorkerInput } from '../src/shared/chat';

afterEach(() => vi.unstubAllEnvs());
it('bounds UTF-8 change text and combined replacements without restricting reads or finished file size', () => {
  expect(() => assertWorkEditSize('code_write', { content: 'a'.repeat(WORK_EDIT_BYTES) })).not.toThrow();
  expect(() => assertWorkEditSize('code_write', { content: '🟢'.repeat(4097) })).toThrow('Nothing was executed');
  expect(() => assertWorkEditSize('code_edit', { oldString: 'a'.repeat(9000), newString: 'b'.repeat(9000) })).toThrow('16 KiB');
  expect(() => assertWorkEditSize('code_edit', { edits: [{ oldText: 'a', newText: 'b'.repeat(9000) }, { oldText: 'c', newText: 'd'.repeat(9000) }] })).toThrow('16 KiB');
  expect(() => assertWorkEditSize('code_apply_patch', { patchText: '+'.repeat(WORK_EDIT_BYTES + 1) })).toThrow('16 KiB');
  expect(() => assertWorkEditSize('code_read', { content: 'a'.repeat(500000) })).not.toThrow();
});
it('advertises bounded native arguments including Pi batch edits without changing unrelated or strict tools', () => {
  const input = { tools: [{ type: 'function', function: { name: 'edit', parameters: { type: 'object', properties: { edits: { type: 'array', items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string', maxLength: 1000 } } } } } } } }, { type: 'function', function: { name: 'write', strict: true, parameters: { properties: { content: { type: 'string' } } } } }] };
  const result = workToolPayload(input) as typeof input;
  expect(result.tools[0].function.parameters.properties.edits?.items.properties.oldText).toHaveProperty('maxLength', WORK_EDIT_BYTES);
  expect(result.tools[0].function.parameters.properties.edits?.items.properties.newText.maxLength).toBe(1000);
  expect(input.tools[0].function.parameters.properties.edits?.items.properties.oldText).not.toHaveProperty('maxLength');
  expect(result.tools[1]).toBe(input.tools[1]);
});
it('allows one recovery per runtime, resets on recorded changes and pauses repeated exhaustion', () => {
  const recovery = new WorkLimitRecovery();
  recovery.failed('pi', ''); recovery.failed('opencode', ''); recovery.assertAvailable();
  recovery.failed('opencode', 'saved-revision'); recovery.assertAvailable();
  recovery.failed('opencode', 'saved-revision'); expect(() => recovery.assertAvailable()).toThrow('Work paused');
});
it('reserves Pro Work action room while preserving native Max and smaller per-request output caps', () => {
  vi.stubEnv('TINYGPT_TEST_PRO_WORK_BUDGET', '1');
  const input = { provider: 'local', protocol: 'openai-compatible', model: 'tinygpt-pro', effort: 'max', reasoning: { kind: 'llamacpp', efforts: ['medium', 'xhigh'], canDisable: true } } as ChatWorkerInput;
  expect(workEffortPayload({ max_tokens: 16384 }, input, 16384)).toMatchObject({ max_tokens: 16384, reasoning_effort: 'xhigh', reasoning_budget_tokens: 8192 });
  expect(workEffortPayload({ max_tokens: 2048 }, input, 16384)).toMatchObject({ max_tokens: 2048, reasoning_effort: 'xhigh', reasoning_budget_tokens: 1024 });
  expect(workEffortPayload({}, { ...input, effort: 'high' }, 16384).reasoning_budget_tokens).toBe(4096);
  for (const changed of [{ model: 'tinygpt-included' }, { provider: 'custom' }, { provider: 'openrouter' }]) expect(workEffortPayload({}, { ...input, ...changed }, 16384).reasoning_budget_tokens).toBeUndefined();
  expect(workEffortPayload({}, { ...input, effort: 'instant' }, 16384)).toMatchObject({ reasoning_effort: 'none', reasoning_budget_tokens: 0 });
});

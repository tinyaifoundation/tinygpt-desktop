import { it, expect } from 'vitest';
import { botContextPolicy, botInitialMessage } from '../src/core/bot-context';
import type { ChatWorkerInput } from '../src/shared/chat';
it('seeds history once into the native context so compaction can retain it', () => {
  const input = { messages: [{ role: 'user', text: 'Earlier request' }, { role: 'assistant', text: 'Completed action' }, { role: 'user', text: 'Next request' }] } as ChatWorkerInput;
  const message = botInitialMessage(input); expect(message).toContain('Completed action'); expect(message).toContain('Current user message:\nNext request');
  expect(botInitialMessage({ ...input, messages: [input.messages[2]] })).toBe('Next request');
});
it('reserves output and safety headroom for native context across routes', () => {
  const local = botContextPolicy({ route: 'local', contextWindowTokens: 32768, maxOutputTokens: 4096 });
  expect(local.inputTokens + local.outputTokens).toBeLessThan(local.window);
  expect(local.inputTokens).toBe(27033);
});

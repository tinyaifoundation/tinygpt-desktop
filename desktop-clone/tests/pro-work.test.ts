import { expect, it } from 'vitest';
import { effortPayload } from '../src/core/effort';
import type { ChatWorkerInput } from '../src/shared/chat';

it('preserves native model effort settings without a separate Work reasoning policy', () => {
  const input = { mode: 'code', route: 'local', provider: 'local', protocol: 'openai-compatible', model: 'tinygpt-pro' } as ChatWorkerInput;
  for (const effort of ['high', 'max'] as const) {
    const pro = effortPayload({ max_tokens: 16384 }, { ...input, effort, reasoning: { kind: 'llamacpp', efforts: ['medium', 'xhigh'], canDisable: true } }, 16384);
    expect(pro).toEqual({ max_tokens: 16384, reasoning_effort: 'xhigh', chat_template_kwargs: { enable_thinking: true } });
    const mini = effortPayload({ model: 'tinygpt-included', max_tokens: 8192 }, { ...input, model: 'tinygpt-included', effort, reasoning: { kind: 'llamacpp', efforts: [], canDisable: true } }, 8192);
    expect(mini).toEqual({ model: 'tinygpt-included', max_tokens: 8192 });
  }
});

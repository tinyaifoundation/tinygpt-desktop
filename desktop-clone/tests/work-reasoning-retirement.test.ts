import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { workContextExtension } from '../src/main/work-context';
import { ObservationStore } from '../src/main/observations';

it.each(['local', 'signed', 'cloud', 'unfinished', 'recent', 'healthy', 'unknown', 'small-saving'])('archives older completed local reasoning only under pressure with substantial savings: %s', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'work-thinking-')), store = new ObservationStore(join(root, 'library.sqlite'));
  try {
    const handlers: Record<string, any> = {}, conversationId = randomUUID(), runId = randomUUID(), original = 'Exact earlier reasoning. ' + 'r'.repeat(kind === 'small-saving' ? 20000 : 60000);
    const part = { type: 'thinking', thinking: original, ...(kind === 'signed' ? { thinkingSignature: 'opaque-signed-provider-state' } : {}) };
    const message = { role: 'assistant', stopReason: kind === 'unfinished' ? 'length' : 'toolUse', content: [part, { type: 'text', text: 'A completed decision.' }] };
    const old = { sourceEntry: { type: 'message', id: 'old' }, messages: [message] };
    const recent = Array.from({ length: 8 }, (_, i) => ({ sourceEntry: { type: 'message', id: 'recent-' + i }, messages: [{ role: 'user', content: 'Keep user requests intact.' }] }));
    const projected = kind === 'recent' ? [...recent, old] : [old, ...recent];
    const extension = workContextExtension(store, { conversationId, runId, provider: kind === 'cloud' ? 'openrouter' : 'local', protocol: 'openai-compatible', route: 'local', reasoning: { kind: 'llamacpp' }, contextWindowTokens: 65536, maxOutputTokens: 16384 } as any, root, async () => ({} as any));
    await extension({ on(name: string, handler: any) { handlers[name] = handler; } } as any);
    const result = await handlers.turn_end({ context: { contextEntries: projected, contextMessages: [] } }, { getContextUsage: () => kind === 'unknown' ? undefined : ({ tokens: kind === 'healthy' ? 20000 : 40000 }) });
    if (kind === 'local') {
      const replacement = result.entries.find((entry: any) => entry.targetId === 'old').replacement.content;
      expect(replacement[1]).toEqual(message.content[1]); expect(replacement[0].thinking).not.toContain('r'.repeat(20000));
      const id = replacement[0].thinking.match(/id=([a-f0-9-]{36})/)[1]; expect((await store.get(conversationId, id)).text).toBe(original);
      await expect(store.get(randomUUID(), id)).rejects.toThrow();
    } else expect(result).toBeUndefined();
    expect(part.thinking).toBe(original);
  } finally { await rm(root, { recursive: true, force: true }); }
});

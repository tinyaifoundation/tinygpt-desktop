import { describe, expect, it } from 'vitest';
import { BotStreamMetadata } from '../src/core/bot-stream';
const bytes = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
describe('Bot provider stream metadata', () => {
  it('records one usage total across split frames and recognizes truncated tool arguments', () => {
    const usage: number[][] = []; const stream = new BotStreamMetadata((...value) => usage.push(value));
    const frame = bytes({ choices: [{ delta: { tool_calls: [{}] }, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    stream.push(frame.slice(0, 16)); stream.push(frame.slice(16)); stream.finish();
    expect(usage).toEqual([[100, 20]]); expect(stream.outputLimited).toBe(true); expect(stream.toolOutput).toBe(true);
  });
  it('combines Anthropic start/end usage and cache counts without double counting', () => {
    const usage: number[][] = []; const stream = new BotStreamMetadata((...value) => usage.push(value));
    stream.push(bytes({ message: { usage: { input_tokens: 10, cache_read_input_tokens: 50, cache_creation_input_tokens: 5 } } }));
    stream.push(bytes({ delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 12 } })); stream.finish();
    expect(usage).toEqual([[65, 12]]); expect(stream.outputLimited).toBe(true);
  });
});

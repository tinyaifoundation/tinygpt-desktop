/** Observe provider metadata without changing or buffering the forwarded stream. */
export class BotStreamMetadata {
  private decoder = new TextDecoder();
  private pending = '';
  private skipping = false;
  private input = 0;
  private output = 0;
  private hasUsage = false;
  outputLimited = false;
  toolOutput = false;
  constructor(private usage: (input: number, output: number) => void) {}
  push(chunk: Uint8Array) {
    this.pending += this.decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, newline).trimEnd(); this.pending = this.pending.slice(newline + 1);
      if (this.skipping) { this.skipping = false; continue; }
      if (!line.startsWith('data:')) continue;
      try {
        const frame = JSON.parse(line.slice(5));
        const usage = frame.response?.usage ?? frame.usage ?? frame.message?.usage;
        if (usage) {
          const tokens = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
          this.hasUsage = true;
          this.input = Math.max(this.input, tokens(usage.prompt_tokens ?? usage.input_tokens) + tokens(usage.cache_read_input_tokens) + tokens(usage.cache_creation_input_tokens));
          this.output = Math.max(this.output, tokens(usage.completion_tokens ?? usage.output_tokens));
        }
        this.outputLimited ||= frame.choices?.some((choice: any) => choice.finish_reason === 'length') || frame.delta?.stop_reason === 'max_tokens' || frame.response?.incomplete_details?.reason === 'max_output_tokens';
        this.toolOutput ||= frame.choices?.some((choice: any) => choice.delta?.tool_calls?.length) || frame.content_block?.type === 'tool_use' || frame.item?.type === 'function_call';
      } catch { /* The native protocol adapter owns malformed frame handling. */ }
    }
    if (this.pending.length > 1_000_000) { this.pending = ''; this.skipping = true; }
  }
  finish() { if (this.hasUsage) this.usage(this.input, this.output); }
}

/** The native realtime API sends suffix deltas, then the authoritative final. */
export class DictationTranscript {
  private finals: string[] = [];
  private partial = '';
  accept(event: { type: string; delta?: string; transcript?: string }): string | undefined {
    if (event.type === 'conversation.item.input_audio_transcription.delta') this.partial += event.delta ?? '';
    else if (event.type === 'conversation.item.input_audio_transcription.completed') {
      if (event.transcript?.trim()) this.finals.push(event.transcript.trim());
      this.partial = '';
    } else return;
    return [...this.finals, this.partial.trim()].filter(Boolean).join(' ');
  }
}

/** Replace the dictated range without overwriting the draft around it. */
export function insertDictation(before: string, text: string, after: string, limit = 32000): string {
  const prefix = before && !/\s$/.test(before) && text ? ' ' : '';
  const suffix = after && !/^\s/.test(after) && text ? ' ' : '';
  const available = Math.max(0, limit - before.length - after.length - prefix.length - suffix.length);
  if (!available) return before + after;
  return before + prefix + text.slice(0, available) + suffix + after;
}

// Consume OpenClaw's display projection, never raw tool or reasoning events.
export function botDisplayText(text: string): string {
  // Transport directives are not message copy. Preserve ordinary brackets,
  // Markdown links and literal examples inside code.
  return text.split(/(`{3}[\s\S]*?`{3}|~{3}[\s\S]*?~{3}|`[^`\n]*`)/g).map((part, index) => index % 2 ? part : part
    .replace(/\[\[\s*(?:reply_to_current|reply_to\s*:[^\]\r\n]+|audio_as_voice)\s*\]\]/gi, '')
    .replace(/<\/?(?:details|summary|dyor)\b[^>]*>/gi, '')).join('').trim();
}
export function botMessageText(message: any): string {
  if (!message || message.isReasoning === true) return '';
  const content = message.content;
  const text = Array.isArray(content) ? content.filter(part => part.type === 'text').map(part => part.text ?? '').join('') : typeof content === 'string' ? content : typeof message.text === 'string' ? message.text : '';
  const display = botDisplayText(text);
  return /^(NO_REPLY|HEARTBEAT_OK|ANNOUNCE_SKIP|REPLY_SKIP)$/i.test(display) ? '' : display;
}

export function botStreamText(previous: string, payload: any): string {
  if (payload.message) return botMessageText(payload.message);
  if (typeof payload.deltaText !== 'string') return previous;
  return payload.replace ? payload.deltaText : previous + payload.deltaText;
}

export function botHistoryReplies(messages: any[]): string[] {
  // Each foreground run has its own native session; background sessions may
  // contain older turns. Keep only the replies to the latest native user turn.
  let user = messages.length - 1;
  while (user >= 0 && messages[user].role !== 'user') user--;
  return messages.slice(user + 1).filter(message => message.role === 'assistant').map(botMessageText).filter(text => text.trim());
}

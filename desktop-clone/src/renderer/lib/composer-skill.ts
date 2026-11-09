export type ComposerSkillPrefix = { token: string; end: number; bodyStart: number };
export function composerSkillPrefix(text: string): ComposerSkillPrefix | undefined {
  const match = /^\/skill[ \t]+([^\s]+)/.exec(text);
  if (!match) return;
  const end = match[0].length;
  return { token: match[1], end, bodyStart: end + (text[end] === ' ' || text[end] === '\t' ? 1 : 0) };
}

/** Treat the visible command as one removable token without deleting the draft. */
export function removeComposerSkill(text: string, key: string, start: number, end: number): { text: string; caret: number } | undefined {
  const prefix = composerSkillPrefix(text);
  if (!prefix || !['Backspace', 'Delete'].includes(key)) return;
  const selectionTouchesPrefix = start !== end && start < prefix.end && end > 0;
  const backAtPrefix = key === 'Backspace' && start === end && start > 0 && start <= prefix.bodyStart;
  const deleteAtPrefix = key === 'Delete' && start === end && start < prefix.end;
  if (!selectionTouchesPrefix && !backAtPrefix && !deleteAtPrefix) return;
  return { text: text.slice(Math.max(prefix.bodyStart, end)), caret: 0 };
}

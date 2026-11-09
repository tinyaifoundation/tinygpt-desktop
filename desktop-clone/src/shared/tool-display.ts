/** Model-authored display metadata, following the web demo's `status` field. */
export const toolStatusSchema = {
  type: 'string', minLength: 1, maxLength: 48,
  description: '3–6 word action status, e.g. Comparing monthly spending. JSON only; never prose. No Markdown, secrets or completion claims.',
};
export const approvalTextSchema = { type: 'string', minLength: 1, maxLength: 240, description: 'Optional May I... question describing this action and purpose. JSON only; the host decides approval. Never print it or wait for permission yourself. No Markdown, secrets or completion claims.' };
export function toolApprovalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return /^May I\b/i.test(clean) && clean.length <= 240 && !/[<>`*\[\]]/.test(clean) ? clean : undefined;
}

export function toolDisplayText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean && clean.length <= 48 && !/[<>`*\[\]]/.test(clean) ? clean : undefined;
}

/** Legacy/provider commentary can accidentally narrate tool-call metadata.
 * Keep only its latest status, never a synthetic permission question. Ordinary
 * progress prose and final answer text are otherwise left intact.
 */
export function toolProgressText(value: string): string {
  const text = value.trim();
  const field = /^\s*(?:[-*]\s+)?(?:\*\*)?(status|permission|__tinygpt_status|__tinygpt_approval)(?:\*\*)?\s*:\s*(.*)$/i;
  const lines = text.split(/\r?\n/);
  if (!lines.some(line => field.test(line))) return /^May I\b[\s\S]*\?\s*$/i.test(text) ? '' : text;
  let latestStatus = ''; let metadata = false; const prose: string[] = [];
  for (const line of lines) {
    const match = field.exec(line);
    if (match) { metadata = true; if (/^(?:status|__tinygpt_status)$/i.test(match[1])) latestStatus = toolDisplayText(match[2]) ?? latestStatus; }
    else if (!line.trim()) metadata = false;
    else if (!metadata) prose.push(line);
  }
  return latestStatus || prose.join('\n').trim();
}

export function separateToolDisplay(args: unknown): { input: unknown; displayText?: string; approvalText?: string } {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { input: args };
  const { status, permission, ...input } = args as Record<string, unknown>;
  return { input, displayText: toolDisplayText(status), approvalText: toolApprovalText(permission) };
}

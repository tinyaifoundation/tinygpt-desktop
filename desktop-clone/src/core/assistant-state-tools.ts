import { operationSignature } from './operation-outcome';

/** Only explicit no-op state writes count here. Repeated reads/polls and
 * changed writes are legitimate work and must remain available. */
export class AssistantStateTools {
  private unchanged = new Map<string, number>();
  private withdrawn = new Set<string>();
  has(name: string) { return this.withdrawn.has(name); }
  record(name: string, input: unknown, content: readonly { type: string; text?: string }[]): boolean {
    let result: any;
    try { result = JSON.parse(content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')); } catch { return false; }
    if (!result || typeof result !== 'object' || result.error || result.isError) return false;
    const key = typeof result.id === 'string' ? name + ':' + result.id : operationSignature(name, input);
    if (result.unchanged !== true) { this.unchanged.delete(key); return false; }
    const count = (this.unchanged.get(key) ?? 0) + 1; this.unchanged.delete(key); this.unchanged.set(key, count);
    if (this.unchanged.size > 64) this.unchanged.delete(this.unchanged.keys().next().value!);
    if (count < 2) return false;
    this.withdrawn.add(name); return true;
  }
}

type Message = { role: string; content?: unknown; toolName?: string; toolCallId?: string; isError?: boolean };
/** Resume a successfully loaded host group in the next turn. Recheck against
 * today's allowed definitions; never replay a historical account grant. */
export function assistantRestoredGroup(messages: readonly Message[]): string | undefined {
  const calls = new Map<string, string>(); let group: string | undefined;
  for (const message of messages) {
    if (message.role === 'assistant' && Array.isArray(message.content)) for (const part of message.content) {
      if (part.type === 'toolCall' && part.name === 'load_tools' && typeof part.arguments?.group === 'string') calls.set(part.id, part.arguments.group);
    }
    if (message.role !== 'toolResult' || message.toolName !== 'load_tools' || message.isError) continue;
    const requested = calls.get(message.toolCallId ?? '');
    if (!requested) continue;
    let result: any;
    try { result = JSON.parse((Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'text').map(part => part.text).join('\n')); } catch { continue; }
    if (!result || result.error || result.code || !Array.isArray(result.tools) && !Array.isArray(result.toolNames)) continue;
    group = ['browser', 'research', 'images', 'skills'].includes(requested) ? requested : undefined;
  }
  return group;
}

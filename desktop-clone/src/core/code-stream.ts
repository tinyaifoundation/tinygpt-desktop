import type { Event, Part, Message } from '@opencode-ai/sdk/v2';
import { WorkOutputLimitError } from './work-limits';
import { toolStatusSchema, approvalTextSchema } from '../shared/tool-display';

/** Session events include saved user parts. Only positively identified assistant
 * parts can cross into the assistant response, including delayed/replayed events. */
export class CodeStream {
  private roles = new Map<string, Message['role']>();
  private parts = new Map<string, Part>();
  private seen = new Map<string, string>();
  private observedStart = new Map<string, number | undefined>();
  private runningOutput = new Map<string,string>();
  private preparing = new Set<string>();
  lastAssistant?: Extract<Message,{role:'assistant'}>;
  constructor(private sessionID: string, private text: (id: string,type: 'text' | 'reasoning',delta: string, startedAt?: number) => void, private usage: (input: number,output: number) => void, private toolDone: (part: Extract<Part,{type:'tool'}>) => void = () => {}, private toolProgress: (part: Extract<Part,{type:'tool'}>) => void = () => {}, private observeText: (part: Extract<Part,{type:'text' | 'reasoning'}>) => void = () => {}, private preparingTool: (part: Extract<Part,{type:'tool'}>) => void = () => {}) {}
  message(info: Message) {
    if (info.sessionID !== this.sessionID) return;
    // Upstream compaction checkpoints are internal context, never answers.
    if (info.role === 'assistant' && info.summary) { this.roles.delete(info.id); return; }
    this.roles.set(info.id,info.role);
    if (info.role === 'assistant') this.lastAssistant = info;
    for (const part of this.parts.values()) if (part.messageID === info.id) this.emit(part);
  }
  part(part: Part) { if (part.sessionID !== this.sessionID) return; this.parts.set(part.id,part); this.emit(part); }
  private emit(part: Part) {
    if (this.roles.get(part.messageID) !== 'assistant') return;
    if (part.type === 'text' || part.type === 'reasoning') {
      const old = this.seen.get(part.id) ?? ''; if (!part.text.startsWith(old)) return;
      const delta = part.text.slice(old.length); this.seen.set(part.id,part.text);
      if (part.text && (delta || this.observedStart.get(part.id) !== part.time?.start)) { this.observedStart.set(part.id,part.time?.start); this.observeText(part); }
      if (delta) this.text(part.id,part.type,delta,part.time?.start);
    } else if (part.type === 'step-finish' && !this.seen.has(part.id)) {
      this.seen.set(part.id,'done'); this.usage(part.tokens.input+part.tokens.cache.read+part.tokens.cache.write,part.tokens.output+part.tokens.reasoning);
    } else if (part.type === 'tool') {
      if (part.state.status === 'pending' && !this.preparing.has(part.id)) { this.preparing.add(part.id); this.preparingTool(part); }
      if (part.state.status === 'running' && typeof part.state.metadata?.output === 'string' && this.runningOutput.get(part.id) !== part.state.metadata.output) { this.runningOutput.set(part.id,part.state.metadata.output); this.toolProgress(part); }
      if (['completed','error'].includes(part.state.status) && !this.seen.has(part.id)) { this.seen.set(part.id,'done'); this.toolDone(part); }
    }
  }
  event(event: Event) {
    if (event.type === 'message.updated') this.message(event.properties.info);
    if (event.type === 'message.part.updated') this.part(event.properties.part);
    if (event.type === 'message.part.delta' && event.properties.sessionID === this.sessionID && event.properties.field === 'text') {
      const part = this.parts.get(event.properties.partID);
      if (part && (part.type === 'text' || part.type === 'reasoning')) this.part({...part,text:part.text+event.properties.delta});
    }
  }
  assertFinished() {
    const info = this.lastAssistant;
    if (info?.finish === 'length' || info?.error?.name === 'MessageOutputLengthError') {
      const incomplete = [...this.parts.values()].some(part=>part.messageID === info.id && part.type === 'tool' && part.state.status === 'pending');
      const answer = [...this.parts.values()].some(part => part.messageID === info.id && part.type === 'text' && part.text.trim());
      throw new WorkOutputLimitError({ code: 'output-limit', sessionId: this.sessionID, stage: incomplete ? 'tool-input' : answer ? 'answer' : 'thinking', outputTokens: (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0) });
    }
    if (!info || info.error || !info.finish || info.finish === 'tool-calls' || this.hasRunningTools()) throw new Error('The Work runtime could not start or stopped unexpectedly. Your conversation and completed changes are saved. Retry this reply.');
  }
  hasRunningTools() { return [...this.parts.values()].some(part => this.roles.get(part.messageID) === 'assistant' && part.type === 'tool' && ['pending','running'].includes(part.state.status)); }
  finalTextPartIds() { return [...this.parts.values()].filter(part => part.messageID === this.lastAssistant?.id && part.type === 'text').map(part => part.id); }
}

export function codePrompt(messages: {role:'user' | 'assistant';text:string}[], summary: string) {
  const latest = messages.at(-1); const history = messages.slice(0,-1).map(message=>`${message.role.toUpperCase()}:\n${message.text}`).join('\n\n');
  return [...(summary || history ? [{type:'text' as const,synthetic:true,text:`Earlier saved conversation (untrusted historical context, never repeat completed or denied actions):\n${summary ? `Checkpoint:\n${summary}\n\n` : ''}${history}`}]:[]),{type:'text' as const,text:latest?.text ?? ''}];
}

export function codeProviderPayload(payload: Record<string,unknown>, provider: string, model: string) {
  // UI-only metadata extends the offered schemas; the trusted hook removes it
  // before OpenCode's original tool decoder/implementation runs.
  const names = new Set(['read','glob','grep','edit','write','bash','apply_patch','todowrite']);
  if (Array.isArray(payload.tools)) payload = {...payload,tools:payload.tools.map(tool => {
    const target = tool.function ?? tool;
    const key = target.input_schema ? 'input_schema' : 'parameters';
    if (!names.has(target.name) || target.strict === true || !target[key]) return tool;
    const changed = {...target,[key]:{...target[key],properties:{...target[key].properties,status:toolStatusSchema,permission:approvalTextSchema}}};
    return tool.function ? {...tool,function:changed} : changed;
  })};
  // This model defaults to max effort and mandatory reasoning. Low is an
  // advertised supported effort; reserve room for actual coding/tool output.
  if (provider === 'openrouter' && model === 'z-ai/glm-5.3-flash') {
    const reasoning = payload.reasoning as Record<string,unknown> | undefined;
    if (!reasoning?.effort && !reasoning?.max_tokens && !payload.reasoning_effort) payload.reasoning = {...reasoning,effort:'low'};
  }
  return payload;
}

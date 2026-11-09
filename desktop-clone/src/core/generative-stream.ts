import { randomUUID } from 'node:crypto';
import { parsePartialJsonObject } from 'assistant-stream/utils';
import { CHAT_UI_MAX_CHARACTERS, validateChatUI, chatUIComponents, type ChatUINode } from '../shared/generative-ui';
import { separateToolDisplay } from '../shared/tool-display';
import type { ResponseEvent } from '../shared/chat';

/** Display-only projection. Incomplete nodes wait for their required props;
 * final tool execution still validates the complete original arguments. */
export function previewChatUI(text: string): ChatUINode | undefined {
  if (text.length > CHAT_UI_MAX_CHARACTERS) return;
  const parsed = parsePartialJsonObject(text);
  if (!parsed) return;
  const input = separateToolDisplay(parsed).input as Record<string, unknown>;
  if (typeof input.root !== 'string' || !input.elements || typeof input.elements !== 'object') return;
  const source = input.elements as Record<string, any>;
  const elements: Record<string, any> = {};
  const seen = new Set<string>(); let count = 0;
  function visit(id: string, depth = 0): boolean {
    if (++count > 150 || depth > 12 || seen.has(id)) return false;
    seen.add(id);
    const entry = source[id];
    if (!entry || !Object.hasOwn(chatUIComponents, entry.type) || !entry.props) return false;
    const props = { ...entry.props };
    if (['Table', 'Comparison'].includes(entry.type) && Array.isArray(props.columns) && Array.isArray(props.rows)) props.rows = props.rows.filter((row: unknown) => Array.isArray(row) && row.length === props.columns.length);
    const definition = chatUIComponents[entry.type as keyof typeof chatUIComponents];
    const checked = definition.props.safeParse(props);
    if (!checked.success) return false;
    const children = definition.slots.length && Array.isArray(entry.children) ? entry.children.filter((child: unknown): child is string => typeof child === 'string' && visit(child, depth + 1)) : [];
    elements[id] = { type: entry.type, props: checked.data, children };
    if (!definition.slots.length) {
      try { validateChatUI({ root: id, elements: { [id]: elements[id] } }); }
      catch { delete elements[id]; return false; }
    }
    return true;
  }
  if (!visit(input.root)) return;
  try { return validateChatUI({ root: input.root, elements }) as unknown as ChatUINode; } catch { return; }
}

type Fragment = { id?: string; index?: number; name?: string; args?: string };
type Pending = { id: string; providerId?: string; name: string; text: string; emitted?: string; at: number };
/** SDK-normalized fragments support all Chat providers. Nothing here executes
 * a partial tool or persists it as a successful presentation. */
export class GenerativeStream {
  private pending = new Map<string, Pending>();
  constructor(private publish: (event: ResponseEvent) => void) {}
  delta(step: string, fragments: Fragment[]): void {
    for (const fragment of fragments) {
      const key = `${step}:${fragment.index ?? 0}`;
      let entry = this.pending.get(key);
      if (!entry) {
        if (fragment.name !== 'present') continue;
        if (this.pending.size >= 16) continue;
        entry = { id: randomUUID(), name: '', text: '', at: 0 }; this.pending.set(key, entry);
      }
      if (fragment.id) entry.providerId = fragment.id;
      if (fragment.name) entry.name = fragment.name;
      if (entry.name !== 'present') continue;
      if (entry.text.length > CHAT_UI_MAX_CHARACTERS) continue;
      entry.text += fragment.args ?? '';
      if (Date.now() - entry.at < 50) continue;
      entry.at = Date.now();
      const ui = previewChatUI(entry.text);
      if (!ui) continue;
      const serialized = JSON.stringify(ui);
      if (serialized === entry.emitted) continue;
      entry.emitted = serialized;
      this.publish({ type: 'ui-preview', id: entry.id, ui });
    }
  }
  claim(args: unknown, providerId?: string): string {
    for (const [key, entry] of this.pending) {
      let matches = !!providerId && entry.providerId === providerId;
      if (!matches && entry.name === 'present') {
        try { matches = JSON.stringify(JSON.parse(entry.text)) === JSON.stringify(args); } catch { /* Execution validates malformed arguments. */ }
      }
      if (matches) { this.pending.delete(key); return entry.id; }
    }
    return randomUUID();
  }
  clear(): void {
    for (const entry of this.pending.values()) if (entry.emitted) this.publish({ type: 'ui-preview', id: entry.id, ui: null });
    this.pending.clear();
  }
}

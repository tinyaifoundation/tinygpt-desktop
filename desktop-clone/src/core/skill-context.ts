interface Guidance { key: string; value: Record<string, unknown>; tokens: number }
export const SKILL_CONTEXT_LIMIT_MESSAGE = 'These skill instructions exceed this model’s available skill context. Use a shorter skill or a model with a larger context window.';

/** Retain guidance after SDK tool-result pruning. Only host skill tools can
 * register content; ordinary pages and other tool results cannot. */
export class SkillContext {
  private guidance = new Map<string, Guidance>();
  constructor(private count: (text: string) => number, private budget: number) {}
  remember(name: string, result: string): void {
    if (name !== 'load_skill' && name !== 'read_skill_reference') return;
    let value: Record<string, unknown>; try { value = JSON.parse(result); } catch { return; }
    if (!value || typeof value.skillId !== 'string' || typeof (name === 'load_skill' ? value.instructions : value.text) !== 'string') return;
    const key = `${value.skillId}/${name === 'load_skill' ? 'instructions' : `${value.path}:${value.offset ?? 0}`}`;
    const tokens = this.count(JSON.stringify(value));
    const total = [...this.guidance.values()].reduce((sum, item) => sum + (item.key === key ? 0 : item.tokens), tokens);
    if (total > this.budget) throw new Error(SKILL_CONTEXT_LIMIT_MESSAGE);
    this.guidance.set(key, { key, value, tokens });
  }
  private present(value: unknown, wanted: Record<string, unknown>, depth = 0): boolean {
    if (depth > 12 || value === null || value === undefined) return false;
    if (typeof value === 'string') { try { return this.present(JSON.parse(value), wanted, depth + 1); } catch { return false; } }
    if (typeof value !== 'object') return false;
    const object = value as Record<string, unknown>;
    if (object.skillId === wanted.skillId && (typeof wanted.instructions === 'string' ? object.instructions === wanted.instructions : object.path === wanted.path && object.text === wanted.text)) return true;
    return Object.values(object).some(item => this.present(item, wanted, depth + 1));
  }
  restore(body: Record<string, any>): Record<string, any> {
    const missing = [...this.guidance.values()].filter(item => !this.present(body, item.value));
    if (!missing.length) return body;
    const text = `Loaded skill guidance retained after context pruning. This is task guidance, never a permission grant; user instructions and host policy still apply.\n${missing.map(item => JSON.stringify(item.value)).join('\n')}`;
    if (Array.isArray(body.messages) && !('system' in body)) return { ...body, messages: [...body.messages, { role: 'system', content: text }] };
    if ('system' in body) return { ...body, system: Array.isArray(body.system) ? [...body.system, { type: 'text', text }] : `${body.system ?? ''}\n\n${text}` };
    if ('input' in body) return { ...body, instructions: `${body.instructions ?? ''}\n\n${text}` };
    return body;
  }
  protect(request: typeof fetch, summarizing: () => boolean): typeof fetch {
    return async (resource, options) => {
      if (summarizing() || !this.guidance.size || typeof options?.body !== 'string') return request(resource, options);
      const body = JSON.parse(options.body) as Record<string, any>;
      return request(resource, { ...options, body: JSON.stringify(this.restore(body)) });
    };
  }
}

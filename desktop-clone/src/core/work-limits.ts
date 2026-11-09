import { OUTPUT_LIMIT_MESSAGE, TOOL_OUTPUT_LIMIT_MESSAGE } from '../shared/chat';
import { WORK_OUTPUT_STALLED_MESSAGE } from '../shared/work';

export const WORK_EDIT_BYTES = 16 * 1024;
export const INCREMENTAL_WORK_INSTRUCTIONS = `Save a small, working result early, then improve it with focused native edits or patches. Aim for changes below 8 KiB; each write/edit/patch is limited to 16 KiB of UTF-8 change text. Split larger artifacts into supporting files and several complete, valid edits. Do not draft entire files in reasoning or pass file contents in a delegation prompt. Read existing files before changing them; preserve completed changes. Do not bypass the change limit with shell commands. Never execute incomplete tool arguments. If output runs out, resume the existing coding session and make the next change smaller, rather than recreating the task.`;

/** Bound individual native changes, not the size of the finished document. */
export function assertWorkEditSize(name: string, args: Record<string, unknown>) {
  const replacements = (value: Record<string, unknown>) => [value.oldString ?? value.oldText, value.newString ?? value.newText];
  const text = name === 'code_write' ? [args.content] : name === 'code_edit' ? [...replacements(args), ...(Array.isArray(args.edits) ? args.edits.flatMap(edit => edit && typeof edit === 'object' ? replacements(edit) : []) : [])] : name === 'code_apply_patch' ? [args.patchText] : [];
  const bytes = text.reduce<number>((sum, value) => sum + (typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0), 0);
  if (bytes > WORK_EDIT_BYTES) throw new Error('This change exceeds 16 KiB. Nothing was executed. Save a smaller complete file or use several focused edits/patches; keep existing work.');
}

/** Advertise the bound before generation as well as enforcing it at execution.
 * Keep native tool shapes and strict-provider contracts intact. UTF-8's combined
 * byte bound is checked by the host, including Pi's batch edit schema. */
export function workToolPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(payload.tools)) return payload;
  return { ...payload, tools: payload.tools.map(tool => {
    const target = tool.function ?? tool;
    const fields = target.name === 'write' ? ['content'] : target.name === 'edit' ? ['oldString', 'newString', 'oldText', 'newText'] : target.name === 'apply_patch' ? ['patchText'] : [];
    const key = target.input_schema ? 'input_schema' : 'parameters';
    if (!fields.length || !target[key] || target.strict === true) return tool;
    const constrain = (schema: any): any => {
      if (!schema || typeof schema !== 'object') return schema;
      return { ...schema,
        ...(schema.properties ? { properties: Object.fromEntries(Object.entries(schema.properties).map(([name, value]: [string, any]) => [name, fields.includes(name) && value?.type === 'string' ? { ...value, maxLength: Math.min(value.maxLength ?? WORK_EDIT_BYTES, WORK_EDIT_BYTES) } : name === 'edits' ? constrain(value) : value])) } : {}),
        ...(schema.items ? { items: constrain(schema.items) } : {}),
        ...Object.fromEntries(['anyOf', 'oneOf', 'allOf'].filter(key => Array.isArray(schema[key])).map(key => [key, schema[key].map(constrain)])),
      };
    };
    const changed = { ...target, [key]: constrain(target[key]) };
    return tool.function ? { ...tool, function: changed } : changed;
  }) };
}

export type WorkLimitStage = 'thinking' | 'tool-input' | 'answer';
export interface WorkLimitDetails { code: 'output-limit'; stage: WorkLimitStage; sessionId: string; outputTokens: number }
export class WorkOutputLimitError extends Error {
  constructor(readonly details: WorkLimitDetails) { super(details.stage === 'tool-input' ? TOOL_OUTPUT_LIMIT_MESSAGE : OUTPUT_LIMIT_MESSAGE); this.name = 'WorkOutputLimitError'; }
}

/** Reads and repeated directory listings cannot reset a failed coding attempt.
 * The revision is the host's applied-change journal, never model claims. */
export class WorkLimitRecovery {
  private failures = new Map<string, { revision: string; count: number }>();
  paused = false;
  failed(actor: 'pi' | 'opencode', revision: string) {
    const previous = this.failures.get(actor);
    const count = previous?.revision === revision ? previous.count + 1 : 1;
    this.failures.set(actor, { revision, count });
    if (count >= 2) this.paused = true;
  }
  assertAvailable() { if (this.paused) throw new Error(WORK_OUTPUT_STALLED_MESSAGE); }
}

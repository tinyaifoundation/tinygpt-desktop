import { z } from 'zod';
import { legacyComponents as chatUILibrary } from './chat-ui-catalog';
export type ChatUINode = Record<string, unknown>;
export const CHAT_UI_MAX_CHARACTERS = 80000;

// Structural checks complement the primitive prop schemas: a valid table/chart
// must contain usable data, and content must not be nested where it is ignored.
function validateComposition(type: string, props: Record<string, unknown>, children: unknown, path: string) {
  if (['Table', 'Chart', 'ChartPanel', 'Fact', 'Badge', 'Spacer', 'Divider', 'MetricGrid', 'Comparison', 'FollowUp', 'FollowUpGroup'].includes(type) && children !== undefined) {
    throw new Error(`${path}.children (${type}): This component does not accept children. Put a caption or explanation beside it in a Col.`);
  }
  if (type === 'Table' || type === 'Comparison') {
    const columns = props.columns as unknown[] | undefined;
    const rows = props.rows as unknown[][] | undefined;
    if (!columns?.length || !rows?.length) throw new Error(`${path} (${type}): Provide nonempty columns and rows.`);
    if (columns.length > 12 || rows.length > 100) throw new Error(`${path} (${type}): Use at most 12 columns and 100 rows.`);
    if (rows.some(row => row.length !== columns.length)) throw new Error(`${path}.rows (${type}): Every row must have exactly ${columns.length} cells, matching columns.`);
    for (const column of columns as { format?: { kind: string; currency?: string; decimals?: number } }[]) {
      if (column.format?.kind === 'currency' && !/^[A-Z]{3}$/.test(column.format.currency ?? '')) throw new Error(`${path}.columns (${type}): Currency formatting requires a three-letter currency code, such as USD.`);
      if (column.format?.decimals !== undefined && (!Number.isInteger(column.format.decimals) || column.format.decimals < 0 || column.format.decimals > 20)) throw new Error(`${path}.columns (${type}): decimals must be an integer from 0 to 20.`);
    }
  }
  if (type === 'Chart' || type === 'ChartPanel') {
    const series = props.series as { label?: string; data: { label?: string; value: number }[] }[] | undefined;
    const groups = series ?? [{ data: props.data as { label?: string; value: number }[] | undefined }];
    const minimum = ['line', 'area', 'sparkline'].includes(String(props.variant)) ? 2 : 1;
    if (!groups.length || groups.length > 8 || groups.some(group => !group.data || group.data.length < minimum || group.data.length > 60)) throw new Error(`${path} (${type}): Provide ${minimum}–60 points per series and at most 8 series.`);
    if (groups.some(group => group.data!.length !== groups[0]!.data!.length)) throw new Error(`${path}.series (${type}): All series must have the same number of points.`);
    if (series && series.length > 1 && series.some(group => !group.label?.trim())) throw new Error(`${path}.series (${type}): Name every series so the legend is useful.`);
    if (props.variant !== 'sparkline' && groups.some(group => group.data!.some(point => !point.label?.trim()))) throw new Error(`${path} (${type}): Label every point; use sparkline for an intentionally compact unlabeled trend.`);
  }
}

function uiPath(path: string, key: PropertyKey): string {
  return typeof key === 'number' ? `${path}[${key}]` : `${path}.${String(key).slice(0, 80)}`;
}

export function validateChatUI(value: unknown): ChatUINode {
  if (JSON.stringify(value)?.length > CHAT_UI_MAX_CHARACTERS) throw new Error('The interface is too large.');
  let count = 0;
  function node(input: unknown, depth: number, path: string): unknown {
    if (++count > 150 || depth > 12) throw new Error(`${path}: The interface exceeds the component count or nesting limit.`);
    // Some tool-capable models serialize nested nodes a second time. Decode
    // only component-shaped children, then apply the same strict validation.
    if (typeof input === 'string' && /^[\[{]/.test(input.trim()) && /"\$type"\s*:/.test(input)) {
      let decoded: unknown;
      try { decoded = JSON.parse(input); } catch { throw new Error(`${path}: Malformed JSON in encoded children. Send a component object or array directly.`); }
      return node(decoded, depth + 1, path);
    }
    if (typeof input === 'string' || typeof input === 'number' || input === null) return input;
    if (Array.isArray(input)) return input.map((child, index) => node(child, depth + 1, uiPath(path, index)));
    if (!input || typeof input !== 'object') throw new Error(`${path}: Expected text or a component object.`);
    const raw = input as Record<string, unknown>;
    const type = raw.$type;
    if (typeof type !== 'string' || !Object.hasOwn(chatUILibrary, type)) throw new Error(`${path}.$type: Select a declared interface component.`);
    const definition = chatUILibrary[type as keyof typeof chatUILibrary]!;
    const { $type, $key, children, ...props } = raw;
    // Strict props prevent unsupported side effects and inherited object keys.
    const parsed = (definition.properties as z.ZodObject).strict().safeParse(props);
    if (!parsed.success) {
      const details = parsed.error.issues.slice(0, 3).map(issue => {
        const issuePath = issue.path.reduce<string>((current, key) => uiPath(current, key), path);
        const hint = type === 'ListViewItem' && issue.code === 'unrecognized_keys' && issue.keys.includes('label') ? ' Put item text in children instead of label.' : '';
        return `${issuePath} (${type}): ${issue.message.slice(0, 240)}.${hint}`;
      }).join(' ');
      throw new Error(details);
    }
    if ($key !== undefined && typeof $key !== 'string' && typeof $key !== 'number') throw new Error(`${path}.$key: Expected a string or number.`);
    validateComposition(type, parsed.data, children, path);
    if (type === 'ListView' && children !== undefined) {
      const items = typeof children === 'string' && /^[\[{]/.test(children.trim()) ? JSON.parse(children) : children;
      if (![items].flat().every(item => item && typeof item === 'object' && (item as ChatUINode).$type === 'ListViewItem')) throw new Error(`${path}.children (ListView): Use ListViewItem children.`);
    }
    return { $type, ...($key !== undefined ? { $key } : {}), ...parsed.data, ...(children !== undefined ? { children: node(children, depth + 1, `${path}.children`) } : {}) };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('An interface must start with a component.');
  return node(value, 0, '$') as ChatUINode;
}
export const presentArguments = z.record(z.string(), z.unknown()).transform((value, context) => {
  try { return validateChatUI(value); }
  catch (error) { context.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid interface.' }); return z.NEVER; }
});

// Previously saved presentations accepted arbitrary string children, including
// malformed encoded trees. Recover only complete, strictly validated display
// components; never execute, invent text, or change the saved tool outcome.
export function restoreSavedChatUI(value: unknown): { ui: ChatUINode; partial: boolean } {
  try { return { ui: validateChatUI(value), partial: false }; } catch { /* Legacy string children only. */ }
  if (!value || typeof value !== 'object' || Array.isArray(value) || JSON.stringify(value).length > CHAT_UI_MAX_CHARACTERS) throw new Error('Invalid saved interface.');
  const raw = value as Record<string, unknown>;
  if (typeof raw.children !== 'string' || !/^[\[{]/.test(raw.children.trim()) || !/"\$type"\s*:/.test(raw.children)) throw new Error('Invalid saved interface.');
  const text = raw.children; const stack: number[] = []; const fragments: { start: number; end: number; value: unknown }[] = [];
  let quoted = false; let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
    if (char === '"') quoted = true;
    else if (char === '{') stack.push(index);
    else if (char === '}' && stack.length) {
      const start = stack.pop()!;
      try { const candidate = JSON.parse(text.slice(start, index + 1)); if (typeof candidate.$type === 'string') fragments.push({ start, end: index, value: candidate }); } catch { /* Never guess malformed component contents. */ }
    }
    if (stack.length > 32 || fragments.length > 300) throw new Error('The saved interface is too complex.');
  }
  function legacyLabels(input: unknown, depth = 0): unknown {
    if (depth > 12) throw new Error('The saved interface is too complex.');
    if (Array.isArray(input)) return input.map(child => legacyLabels(child, depth + 1));
    if (!input || typeof input !== 'object') return input;
    const node = input as Record<string, unknown>;
    if (node.$type === 'ListViewItem' && typeof node.label === 'string' && node.children === undefined) { const { label, ...rest } = node; return { ...rest, children: label }; }
    return { ...node, ...(node.children !== undefined ? { children: legacyLabels(node.children, depth + 1) } : {}) };
  }
  const children: ChatUINode[] = []; let acceptedEnd = -1;
  for (const fragment of fragments.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (fragment.start <= acceptedEnd) continue;
    try { children.push(validateChatUI(legacyLabels(fragment.value))); acceptedEnd = fragment.end; } catch { /* A valid descendant can still be restored. */ }
  }
  if (!children.length) throw new Error('The saved interface could not be restored.');
  return { ui: validateChatUI({ ...raw, children }), partial: true };
}

export interface AXNode {
  nodeId: string; ignored: boolean; backendDOMNodeId?: number; childIds?: string[];
  role?: { value?: unknown }; name?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
}
const interactiveRoles = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'option']);
export const axRole = (node: AXNode): string => String(node.role?.value ?? '');
export const axName = (node: AXNode): string => String(node.name?.value ?? '');
export const axProperty = (node: AXNode, name: string): unknown => node.properties?.find(property => property.name === name)?.value.value;
export function interactiveAXNodes(nodes: AXNode[]): AXNode[] { return nodes.filter(node => !node.ignored && !!node.backendDOMNodeId && interactiveRoles.has(axRole(node))); }

export function activeAXDialog(nodes: AXNode[], dialogVisible = false) {
  const dialogs = nodes.filter(node => !node.ignored && ['dialog', 'alertdialog'].includes(axRole(node)));
  const modal = dialogs.filter(node => axProperty(node, 'modal') === true);
  const dialog = modal.at(-1) ?? (dialogVisible ? dialogs.at(-1) : undefined);
  if (!dialog) return undefined;
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const descendants = new Set<string>();
  const visit = (id: string) => { if (descendants.has(id)) return; descendants.add(id); for (const child of byId.get(id)?.childIds ?? []) visit(child); };
  visit(dialog.nodeId);
  return { node: dialog, descendants };
}

export function safeBrowserHref(value: string, base: string): string | undefined {
  try { const url = new URL(value, base); if (value && ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2048) return url.href; } catch { /* Not a navigable web link. */ }
}

// Never emit field values: password and other typed values stay in Chromium.
export function accessibilityOutlineDetail(nodes: AXNode[], references: Map<string, string>) {
  const byId = new Map(nodes.map(node => [node.nodeId, node])); const seen = new Set<string>(); const lines: string[] = []; let size = 0;
  function visit(node: AXNode, depth: number) {
    if (seen.has(node.nodeId) || lines.length >= 400 || size >= 16000) return;
    seen.add(node.nodeId);
    const role = axRole(node); const name = axName(node).slice(0, 240);
    const show = !node.ignored && (name || references.has(node.nodeId) || ['RootWebArea', 'heading', 'dialog', 'navigation', 'main'].includes(role));
    if (show) {
      const states = ['disabled', 'readonly', 'checked', 'expanded', 'selected'].flatMap(key => { const value = axProperty(node, key); return value === undefined ? [] : [`${key}=${String(value)}`]; });
      const line = `${'  '.repeat(Math.min(depth, 10))}${references.has(node.nodeId) ? `[${references.get(node.nodeId)}] ` : ''}${role}${name ? ` ${JSON.stringify(name)}` : ''}${states.length ? ` (${states.join(', ')})` : ''}`;
      size += line.length; lines.push(line);
    }
    for (const id of node.childIds ?? []) { const child = byId.get(id); if (child) visit(child, depth + Number(show)); }
  }
  if (nodes[0]) visit(nodes[0], 0);
  for (const node of nodes) if (!seen.has(node.nodeId)) visit(node, 0);
  const text = lines.join('\n').slice(0, 16000);
  return { text, coverage: { returnedCharacters: text.length, truncated: seen.size < nodes.length || size > 16000 } };
}
export function accessibilityOutline(nodes: AXNode[], references: Map<string, string>): string { return accessibilityOutlineDetail(nodes, references).text; }

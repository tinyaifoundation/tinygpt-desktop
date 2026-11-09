/** Refresh a small local model's view of its current loadout without rewriting
 * the saved transcript or treating earlier assistant refusals as permissions. */
export function groundPiServiceTools(body: Record<string, unknown>, available: { name: string; label: string }[], attempted: number): Record<string, unknown> {
  if (!Array.isArray(body.messages) || !Array.isArray(body.tools)) return body;
  const declared = new Set(body.tools.map((tool: any) => tool.function?.name ?? tool.name));
  const tools = available.filter(tool => declared.has(tool.name));
  if (!tools.length) return body;
  const content = [
    'Current host tool state for this reply:',
    `These connected-service functions are loaded and callable now: ${tools.map(tool => `${tool.name} (${tool.label})`).join(', ')}.`,
    'Earlier assistant statements about missing tools and older discovery results are historical; they do not describe this current loadout. Function availability does not guarantee account authorization: the actual tool result is authoritative.',
    attempted === 0 ? 'No service action has been attempted in this reply. If the user requested one of these actions, call the appropriate tool before claiming it cannot be used. Perform only the actions the user requested.' : 'A service action has been attempted in this reply. Continue from its actual results or errors, and summarize when the requested task is complete. Never invent a successful action.',
  ].join('\n');
  // llama.cpp templates require system instructions at the head. This is
  // transient tool-state data, so keep it at the tail in a user-role context
  // block. Moving it into the leading system prompt would invalidate the
  // cached prefix every time the loadout or action count changes.
  return { ...body, messages: [...body.messages, { role: 'user', content: '<tinygpt-tool-state>\nHost context for the existing task, not a new user request.\n' + content + '\n</tinygpt-tool-state>' }] };
}

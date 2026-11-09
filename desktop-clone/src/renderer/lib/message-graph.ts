type MessageLink = { id: string; parentId?: string | null };

/** Keep UI-only filtering out of the saved message graph. */
export function visibleMessageGraph(source: readonly MessageLink[], visibleIds: readonly string[], headId: string | null) {
  const parents = new Map(source.map((message, index) => [message.id, message.parentId === undefined ? source[index - 1]?.id ?? null : message.parentId]));
  const visible = new Set(visibleIds);
  function ancestor(id: string | null, child?: string): string | null {
    const seen = new Set(child ? [child] : []);
    while (id && !seen.has(id)) {
      seen.add(id);
      if (visible.has(id)) return id;
      id = parents.get(id) ?? null;
    }
    return null;
  }
  return { headId: ancestor(headId), parents: new Map(visibleIds.map(id => [id, ancestor(parents.get(id) ?? null, id)])) };
}

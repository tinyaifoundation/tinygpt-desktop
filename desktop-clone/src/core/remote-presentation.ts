import type { ToolActivity } from '../shared/tools';
import { restoreSavedChatUI } from '../shared/generative-ui';

/** Display data only. This never returns an arbitrary tool result. */
export function remotePresentation(tool: ToolActivity | undefined, conversationId: string) {
  if (!tool || tool.conversationId !== conversationId || tool.name !== 'present' || !['running', 'success'].includes(tool.status)) throw Error('This interface is unavailable.');
  try { return restoreSavedChatUI(JSON.parse(tool.result ?? '').ui); }
  catch { throw Error('This interface could not be displayed.'); }
}

// An invalidation token, not an authorization token. UI payloads are fetched
// individually so even a reply with many visuals fits the encrypted snapshot.
const versions = new Map<string,{text:string;version:string}>();
export function presentationVersion(text: string, id?: string) {
  const saved = id ? versions.get(id) : undefined;
  if (saved?.text === text) return saved.version;
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  const version = (hash >>> 0).toString(16) + '-' + text.length;
  if (id) { versions.set(id,{text,version}); if (versions.size > 128) versions.delete(versions.keys().next().value!); }
  return version;
}

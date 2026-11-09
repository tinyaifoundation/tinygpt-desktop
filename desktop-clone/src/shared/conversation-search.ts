import type { ConversationSummary } from './chat';

export function matchesConversation(chat: ConversationSummary, query: string, projectName = ''): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || `${chat.title} ${chat.summary ?? ''} ${projectName}`.toLocaleLowerCase().includes(needle);
}

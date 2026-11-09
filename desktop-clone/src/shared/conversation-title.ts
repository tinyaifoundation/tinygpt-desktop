/** Sentence case for automatic titles, preserving names, acronyms and language. */
export function capitalizeConversationTitle(title: string): string {
  return title.replace(/\p{L}/u, letter => letter.toLocaleUpperCase());
}

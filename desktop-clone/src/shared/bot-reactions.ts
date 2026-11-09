import { z } from 'zod';
export const botReactionEmojis = ['❤️', '👍', '👎', '😂', '‼️', '❓', '🫶'] as const;
export const botReactionEmojiSchema = z.enum(botReactionEmojis);
export interface MessageReaction { actor: 'user' | 'bot'; emoji: typeof botReactionEmojis[number]; createdAt: number }
export const botReactionSchema = z.object({ conversationId: z.uuid(), messageId: z.uuid(), emoji: botReactionEmojiSchema.nullable() }).strict();
export const botReactionTool = { name: 'react_to_message', description: 'React to a user message with an emoji when it is natural and useful, like texting. Optional; do not react to every message or substitute a reaction for an answer. Use only a user message ID supplied by TinyGPT.', schema: { type: 'object', properties: { messageId: { type: 'string', description: 'The TinyGPT user message ID' }, emoji: { type: 'string', enum: [...botReactionEmojis] } }, required: ['messageId', 'emoji'], additionalProperties: false } };

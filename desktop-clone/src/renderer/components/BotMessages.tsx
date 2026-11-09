import { useContext, useState } from 'react';
import { MessagePrimitive, useAuiState } from '@assistant-ui/react';
import { HandHeart, SmilePlus } from '../icons';
import { ConversationActions, type MessageDetails } from './ConversationMessages';
import { MarkdownText } from './AnswerMarkdown';
import { TypingIndicator } from './ConversationElements';
import { PluginConnectionCards } from './PluginConnectionCards';
import { SkillDraftCards } from './SkillDraftCards';
import { CreatedFileCards } from './CreatedFileCards';
import { GeneratedImages } from './GeneratedImages';
import { MessageNotice } from './elements/error-state';
import { MessageCitations } from './MessageCitations';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { ControlTooltip } from './ui/tooltip';
import { OUTPUT_LIMIT_MESSAGE, TOOL_OUTPUT_LIMIT_MESSAGE, TOOL_LOOP_MESSAGE } from '../../shared/chat';
import { botReactionEmojis } from '../../shared/bot-reactions';
const contentComponents = { Text: MarkdownText, Reasoning: () => null };
function ReactionEmoji({ emoji }: { emoji: string }) { return emoji === '🫶' ? <HandHeart aria-hidden="true" size={19} strokeWidth={1.8} className="bot-reaction-hand" /> : <>{emoji}</>; }
function BotMessage({ user }: { user: boolean }) {
  const message = useAuiState(s => s.message);
  const last = useAuiState(s => s.message.isLast);
  const actions = useContext(ConversationActions);
  const storedDetails = message.metadata.custom.desktop as MessageDetails | undefined;
  const details: MessageDetails = storedDetails ?? { status: message.status?.type === 'running' ? 'streaming' : 'complete', error: null, day: null, sources: [], tools: [] };
  const [reactionsOpen, setReactionsOpen] = useState(false);
  const running = message.status?.type === 'running';
  const hasText = (user || !running) && !details.unclassifiedText && message.content.some(part => part.type === 'text' && part.text.trim());
  const reaction = details.reactions?.find(item => item.actor === 'user');
  const notice = details.error === OUTPUT_LIMIT_MESSAGE ? 'This reply reached the model’s output limit. Your partial message is saved. Send a message to continue, or increase the output limit in Settings.' : details.error === TOOL_OUTPUT_LIMIT_MESSAGE ? 'The model reached its output limit while preparing an action. The incomplete action was not run. Ask for a smaller task, or increase the output limit in Settings.' : details.error === TOOL_LOOP_MESSAGE ? 'The task stopped after the same action kept failing. Completed work is saved. Send a message to try another approach.' : details.error;
  const time = message.createdAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const citations = { sources: details.citations ?? [], openSource: (source: NonNullable<MessageDetails['citations']>[number]) => source.url ? actions.openWeb(source.url) : source.sourceId ? actions.openSource(source.sourceId) : undefined };
  return <MessageCitations.Provider value={citations}><MessagePrimitive.Root data-message-id={message.id} className={'bot-message ' + (user ? 'bot-message-outgoing' : 'bot-message-incoming')}>
    {details.day && <div className="bot-message-day">{details.day}</div>}
    <div className="bot-message-body">
      {user && !!details.sources.length && <div className="bot-message-attachments">{details.sources.map(source => <button key={source.id} type="button" onClick={() => actions.openSource(source.id)}>{source.title}</button>)}</div>}
      {hasText && <div className="bot-bubble-wrap"><div data-slot={user ? 'user-bubble' : 'answer-text'} className="bot-message-bubble"><MessagePrimitive.Content components={contentComponents} /></div>
        {!!details.reactions?.length && <div className="bot-message-reactions" aria-label="Message reactions">{details.reactions.map(item => <button type="button" key={item.actor} aria-label={(item.actor === 'bot' ? 'Bot reacted ' : 'Your reaction ') + item.emoji} title={item.actor === 'bot' ? 'Bot reaction' : 'Remove your reaction'} disabled={item.actor === 'bot'} onClick={() => actions.react(message.id, null)}><ReactionEmoji emoji={item.emoji} /></button>)}</div>}
        {storedDetails && !running && <Popover open={reactionsOpen} onOpenChange={setReactionsOpen}><ControlTooltip label="React to message"><PopoverTrigger asChild><button type="button" className="bot-message-react" aria-label="React to message"><SmilePlus size={16} /></button></PopoverTrigger></ControlTooltip><PopoverContent className="bot-reaction-picker" side="top" align={user ? 'end' : 'start'} aria-label="Choose a reaction">{botReactionEmojis.map(emoji => <button key={emoji} type="button" aria-label={'React ' + emoji} aria-pressed={reaction?.emoji === emoji} onClick={() => { actions.react(message.id, reaction?.emoji === emoji ? null : emoji); setReactionsOpen(false); }}><ReactionEmoji emoji={emoji} /></button>)}</PopoverContent></Popover>}
      </div>}
      {!user && running && !hasText && <div data-slot="bot-typing-bubble" className="bot-typing-bubble" role="status" aria-label="Bot is typing"><TypingIndicator /></div>}
      {!user && actions.bridge && <PluginConnectionCards tools={details.tools} bridge={actions.bridge} update={actions.connectionUpdated} disabled={actions.retryDisabled || !last} />}
      {!user && actions.bridge && <SkillDraftCards tools={details.tools} bridge={actions.bridge} />}
      {!user && actions.bridge && <GeneratedImages tools={details.tools} bridge={actions.bridge} open={actions.openSource} />}
      {!user && <CreatedFileCards tools={details.tools} open={actions.openFile} />}
      {!user && details.error && <MessageNotice tone="muted" role="status" title={details.status === 'interrupted' || details.status === 'cancelled' ? 'Reply interrupted' : 'Message could not finish'}><span>{notice}</span></MessageNotice>}
      {!user && !details.error && ['interrupted', 'cancelled'].includes(details.status) && <p className="bot-message-notice">Reply interrupted. Send a message to pick up where we left off.</p>}
      {!running && (hasText || details.error) && <time className="bot-message-time" dateTime={message.createdAt.toISOString()}>{time}</time>}
    </div>
  </MessagePrimitive.Root></MessageCitations.Provider>;
}
export function BotUserMessage() { return <BotMessage user />; }
export function BotAssistantMessage() { return <BotMessage user={false} />; }

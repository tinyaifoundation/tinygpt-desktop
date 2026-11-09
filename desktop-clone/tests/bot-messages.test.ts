import { expect, it } from 'vitest';
import { botDisplayText, botHistoryReplies, botStreamText } from '../src/core/bot-messages';

it('removes Bot routing tags and markup wrappers without losing prose, links or code', () => {
  expect(botDisplayText('[[reply_to_current]] <details><summary>Checking now.</summary></details> [option A] [Docs](https://example.com)')).toBe('Checking now. [option A] [Docs](https://example.com)');
  expect(botDisplayText('Example: `[[reply_to_current]]`\n```html\n<details>Example</details>\n```')).toBe('Example: `[[reply_to_current]]`\n```html\n<details>Example</details>\n```');
  expect(botHistoryReplies([{ role: 'user', content: 'Hello' }, { role: 'assistant', content: '[[reply_to:123]] HEARTBEAT_OK' }])).toEqual([]);
});

it('merges snapshot and delta-only Gateway frames without repeating text', () => {
  let text = botStreamText('', { deltaText: 'Looking', replace: true });
  text = botStreamText(text, { deltaText: ' into it.' });
  expect(text).toBe('Looking into it.');
  expect(botStreamText(text, { message: { content: [{ type: 'text', text }] }, deltaText: text })).toBe(text);
  expect(botStreamText(text, { deltaText: 'The result.', replace: true })).toBe('The result.');
  expect(botStreamText(text, { state: 'final' })).toBe(text);
});

it('keeps native reply boundaries, excludes previous turns, tools, reasoning and silent replies', () => {
  expect(botHistoryReplies([
    { role: 'assistant', content: 'Earlier turn.' }, { role: 'user', content: 'Current turn.' },
    { role: 'assistant', content: [{ type: 'text', text: 'I’ll check.' }, { type: 'toolCall', name: 'read' }] },
    { role: 'toolResult', content: 'Private result.' }, { role: 'assistant', isReasoning: true, content: 'Thinking.' },
    { role: 'assistant', content: 'Here’s what I found.' }, { role: 'assistant', content: 'NO_REPLY' },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'Hidden.' }] },
  ])).toEqual(['I’ll check.', 'Here’s what I found.']);
});

import { expect, it } from 'vitest';
import { validateLocalAnswer } from '../src/core/local-answer';
import { MODEL_ANSWER_BOUNDARY_MESSAGE } from '../src/shared/chat';
it.each(['<think>Unfinished notes', 'Working notes.\n</think>\nAnswer', 'Answer\n <think> \nmore notes'])('rejects misplaced structural thinking markers (%s)', text => {
  expect(() => validateLocalAnswer(text)).toThrow(MODEL_ANSWER_BOUNDARY_MESSAGE);
});
it.each(['Your highest priority is the invoice.', 'The literal `</think>` tag closes the block.', 'Example:\n```xml\n<think>\nexample\n</think>\n```\nExplanation.'])('keeps ordinary answers and quoted code unchanged (%s)', text => expect(validateLocalAnswer(text)).toBe(text));

import { describe, expect, it } from 'vitest';
import { answerUrlTransform, savedAnswerImage } from '../src/core/answer-images';
import { HistoryStore } from '../src/main/history';
const id = 'cb921947-1f48-4a5a-abbf-121afe65ecc0';
const png = 'data:image/png;base64,iVBORw0KGgo=';
describe('Answer images', () => {
  it('retains saved screenshot references for the image renderer without converting them into links', () => {
    expect(savedAnswerImage('tinygpt-image:' + id)).toBe(id);
    expect(answerUrlTransform('tinygpt-image:' + id, 'src')).toBe('tinygpt-image:' + id);
    expect(answerUrlTransform('tinygpt-image:' + id, 'href')).toBe('');
    expect(savedAnswerImage('tinygpt-image:missing')).toBe(null);
    expect(answerUrlTransform('tinygpt-source:' + id, 'href')).toBe('tinygpt-source:' + id);
  });
  it('supports web photos and raster image payloads while rejecting executable and arbitrary local references', () => {
    for (const url of ['https://example.com/photo.png', 'http://localhost/photo.png', png]) expect(answerUrlTransform(url, 'src')).toBe(url);
    // secretlint-disable-next-line @secretlint/secretlint-rule-basicauth -- Synthetic credential-bearing URL rejection fixture; no real credentials.
    for (const url of ['javascript:alert(1)', 'file:///C:/private/image.png', 'tinygpt-image:../../private', 'data:image/svg+xml;base64,PHN2Zz4=', 'https://user:secret@example.com/photo.png', '../private.png', 'blob:https://example.org/123']) expect(answerUrlTransform(url, 'src')).toBe('');
    expect(answerUrlTransform(png, 'href')).toBe('');
  });
  it('resolves screenshots through the existing conversation ownership boundary', () => {
    const history = new HistoryStore(':memory:');
    try {
      const conversation = history.createConversation(null);
      const other = history.createConversation(null);
      const screenshot = history.sources.add(conversation.id, { kind: 'project-file', title: 'Browser screenshot', text: 'Screenshot', mime: 'image/png', image: png });
      expect(history.sources.detail(conversation.id, screenshot.id).image).toBe(png);
      expect(() => history.sources.detail(other.id, screenshot.id)).toThrow('Source not found');
      history.sources.add(conversation.id, { kind: 'project-file', title: 'Report', url: 'project-file:report.md', text: 'Stale report' });
      history.sources.removeConversationFiles(conversation.id);
      expect(history.sources.detail(conversation.id, screenshot.id).image).toBe(png);
      expect(history.sources.list(conversation.id)).toHaveLength(1);
    } finally { history.close(); }
  });
  it('preserves saved image pixels when Project file references are refreshed', () => {
    const history = new HistoryStore(':memory:');
    try {
      const project = history.createProject('Fixture', '');
      const conversation = history.createConversation(project.id);
      const screenshot = history.sources.add(conversation.id, { kind: 'project-file', title: 'Browser screenshot', text: 'Screenshot', image: png });
      history.sources.add(conversation.id, { kind: 'project-file', title: 'Report', url: 'project-file:report.md', text: 'Stale report' });
      history.sources.removeProjectFiles(project.id);
      expect(history.sources.detail(conversation.id, screenshot.id).image).toBe(png);
      expect(history.sources.list(conversation.id)).toHaveLength(1);
    } finally { history.close(); }
  });
});
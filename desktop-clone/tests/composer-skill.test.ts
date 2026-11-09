import { describe, expect, it } from 'vitest';
import { composerSkillPrefix, removeComposerSkill } from '../src/renderer/lib/composer-skill';

describe('editable skill commands', () => {
  it('identifies only the leading command and keeps full IDs for duplicate skill names', () => {
    expect(composerSkillPrefix('/skill brief Draft the update')).toEqual({ token: 'brief', end: 12, bodyStart: 13 });
    expect(composerSkillPrefix('/skill plugin-id/brief Draft the update')?.token).toBe('plugin-id/brief');
    expect(composerSkillPrefix('/skill brief\nDraft the update')?.bodyStart).toBe(12);
    expect(composerSkillPrefix('Explain /skill brief')).toBeUndefined();
    expect(composerSkillPrefix('/skill ')).toBeUndefined();
  });
  it('removes a whole command at its boundary while preserving the remaining prompt', () => {
    expect(removeComposerSkill('/skill brief Draft the update', 'Backspace', 13, 13)).toEqual({ text: 'Draft the update', caret: 0 });
    expect(removeComposerSkill('/skill brief Draft the update', 'Backspace', 8, 8)?.text).toBe('Draft the update');
    expect(removeComposerSkill('/skill brief ', 'Backspace', 13, 13)?.text).toBe('');
    expect(removeComposerSkill('/skill brief Draft the update', 'Delete', 0, 0)?.text).toBe('Draft the update');
  });
  it('preserves ordinary editing, multiline drafts, and selection deletion', () => {
    const text = '/skill brief First line\nSecond line';
    expect(removeComposerSkill(text, 'Backspace', text.length, text.length)).toBeUndefined();
    expect(removeComposerSkill(text, 'Backspace', 0, 0)).toBeUndefined();
    expect(removeComposerSkill(text, 'Backspace', 0, 18)?.text).toBe(' line\nSecond line');
    expect(removeComposerSkill(text, 'Delete', 13, 13)).toBeUndefined();
    expect(removeComposerSkill(text, 'Enter', 12, 12)).toBeUndefined();
  });
});

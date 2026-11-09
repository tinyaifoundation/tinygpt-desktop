import { describe, expect, it } from 'vitest';
import { defaultSettings, defaultToolPermissions } from '../src/shared/config';
import { inferenceIssue, toolDecision } from '../src/core/readiness';

describe('readiness and user approval rules', () => {
  it('does not require a key for local inference', () => {
    expect(inferenceIssue({ ...defaultSettings, local: { ...defaultSettings.local, model: 'local' } }, { portal: false, byok: false, local: false })).toBeNull();
  });
  it('keeps Portal unavailable until its wallet service exists', () => {
    expect(inferenceIssue({ ...defaultSettings, route: 'portal' }, { portal: true, byok: false, local: false })).toContain('credit wallet');
  });
  it('uses the user’s automatic approval preference inside an authorized workspace', () => {
    expect(toolDecision({ operation: 'execute', insideWorkspace: true }, { ...defaultToolPermissions, execute: 'allow' })).toBe('allow');
  });
  it('respects a user’s denied category', () => {
    expect(toolDecision({ operation: 'read', insideWorkspace: true }, { ...defaultToolPermissions, read: 'deny' })).toBe('deny');
  });
  it('requires a workspace grant beyond automatic tool approval', () => {
    expect(toolDecision({ operation: 'write', insideWorkspace: false }, { ...defaultToolPermissions, write: 'allow' })).toBe('ask');
  });
  it('asks before commands by default', () => {
    expect(toolDecision({ operation: 'execute', insideWorkspace: true })).toBe('ask');
  });
});

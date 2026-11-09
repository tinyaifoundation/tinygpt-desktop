import { expect, it } from 'vitest';
import { groundPiServiceTools } from '../src/core/pi-service-grounding';

const available = [{name:'search_mail',label:'Search Gmail'},{name:'send_mail',label:'Send Gmail'}];
it('grounds only callable schemas without rewriting saved messages or forcing an action', () => {
  const messages = [{role:'system',content:'Stable assistant instructions.'},{role:'assistant',content:'I cannot access Gmail.'},{role:'user',content:'Check my inbox.'}];
  const body = {messages,tools:[{type:'function',function:{name:'search_mail'}}]};
  const result = groundPiServiceTools(body,available,0);
  expect(messages).toHaveLength(3);
  expect((result.messages as any[]).slice(0,3)).toEqual(messages);
  const note = (result.messages as any[]).at(-1);
  expect(note.role).toBe('user');
  expect(note.content).toContain('<tinygpt-tool-state>');
  expect((result.messages as any[]).slice(1).some(message=>message.role==='system'||message.role==='developer')).toBe(false);
  const afterAction=groundPiServiceTools(body,available,1);
  expect((afterAction.messages as any[]).slice(0,3)).toEqual(messages);
  expect(note.content).toContain('search_mail (Search Gmail)');
  expect(note.content).not.toContain('send_mail');
  expect(note.content).toContain('Perform only the actions the user requested');
  expect(result).not.toHaveProperty('tool_choice');
});
it('does not add capability claims to compaction requests or unavailable services', () => {
  for (const body of [{messages:[]},{messages:[],tools:[]},{messages:[],tools:[{function:{name:'other'}}]}]) {
    expect(groundPiServiceTools(body,available,0)).toBe(body);
  }
});
it('continues from actual results and errors after an action', () => {
  const result = groundPiServiceTools({messages:[],tools:[{function:{name:'search_mail'}}]},available,1);
  const note = (result.messages as any[]).at(-1).content;
  expect(note).toContain('Continue from its actual results or errors');
  expect(note).toContain('actual tool result is authoritative');
  expect(note).not.toContain('No service action has been attempted');
});

import { it,expect } from 'vitest';
import { parseScheduleSuggestions } from '../src/core/scheduled-suggestions';
import { structuredMetadataFetch } from '../src/core/structured-metadata';
import type { ChatWorkerInput } from '../src/shared/chat';

const first = { title: 'Inbox briefing',description: 'Find messages worth reading.',prompt: 'Review recent inbox messages and summarize priorities.',emoji: '📬',repeat: 'daily' };
const second = { ...first,title: 'Weekly planning',repeat: 'weekly' };
it('accepts schema output and legacy arrays with code fences', () => {
  expect(parseScheduleSuggestions(JSON.stringify({ suggestions: [first] }))).toEqual([first]);
  expect(parseScheduleSuggestions('```json\n'+JSON.stringify([first])+'\n```')).toEqual([first]);
});
it('recovers the local-model nested array and routing suffix regression', () => {
  const malformed = '[['+JSON.stringify(first)+'], '+JSON.stringify(second)+']]]></param>';
  expect(parseScheduleSuggestions(malformed)).toEqual([first,second]);
});
it('handles quoted braces and discards invalid entries instead of inventing tasks', () => {
  const quoted = { ...first,prompt: 'Research the string "{example}" and summarize it.' };
  expect(parseScheduleSuggestions(JSON.stringify([quoted])+' trailing text')).toEqual([quoted]);
  expect(() => parseScheduleSuggestions('Nothing useful. {"title":"incomplete"}')).toThrow('usable');
});
it('requests schema-constrained decoding only for opted-in local metadata', async () => {
  const bodies: any[] = [], request = (async (_resource,options) => { bodies.push(JSON.parse(String(options?.body))); return new Response('{}'); }) as typeof fetch;
  const input: ChatWorkerInput = { runId:'test',route:'local',provider:'local',protocol:'openai-compatible',model:'fixture',endpoint:'http://127.0.0.1:1/v1',instructions:'',messages:[],purpose:'metadata',outputSchema:{type:'object'} };
  await structuredMetadataFetch(request,input)('http://127.0.0.1:1/v1/chat/completions',{ body:'{"model":"fixture"}' });
  expect(bodies[0].response_format.json_schema.schema).toEqual({type:'object'});
  await structuredMetadataFetch(request,{...input,purpose:undefined})('http://127.0.0.1:1/v1/chat/completions',{body:'{}'}); expect(bodies[1].response_format).toBeUndefined();
});

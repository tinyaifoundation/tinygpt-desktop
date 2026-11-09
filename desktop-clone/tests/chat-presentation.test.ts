import { expect, it } from 'vitest';
import { chatPresentation } from '../src/core/chat-presentation';
import type { ActiveRun, ChatMessage } from '../src/shared/chat';
const message={text:'',runId:'run',status:'streaming'} as ChatMessage;
const active={conversationId:'chat',runId:'run',phase:'prose',textLane:'progress',prose:'First progress.'} as ActiveRun;
it('replaces the sole progress slot and keeps it out of the answer lane',()=>{
  expect(chatPresentation(message,active)).toEqual({progress:'First progress.',answerStarted:false});
  expect(chatPresentation(message,{...active,prose:'Second progress.'}).progress).toBe('Second progress.');
  expect(chatPresentation(message,{...active,prose:''}).progress).toBe('');
  expect(chatPresentation(message,{...active,phase:'tool'}).progress).toBe('First progress.');
});
it('hides progress at an answer boundary before its first token, then streams answer text',()=>{
  expect(chatPresentation(message,{...active,phase:'answer',textLane:'answer'})).toEqual({progress:'',answerStarted:false});
  expect(chatPresentation({...message,text:'Final first token'},{...active,phase:'answer',textLane:'answer',hasVisibleAnswer:true})).toEqual({progress:'',answerStarted:true});
});
it('uses only the newest undecided text for legacy streams and never repeats a continued answer',()=>{
  const undecided={...active,prose:undefined,textLane:'unclassified' as const};
  expect(chatPresentation({...message,text:'Newest candidate'},undecided).progress).toBe('Newest candidate');
  expect(chatPresentation({...message,text:'Earlier answer.New progress'},undecided,'Earlier answer.').progress).toBe('New progress');
  expect(chatPresentation({...message,text:'Stale candidate'},{...undecided,prose:''}).progress).toBe('');
});
it('does not restore progress after completion, cancellation, reload or a different run',()=>{
  for(const status of ['complete','cancelled','error','interrupted'] as const)expect(chatPresentation({...message,status,text:'Saved answer'},active).progress).toBe('');
  expect(chatPresentation(message,{...active,runId:'another'}).progress).toBe('');
  expect(chatPresentation(message).progress).toBe('');
});
it('hides stale prose for visual-only answers and an answer already announced during a tool phase',()=>{
  expect(chatPresentation(message,active,'',true)).toEqual({progress:'',answerStarted:true});
  expect(chatPresentation(message,{...active,phase:'tool',hasVisibleAnswer:true}).progress).toBe('');
});

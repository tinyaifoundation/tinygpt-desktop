import {it,expect} from 'vitest';
import {AssistantStateTools,assistantRestoredGroup} from '../src/core/assistant-state-tools';

const content=(value:unknown)=>[{type:'text',text:JSON.stringify(value)}];
it('withdraws a repeated no-op write by saved identity even with alternating titles and arguments',()=>{
  const state=new AssistantStateTools();
  expect(state.record('watch',{title:'One'},content({id:'a',watching:true}))).toBe(false);
  expect(state.record('watch',{title:'One'},content({id:'a',unchanged:true}))).toBe(false);
  expect(state.record('watch',{title:'Two'},content({id:'b',unchanged:true}))).toBe(false);
  expect(state.record('watch',{id:'a',title:'New alias'},content({id:'a',unchanged:true}))).toBe(true);
  expect(state.has('watch')).toBe(true);expect(state.has('remember')).toBe(false);
  expect(new AssistantStateTools().has('watch')).toBe(false);
});
it('allows productive writes and reads rather than imposing a task or polling limit',()=>{
  const state=new AssistantStateTools();
  for(let i=0;i<100;i++){
    expect(state.record('watch',{},content({id:String(i),unchanged:true}))).toBe(false);
    expect(state.record('read',{},content({text:'same observation'}))).toBe(false);
    expect(state.record('watch',{},content({id:'updated',unchanged:true}))).toBe(false);
    expect(state.record('watch',{},content({id:'updated',nextRunAt:i}))).toBe(false);
  }
});

const call=(id:string,group:string)=>({role:'assistant',content:[{type:'toolCall',name:'load_tools',id,arguments:{group}}]});
const result=(id:string,data:unknown,isError=false)=>({role:'toolResult',toolName:'load_tools',toolCallId:id,isError,content:content(data)});
it('restores only a successful host group from native history, never a stale service grant or failed discovery',()=>{
  expect(assistantRestoredGroup([call('b','browser'),result('b',{tools:['browser_click']})])).toBe('browser');
  expect(assistantRestoredGroup([call('b','browser'),result('b',{error:'denied'},true)])).toBeUndefined();
  expect(assistantRestoredGroup([call('b','browser'),result('b',{tools:['browser_click']}),call('s','services'),result('s',{enabled:'services',toolNames:['old_mail']})])).toBeUndefined();
  expect(assistantRestoredGroup([call('b','browser'),result('b',{tools:['browser_click']}),call('s','services'),result('s',{error:'unavailable'},true)])).toBe('browser');
  expect(assistantRestoredGroup([call('j','jobs'),result('j',{tools:['command_stop']})])).toBeUndefined();
});

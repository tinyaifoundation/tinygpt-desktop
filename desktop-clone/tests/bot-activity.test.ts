import {it,expect} from 'vitest';
import {botActivity} from '../src/core/bot-activity';
import type {Conversation} from '../src/shared/chat';
it('groups browser steps into their requested task and preserves message links',()=>{
  const conversation={messages:[{id:'u',role:'user',text:'Check my repository notifications.',createdAt:1},{id:'a',parentId:'u',role:'assistant',runId:'run',text:'I will check.',status:'complete',createdAt:2},{id:'b',parentId:'a',role:'assistant',runId:'run',text:'Here are the findings.',status:'complete',createdAt:4}],tools:[{id:'t1',runId:'run',name:'browser_open',status:'success',createdAt:2},{id:'t2',runId:'run',name:'browser_snapshot',status:'success',createdAt:3}]} as Conversation;
  expect(botActivity(conversation)).toMatchObject([{id:'run',title:'Check my repository notifications.',detail:'Reply ready · 2 tool steps',messageId:'b',browser:true}]);
  conversation.messages.push({id:'proactive',role:'assistant',parentId:'b',runId:'watch',text:'A useful watch update.',createdAt:6,status:'complete',error:null,route:'local'});
  expect(botActivity(conversation)[0]).toMatchObject({id:'watch',title:'A useful watch update.'});
});
it('includes proactive updates, limits recent tasks and avoids claiming a failed task is complete',()=>{
  const conversation={messages:Array.from({length:8},(_,i)=>({id:'a'+i,role:'assistant',runId:'r'+i,text:'A useful update '+i,createdAt:i,status:i===7?'error':'complete'})),tools:[]} as unknown as Conversation;
  const activity=botActivity(conversation);expect(activity).toHaveLength(5);expect(activity[0]).toMatchObject({id:'r7',detail:'Needs attention',title:'A useful update 7'});
});

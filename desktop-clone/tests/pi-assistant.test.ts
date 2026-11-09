import { it, expect, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createPiAssistant } from '../src/main/pi-assistant';
import { focusedPluginToolQuery } from '../src/core/plugin-tool-query';
import type { ExtensionToolDefinition } from '../src/shared/plugins';
import type { ChatWorkerInput, ResponseEvent } from '../src/shared/chat';

it('runs the real Pi SDK, remembers tool history after reopening and suppresses quiet checks', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-05T15:00:00Z'));
  const directory = await mkdtemp(join(tmpdir(),'tinygpt-pi-assistant-proof-'));
  let calls = 0, mode = 'remember'; const requests: any[] = [];
  const server = createServer(async (request,response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); requests.push(body); calls++;
    if (calls === 1) vi.setSystemTime(new Date('2026-11-05T15:02:00Z'));
    const delta = mode === 'remember' && calls === 1 ? { role: 'assistant',tool_calls: [{ index: 0,id: 'remember-one',type: 'function',function: { name: 'remember_fixture',arguments: JSON.stringify({ text: 'The user likes hiking.' }) } }] } : { role: 'assistant',content: mode === 'quiet' ? 'NO_REPLY' : 'I remember your hiking plans.' };
    const chunk = (value: unknown,reason: string | null) => ({ id: 'fixture',object: 'chat.completion.chunk',created: 1,model: 'fixture',choices: [{ index: 0,delta: value,finish_reason: reason }],usage: { prompt_tokens: 150,completion_tokens: 25,total_tokens: 175 } });
    response.writeHead(200,{ 'content-type': 'text/event-stream' }).end(`data: ${JSON.stringify(chunk(delta,null))}\n\ndata: ${JSON.stringify(chunk({},'tool_calls' in delta ? 'tool_calls' : 'stop'))}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  let memory = ''; const events: ResponseEvent[] = [];
  const input: ChatWorkerInput = { runId: 'one',conversationId: 'fixture',replyMessageId: 'first',route: 'local',endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,model: 'fixture',provider: 'local',protocol: 'openai-compatible',tools: true,instructions: 'Be helpful.',messages: [{ role: 'user',text: 'Remember my hiking plans.' }],contextWindowTokens: 16000,maxOutputTokens: 1024 };
  const make = (background = false) => createPiAssistant(async () => ({ root: directory,background,instructions: 'You are Milo, a personal assistant.',allow: () => false,customTools: [{ name: 'remember_fixture',label: 'Remember',description: 'Remember a preference',parameters: { type: 'object',properties: { text: { type: 'string' } },required: ['text'] } as any,execute: async (_id,args: any) => { memory = args.text; return { content: [{ type: 'text',text: 'Stored preference: HIKING_HISTORY_SENTINEL' }],details: undefined }; } }] }));
  try {
    await make().run(input,new AbortController().signal,() => {},async () => '{}',undefined,event => events.push(event));
    expect(memory).toBe('The user likes hiking.'); expect(events.at(-2)).toMatchObject({ type: 'bot-messages',complete: true,messages: ['I remember your hiking plans.'] });
    expect(requests[0].tools.map((tool: any) => tool.function.name)).toEqual(['remember_fixture']);
    expect(JSON.stringify(requests[0])).toContain('You are Milo'); expect(JSON.stringify(requests[0])).not.toContain('You are an expert coding assistant');
    expect(JSON.stringify(requests[0])).toContain('assistant inside TinyGPT Desktop');
    expect(JSON.stringify(requests[0])).toContain('Reply start local date/time:');
    const clockNote = (body: any) => body.messages.find((message: any) => message.role === 'system').content.match(/<tinygpt-runtime-context>[\s\S]*?<\/tinygpt-runtime-context>/)?.[0];
    expect(requests.length).toBeGreaterThanOrEqual(2);
    expect(clockNote(requests[1])).toBe(clockNote(requests[0]));
    mode = 'followup';
    await make().run({ ...input,runId: 'two',replyMessageId: 'second',messages: [...input.messages,{ id: 'first',role: 'assistant',text: 'I remember your hiking plans.' },{ role: 'user',text: 'What do you remember?' }] },new AbortController().signal,() => {},async () => '{}');
    expect(JSON.stringify(requests.at(-1))).toContain('HIKING_HISTORY_SENTINEL');
    expect(clockNote(requests.at(-1))).not.toBe(clockNote(requests[0]));
    mode = 'quiet'; const quiet = { ...input,runId: 'three',replyMessageId: 'quiet' }; const quietEvents: ResponseEvent[] = [];
    await make(true).run(quiet,new AbortController().signal,() => {},async () => '{}',undefined,event => quietEvents.push(event));
    expect(quiet.nativeSilent).toBe(true); expect(quietEvents.some(event => event.type === 'bot-messages')).toBe(false);
    expect(JSON.stringify(requests.at(-1))).toContain('Reply start local date/time:');
  } finally {
    vi.useRealTimers();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    const target = resolve(directory); if (dirname(target).toLowerCase() !== resolve(tmpdir()).toLowerCase() || !basename(target).startsWith('tinygpt-pi-assistant-proof-')) throw Error('Unexpected fixture directory'); await rm(target,{ recursive: true,force: true });
  }
},45000);

it.each([{prompt:'Check my email.',preloaded:true,query:'gmail check email inbox'},{prompt:'Can you triage my gmail for emails I got today?',preloaded:true,query:'Gmail search tool action'},{prompt:'Discover what services are available.',preloaded:false,query:'Gmail search tool action'}])('loads and executes a plugin with short names: $prompt', async ({prompt,preloaded,query}) => {
  const directory = await mkdtemp(join(tmpdir(),'tinygpt-pi-assistant-proof-')), bodies: any[] = [], names: string[] = [];
  const name = 'ext_search_mail_fixture';
  const extensionTools: ExtensionToolDefinition[] = [{name,originalName:'search_mail',pluginId:'fixture',label:'Search Gmail',description:'Search Gmail messages.',category:'read',schema:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}}];
  const server = createServer(async (request,response) => {
    let raw=''; for await (const part of request) raw+=part; const body=JSON.parse(raw); bodies.push(body);
    // Reproduce the strict local-model template that rejected the live Bot run.
    if(body.messages.slice(1).some((message:any)=>['system','developer'].includes(message.role))){response.writeHead(500,{'content-type':'application/json'}).end(JSON.stringify({error:{message:'System message must be at the beginning.'}}));return;}
    const tool = bodies.length === 1 ? { name:'load_tools',arguments:JSON.stringify({group:'services',query}) } : bodies.length === 2 ? {name:'search_mail',arguments:JSON.stringify({query:'in:inbox newer_than:1d'})} : undefined;
    const delta=tool?{role:'assistant',tool_calls:[{index:0,id:'call-'+bodies.length,type:'function',function:tool}]}:{role:'assistant',content:'One message needs your attention.'};
    response.writeHead(200,{'content-type':'text/event-stream'}).end(`data: ${JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}})}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const execution=createPiAssistant(async()=>({root:directory,instructions:'Discover Gmail, load its exact action, then use it.',allow:()=>true}));
    await execution.run({runId:'plugin-proof',conversationId:'fixture',route:'local',provider:'local',protocol:'openai-compatible',endpoint:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture',contextWindowTokens:16000,maxOutputTokens:1024,instructions:'',tools:true,messages:[{role:'user',text:prompt}],extensionTools},new AbortController().signal,()=>{},async request=>{names.push(request.name);return request.name==='load_tools'?JSON.stringify({enabled:'services',status:'loaded',toolNames:focusedPluginToolQuery(extensionTools,String((request.input as any).query),['Gmail']).map(tool=>tool.name)}):JSON.stringify({messages:[{subject:'Synthetic reminder'}]});});
    expect(names).toEqual(['load_tools',name]); expect(bodies[0].tools.some((tool:any)=>tool.function.name==='search_mail')).toBe(preloaded); if(preloaded)expect(bodies[0].tools.some((tool:any)=>tool.function.name==='run_command')).toBe(false); expect(bodies[1].tools.some((tool:any)=>tool.function.name==='search_mail')).toBe(true);expect(bodies[1].tools.some((tool:any)=>tool.function.name==='run_command')).toBe(false);
    expect(bodies[1].messages.at(-1)).toMatchObject({role:'user',content:expect.stringContaining('search_mail (Search Gmail)')});
    for(const body of bodies)expect(body.messages.filter((message:any)=>['system','developer'].includes(message.role))).toHaveLength(1);
    expect(bodies[2].messages.at(-1).content).toContain('Continue from its actual results or errors');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); const target=resolve(directory);if(dirname(target).toLowerCase()!==resolve(tmpdir()).toLowerCase()||!basename(target).startsWith('tinygpt-pi-assistant-proof-'))throw Error('Unexpected fixture directory');await rm(target,{recursive:true,force:true}); }
},45000);

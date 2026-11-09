import { describe, it, expect, vi } from 'vitest';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { CodeStream, codePrompt, codeProviderPayload } from '../src/core/code-stream';
import { OUTPUT_LIMIT_MESSAGE } from '../src/shared/chat';
import { WorkOutputLimitError } from '../src/core/work-limits';
const message = (id: string, role: 'user'|'assistant', finish?: string) => ({id,role,sessionID:'session',finish} as Message);
const part = (id:string,messageID:string,text:string,type='text') => ({id,messageID,sessionID:'session',type,text} as Part);
describe('OpenCode stream ownership and completion',()=>{
  it('refuses to complete an unfinished native command or an intermediate tool-call step',()=>{
    const stream=new CodeStream('session',vi.fn(),vi.fn());stream.message(message('a','assistant','tool-calls'));
    stream.part({id:'t',messageID:'a',sessionID:'session',type:'tool',callID:'call',tool:'bash',state:{status:'running',input:{},time:{start:0},metadata:{output:'still working'}}} as Part);
    expect(stream.hasRunningTools()).toBe(true);expect(()=>stream.assertFinished()).toThrow('runtime');
    stream.part({id:'t',messageID:'a',sessionID:'session',type:'tool',callID:'call',tool:'bash',state:{status:'completed',input:{},title:'Command',metadata:{},time:{start:0,end:1},output:'done'}} as Part);
    expect(stream.hasRunningTools()).toBe(false);expect(()=>stream.assertFinished()).toThrow('runtime');stream.message(message('final','assistant','stop'));stream.assertFinished();
  });
  it('exposes native running output separately from once-only completed tools',()=>{
    const progress=vi.fn(),done=vi.fn();const stream=new CodeStream('session',vi.fn(),vi.fn(),done,progress);stream.message(message('a','assistant'));
    stream.part({id:'t',messageID:'a',sessionID:'session',type:'tool',callID:'call',tool:'bash',state:{status:'running',input:{},time:{start:0},metadata:{output:'first line'}}} as Part);expect(progress).toHaveBeenCalledOnce();expect(done).not.toHaveBeenCalled();
  });
  it('keeps internal compaction checkpoints out of the response',()=>{
    const text=vi.fn();const stream=new CodeStream('session',text,vi.fn());stream.message({...message('summary','assistant','stop'),summary:true} as Message);stream.part(part('checkpoint','summary','Internal checkpoint'));expect(text).not.toHaveBeenCalled();
    stream.message(message('answer','assistant','stop'));stream.part(part('final','answer','Actual answer'));expect(text).toHaveBeenCalledExactlyOnceWith('final','text','Actual answer',undefined);
  });
  it('never emits a saved user message, even if parts arrive before role metadata',()=>{
    const text=vi.fn();const stream=new CodeStream('session',text,vi.fn());
    stream.part(part('u','user','Saved conversation context: USER prompt'));
    stream.part(part('a','assistant','Actual answer'));expect(text).not.toHaveBeenCalled();
    stream.message(message('user','user'));expect(text).not.toHaveBeenCalled();
    stream.message(message('assistant','assistant','stop'));expect(text).toHaveBeenCalledExactlyOnceWith('a','text','Actual answer',undefined);stream.assertFinished();
  });
  it('streams incremental reasoning and reconciles final parts without duplicates',()=>{
    const text=vi.fn();const stream=new CodeStream('session',text,vi.fn());stream.message(message('a','assistant'));
    stream.part(part('p','a','Think','reasoning'));
    stream.event({id:'event',type:'message.part.delta',properties:{sessionID:'session',messageID:'a',partID:'p',field:'text',delta:' more'}});
    stream.part(part('p','a','Think more','reasoning'));
    expect(text.mock.calls).toEqual([['p','reasoning','Think',undefined],['p','reasoning',' more',undefined]]);
  });
  it('preserves native prose part identity and generation time for inline ordering', () => {
    const text = vi.fn(), stream = new CodeStream('session', text, vi.fn());
    stream.message(message('a', 'assistant'));
    stream.part({ ...part('before', 'a', 'Inspecting.'), time: { start: 10 } } as Part);
    stream.part({ ...part('after', 'a', 'Fixed it.'), time: { start: 30 } } as Part);
    expect(text.mock.calls).toEqual([['before', 'text', 'Inspecting.', 10], ['after', 'text', 'Fixed it.', 30]]);
  });
  it('reports reasoning-only output exhaustion as recoverable interruption',()=>{
    const text=vi.fn();const stream=new CodeStream('session',text,vi.fn());stream.message(message('u','user'));stream.part(part('u','u','Do the work'));
    stream.message(message('a','assistant','length'));stream.part(part('p','a','long reasoning','reasoning'));
    expect(()=>stream.assertFinished()).toThrow(OUTPUT_LIMIT_MESSAGE);expect(text.mock.calls.every(call=>call[1]==='reasoning')).toBe(true);
  });
  it('preserves the native session and distinguishes unfinished tool input from thinking and answer exhaustion', () => {
    for (const stage of ['thinking', 'tool-input', 'answer'] as const) {
      const stream = new CodeStream('session', vi.fn(), vi.fn());
      stream.message({ ...message('a', 'assistant', 'length'), tokens: { output: 16384, reasoning: 0 } } as Message);
      stream.part(part('thought', 'a', 'Internal code draft', 'reasoning'));
      if (stage === 'answer') stream.part(part('answer', 'a', 'Partial answer'));
      if (stage === 'tool-input') stream.part({ id: 'tool', messageID: 'a', sessionID: 'session', type: 'tool', callID: 'call', tool: 'write', state: { status: 'pending', input: {}, raw: '{"content":' } } as Part);
      try { stream.assertFinished(); throw Error('Must fail'); } catch (error) {
        expect(error).toBeInstanceOf(WorkOutputLimitError);
        expect((error as WorkOutputLimitError).details).toEqual({ code: 'output-limit', stage, sessionId: 'session', outputTokens: 16384 });
        expect(error).not.toHaveProperty('reasoning');
      }
    }
  });
  it('reports tool preparation once without mistaking an unexecuted pending call for a running action', () => {
    const preparing = vi.fn(), done = vi.fn(), stream = new CodeStream('session', vi.fn(), vi.fn(), done, undefined, undefined, preparing);
    const pending = { id: 'tool', messageID: 'a', sessionID: 'session', type: 'tool', callID: 'call', tool: 'write', state: { status: 'pending', input: {}, raw: '' } } as Part;
    stream.part(pending); expect(preparing).not.toHaveBeenCalled();
    stream.message(message('a', 'assistant')); stream.part(pending);
    expect(preparing).toHaveBeenCalledOnce(); expect(done).not.toHaveBeenCalled();
  });
  it('records late usage once and ignores usage from other sessions',()=>{
    const usage=vi.fn();const stream=new CodeStream('session',vi.fn(),usage);stream.message(message('a','assistant','stop'));
    const finish={id:'f',messageID:'a',sessionID:'session',type:'step-finish',tokens:{input:10,output:2,reasoning:3,cache:{read:4,write:1}}} as Part;
    stream.part({...finish,sessionID:'other'});stream.part(finish);stream.part(finish);expect(usage).toHaveBeenCalledExactlyOnceWith(15,5);
  });
  it('keeps the current request distinct from synthetic historical context',()=>{
    const parts=codePrompt([{role:'user',text:'old'},{role:'assistant',text:'done'},{role:'user',text:'Create TinySkills'}],'checkpoint');
    expect(parts.at(-1)).toEqual({type:'text',text:'Create TinySkills'});expect(parts[0]).toMatchObject({synthetic:true});expect(parts[0].text).toContain('done');
    expect(codePrompt([{role:'user',text:'Create TinySkills'}],'')).toEqual([{type:'text',text:'Create TinySkills'}]);
  });
  it('uses supported low effort for the affected model without overriding explicit choices',()=>{
    expect(codeProviderPayload({},'openrouter','z-ai/glm-5.3-flash')).toEqual({reasoning:{effort:'low'}});
    expect(codeProviderPayload({reasoning:{effort:'high'}},'openrouter','z-ai/glm-5.3-flash')).toEqual({reasoning:{effort:'high'}});
    expect(codeProviderPayload({reasoning:{max_tokens:200}},'openrouter','z-ai/glm-5.3-flash')).toEqual({reasoning:{max_tokens:200}});
    expect(codeProviderPayload({},'local','z-ai/glm-5.3-flash')).toEqual({});
  });
  it('adds optional display metadata without altering native executable arguments',()=>{
    const tools=[{type:'function',function:{name:'edit',parameters:{type:'object',properties:{filePath:{type:'string'}},required:['filePath']}}}];
    const result=codeProviderPayload({tools},'local','fixture');const schema=(result.tools as typeof tools)[0].function.parameters;
    expect(schema.required).toEqual(['filePath']);expect(schema.properties).toHaveProperty('status');expect(schema.properties).toHaveProperty('permission');expect(tools[0].function.parameters.properties).not.toHaveProperty('status');
  });
});

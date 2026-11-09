import {app} from 'electron';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,stat,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {HistoryStore} from '../src/main/history';
import {ProjectFiles} from '../src/main/files';
import {CodeFiles} from '../src/main/code-files';
import {createWorkExecution} from '../src/main/work-execution';
import {LocalPtyHost} from '../src/main/local-pty';
import {workRuntimePaths} from '../src/main/work-runtimes';
import {WORK_RUNTIME_INSTRUCTIONS} from '../src/shared/work-runtimes';
import pins from '../src/shared/work-runtimes.json';

app.setPath('userData',process.env.TINYGPT_RUNTIME_TEST_PROFILE!);
app.whenReady().then(async()=>{
  const root=app.getPath('userData'),directory=join(root,'project with spaces');await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'probe script.cjs'),`require('node:fs').writeFileSync(process.argv[2]+'-node.json',JSON.stringify({version:process.versions.node,path:process.execPath,electron:process.versions.electron??null}));`);
  await writeFile(join(directory,'probe script.py'),`import json,sys,ssl,sqlite3,venv,pip\nwith open(sys.argv[1]+'-python.json','w') as f: json.dump({'version':sys.version.split()[0],'path':sys.executable},f)\n`);
  const command=(mode:string)=>`node "probe script.cjs" ${mode}; python "probe script.py" ${mode}; python3 --version; npm --version; npx --version`;
  let parent=0,child=0;const native=new Map<string,string>(),shellResults:string[]=[];
  const server=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw),names=(body.tools??[]).map((tool:any)=>tool.function.name),outer=names.includes('code_task');
    let action:{name:string;arguments:string}|undefined;
    if(outer){const step=parent++;if(step===0)action={name:process.platform==='win32'?'powershell':'bash',arguments:JSON.stringify({command:command('work'),timeout:120,description:'Verify bundled tools'})};else if(step===1)action={name:'code_task',arguments:JSON.stringify({task:'Run the bundled runtime verification commands in the workspace.',browser:false})};}
    else if(child++===0)action={name:'bash',arguments:JSON.stringify({command:command('coding'),description:'Verify bundled tools',timeout:120000})};
    const delta=action?{role:'assistant',tool_calls:[{index:0,id:'runtime-'+(outer?'work':'coding')+'-'+(outer?parent:child),type:'function',function:action}]}:{role:'assistant',content:'Runtime verification complete.'};
    const frame={id:'runtime-fixture-'+parent+'-'+child,object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:action?'tool_calls':'stop'}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}};
    res.writeHead(200,{'content-type':'text/event-stream'}).end('data: '+JSON.stringify(frame)+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const history=new HistoryStore(join(root,'library.sqlite'));const pty=new LocalPtyHost(join(root,'pty'));
  try{
    const project=history.createProject('Runtime proof','',false,directory),conversation=history.createConversation(project.id,'code'),turn=history.startTurn(conversation.id,'Verify runtimes.','local');
    const files=new CodeFiles(history,new ProjectFiles(history.sources));
    for(const [name,args] of [['node',['--version']],['python',['--version']],['python3',['--version']],['npm',['--version']],['npx',['--version']]] as const){const result=await files.command(directory,name,[...args],'.',30,AbortSignal.timeout(40000));assert.equal(result.exitCode,0,result.output);assert.ok(result.output.includes(name.startsWith('python')?pins.python.version:name==='node'?pins.node.version:pins.node.npm));}
    await createWorkExecution(history).run({runId:turn.runId,conversationId:conversation.id,replyMessageId:turn.assistantId,route:'byok',provider:'custom',protocol:'openai-compatible',endpoint:`http://127.0.0.1:${(server.address() as any).port}/v1`,model:'fixture',contextWindowTokens:64000,maxOutputTokens:4096,instructions:WORK_RUNTIME_INSTRUCTIONS,messages:[{role:'user',text:'Verify the bundled runtimes using Work and the coding agent.'}],tools:true},AbortSignal.timeout(150000),()=>{},async()=> '{}',undefined,undefined,undefined,undefined,async event=>{
      if(event.phase==='before')native.set(event.id,event.name);
      if(event.phase==='after'&&native.get(event.id)==='code_bash'){
        assert.equal(event.status,'success',event.output);
        if(event.metadata?.exit!==undefined)assert.equal(event.metadata.exit,0,event.output);
        assert.ok(event.output.includes(pins.python.version),event.output);assert.ok(event.output.includes(pins.node.npm),event.output);
        assert.ok(!/not recognized|not found/i.test(event.output),event.output);shellResults.push(event.output);
      }
      return {};
    });
    const expected=workRuntimePaths();
    const check=async(mode:string)=>{const node=JSON.parse(await readFile(join(directory,mode+'-node.json'),'utf8')),python=JSON.parse(await readFile(join(directory,mode+'-python.json'),'utf8'));assert.deepEqual(node,{version:pins.node.version,path:expected.node,electron:null});assert.equal(python.version,pins.python.version);assert.equal(await realpath(python.path),await realpath(expected.python));};
    await check('work');await check('coding');assert.ok([...native.values()].includes('code_delegate'));assert.equal(shellResults.length,2);
    let output='';const terminal=await pty.create(directory,text=>output+=text,()=>{});
    terminal.write(command('pty')+'; node "probe script.cjs" pty-done\r');
    const until=Date.now()+45000;while(Date.now()<until){try{await stat(join(directory,'pty-done-node.json'));break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}}
    await check('pty');assert.ok(output.includes(pins.node.npm),output);assert.ok(!/not recognized|not found/i.test(output),output);await terminal.close();
    await writeFile(join(root,'proof.json'),JSON.stringify({passed:true,versions:{node:pins.node.version,python:pins.python.version,npm:pins.node.npm},paths:expected,checks:['minimal OS-only PATH','direct Work program commands','actual Pi Work shell','actual delegated coding-agent shell','actual interactive PTY','standard Python ssl/sqlite3/venv/pip imports','standalone Node rather than Electron']},null,2));
    console.log('Bundled runtime execution proof passed: direct Work, Pi shell, coding agent and PTY.');
  }finally{await pty.shutdown();history.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1);});

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import type { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { codeBinary } from './code-execution';
import { codeShellEnvironment } from './code-shell';
import { TERMINAL_START_ERROR } from '../shared/terminal';

export interface LocalPty { write(data: string): void; resize(cols: number, rows: number): Promise<void>; close(): Promise<void> }

/** OpenCode bundles a cross-platform PTY. Keep its authenticated transport in
 * main; the renderer receives terminal data, never its address or credentials. */
export class LocalPtyHost {
  private child?: ChildProcess;
  private starting?: Promise<{ client: ReturnType<typeof createOpencodeClient>; url: string; authorization: string }>;
  private closing = false;
  private sessions = new Set<LocalPty>();
  constructor(private root: string) {}
  private start(directory: string) {
    if (this.closing) throw new Error(TERMINAL_START_ERROR);
    return this.starting ??= (async () => {
      await mkdir(this.root,{recursive:true});
      const configPath = join(this.root,'.npmrc'); await writeFile(configPath,'offline=true\nregistry=http://127.0.0.1:9\nfetch-retries=0\n',{mode:0o600});
      const password = randomBytes(32).toString('hex');
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','PATHEXT']) if (process.env[key]) env[key] = process.env[key];
      Object.assign(env,await codeShellEnvironment(this.root,env),{ HOME:this.root, USERPROFILE:this.root, APPDATA:join(this.root,'config'), LOCALAPPDATA:join(this.root,'cache'), XDG_CONFIG_HOME:join(this.root,'config'), XDG_DATA_HOME:join(this.root,'data'), XDG_CACHE_HOME:join(this.root,'cache'), XDG_STATE_HOME:join(this.root,'state'), NPM_CONFIG_USERCONFIG:configPath, npm_config_userconfig:configPath, OPENCODE_SERVER_PASSWORD:password, OPENCODE_CONFIG_CONTENT:JSON.stringify({logLevel:'ERROR',autoupdate:false,share:'disabled',snapshot:false,lsp:false,formatter:false,plugin:[],enabled_providers:[],watcher:{ignore:['**']}}), OPENCODE_DISABLE_AUTOUPDATE:'true', OPENCODE_DISABLE_MODELS_FETCH:'true', OPENCODE_DISABLE_DEFAULT_PLUGINS:'true', OPENCODE_DISABLE_PROJECT_CONFIG:'true', OPENCODE_DISABLE_CLAUDE_CODE:'true', OPENCODE_DISABLE_CLAUDE_CODE_SKILLS:'true', OPENCODE_DISABLE_EXTERNAL_SKILLS:'true' });
      delete env.Path;
      if (this.closing) throw new Error(TERMINAL_START_ERROR);
      const child = this.child = spawn(codeBinary(),['serve','--hostname=127.0.0.1','--port=0'],{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','ignore']});
      const url = await new Promise<string>((resolve,reject) => {
        let output = ''; const timer = setTimeout(()=>reject(new Error(TERMINAL_START_ERROR)),30000);
        child.once('error',()=>{clearTimeout(timer);reject(new Error(TERMINAL_START_ERROR));});
        child.once('exit',()=>{clearTimeout(timer);this.starting=undefined;reject(new Error(TERMINAL_START_ERROR));});
        child.stdout!.on('data',bytes=>{output=(output+bytes.toString()).slice(-4000);const match=/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);if(match){clearTimeout(timer);resolve(match[1]);}});
      });
      const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}`;
      const {createOpencodeClient} = await import('@opencode-ai/sdk/v2');
      return {url,authorization,client:createOpencodeClient({baseUrl:url,headers:{Authorization:authorization},throwOnError:true})};
    })().catch(async()=>{this.child?.kill();this.starting=undefined;throw new Error(TERMINAL_START_ERROR);});
  }
  async create(cwd: string, data: (text: string)=>void, exited: ()=>void): Promise<LocalPty> {
    const {client,url,authorization} = await this.start(cwd);
    if (this.closing) throw new Error(TERMINAL_START_ERROR);
    const shell = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe') : process.env.SHELL || '/bin/sh';
    const env = await codeShellEnvironment(this.root);
    // Interactive shells use the user's normal home, while npm/Node aliases and
    // the OpenCode service configuration remain isolated from coding sessions.
    for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA']) if (process.env[key]) Object.assign(env,{[key]:process.env[key]});
    const result = await client.pty.create({directory:cwd,cwd,command:shell,args:process.platform==='win32'?['-NoLogo','-NoProfile']:/zsh$/.test(shell)?['-f']:/bash$/.test(shell)?['--noprofile','--norc']:[],title:'TinyGPT terminal',env},{signal:AbortSignal.timeout(15000)});
    const ptyID = result.data!.id;
    const endpoint = new URL(`/pty/${encodeURIComponent(ptyID)}/connect`,url); endpoint.protocol='ws:';endpoint.searchParams.set('directory',cwd);
    const socket = new WebSocket(endpoint,{headers:{Authorization:authorization},handshakeTimeout:10000});
    let closed = false, removed = false;
    const session: LocalPty = {
      write(text) { if (!closed && socket.readyState === WebSocket.OPEN) socket.send(text); },
      async resize(cols,rows) { if (!closed) await client.pty.update({ptyID,directory:cwd,size:{cols,rows}},{signal:AbortSignal.timeout(5000)}); },
      close: async()=>{if(removed)return;removed=true;closed=true;socket.close();this.sessions.delete(session);await client.pty.remove({ptyID,directory:cwd},{signal:AbortSignal.timeout(3000)}).catch(()=>{});},
    };
    socket.on('message',bytes=>{const buffer=Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes as ArrayBuffer);if(buffer[0]!==0)data(buffer.toString('utf8'));});
    socket.on('close',()=>{if(!closed){closed=true;void session.close();exited();}});
    socket.on('error',()=>{ /* The close callback reports the disconnected terminal. */ });
    try { await new Promise<void>((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);socket.once('close',()=>reject(new Error(TERMINAL_START_ERROR)));}); }
    catch { await session.close(); throw new Error(TERMINAL_START_ERROR); }
    if(this.closing){await session.close();throw new Error(TERMINAL_START_ERROR);}this.sessions.add(session);return session;
  }
  async shutdown() {
    this.closing=true;
    await Promise.allSettled([...this.sessions].map(session=>session.close()));
    const child=this.child;if(!child || child.exitCode!==null)return;
    const done=new Promise<void>(resolve=>child.once('exit',()=>resolve()));child.kill();
    await Promise.race([done,new Promise<void>(resolve=>setTimeout(resolve,2000))]);if(child.exitCode===null)child.kill('SIGKILL');
  }
}

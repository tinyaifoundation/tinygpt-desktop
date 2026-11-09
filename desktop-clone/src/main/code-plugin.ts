/** Trusted local OpenCode plugin. Native tools keep their original implementation;
 * the hooks wait for TinyGPT's approval and report their actual outcomes. */
import { WORK_COMPACTION_CONTEXT, WORK_COMPACTION_CONTINUE } from '../core/work-instructions';
export function codePlugin(url: string, token: string, shellEnv: Record<string,string> = {}) {
  return `
const names = new Set(['read','glob','grep','edit','write','bash','apply_patch','todowrite']);
const post = async (value) => {
  const response = await fetch(${JSON.stringify(url)}, {method:'POST',headers:{Authorization:${JSON.stringify(`Bearer ${token}`)},'content-type':'application/json'},body:JSON.stringify(value)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'TinyGPT could not approve this action.');
  return result;
};
export default async () => {
  // The bundled runtime uses Effect's process spawner for native commands.
  // Hide those launches too, rather than only hiding the OpenCode server.
  if (process.platform === 'win32') {
    const {createRequire,syncBuiltinESMExports} = await import('node:module');
    const childProcess = createRequire(process.execPath)('node:child_process');
    const marker = Symbol.for('tinygpt.headless-spawn');
    if (!childProcess[marker]) {
      const spawn = childProcess.spawn;
      childProcess.spawn = function(command,args,options) {
        if (Array.isArray(args)) return spawn.call(this,command,args,{...options,windowsHide:true});
        return spawn.call(this,command,{...options,...args,windowsHide:true});
      };
      childProcess[marker] = true;
      syncBuiltinESMExports();
    }
  }
  await post({phase:'ready'});
  return {
    'experimental.session.compacting': async (_input,output) => {
      output.context.push(${JSON.stringify(WORK_COMPACTION_CONTEXT)});
    },
    'experimental.chat.messages.transform': async (_input,output) => {
      const defaultContinuation = 'Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.';
      for (const message of output.messages) {
        if (message.info.role !== 'user' || message.info.agent !== 'build') continue;
        for (const part of message.parts) {
          // Match only the pinned runtime's generated auto-compaction marker.
          // Real user text, saved history and attachment-overflow warnings stay intact.
          if (part.type === 'text' && part.synthetic === true && part.metadata?.compaction_continue === true && part.text.endsWith(defaultContinuation)) {
            part.text = part.text.slice(0,-defaultContinuation.length) + ${JSON.stringify(WORK_COMPACTION_CONTINUE)};
          }
        }
      }
    },
    'shell.env': async (_input,output) => { Object.assign(output.env,${JSON.stringify(shellEnv)}); if(process.platform==='win32')delete output.env.Path; },
    'tool.execute.before': async (input,output) => {
      if (input.tool.startsWith('tinygpt_')) return;
      if (!names.has(input.tool)) throw new Error('This native tool is unavailable.');
      if (input.tool === 'bash') {
        const timeout = Number(output.args.timeout);
        output.args.timeout = Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 2147483647 ? timeout : 120000;
      }
      const {status,permission,...args} = output.args;
      await post({phase:'before',callID:input.callID,tool:input.tool,args,displayText:status,approvalText:permission});
      delete output.args.status; delete output.args.permission;
    },
    'tool.execute.after': async (input,output) => {
      if (!names.has(input.tool)) return;
      const result = await post({phase:'after',callID:input.callID,status:'success',output:output.output,metadata:output.metadata});
      if (typeof result.output === 'string') output.output = result.output;
    }
  };
};
`;
}

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { terminateOwnedProcess } from '../src/main/owned-process';

async function running(script = "process.stdout.write('ready');setInterval(()=>{},1000)") {
  const child = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const [bytes] = await once(child.stdout!, 'data');
  return { child, output: String(bytes) };
}
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch { return false; } }

it('waits for the owned process to exit and leaves an unrelated process running', async () => {
  const own = await running(), other = await running();
  try {
    await terminateOwnedProcess(own.child);
    expect(alive(own.child.pid!)).toBe(false); expect(alive(other.child.pid!)).toBe(true);
    await terminateOwnedProcess(own.child);
  } finally { await Promise.all([terminateOwnedProcess(own.child), terminateOwnedProcess(other.child)]); }
}, 20000);

it.skipIf(process.platform !== 'win32')('stops an owned Windows process tree rather than leaving a child behind', async () => {
  const { child: parent, output } = await running("const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});c.once('spawn',()=>process.stdout.write(String(c.pid)));setInterval(()=>{},1000)");
  const descendant = Number(output);
  expect(Number.isSafeInteger(descendant)).toBe(true);
  try {
    await terminateOwnedProcess(parent);
    expect(alive(parent.pid!)).toBe(false); expect(alive(descendant)).toBe(false);
  } finally {
    await terminateOwnedProcess(parent);
    if (alive(descendant)) process.kill(descendant, 'SIGKILL');
  }
}, 20000);

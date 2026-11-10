import { execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const ended = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
function waitForExit(child: ChildProcess, milliseconds: number): Promise<boolean> {
  if (ended(child) || !child.pid) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = (exited: boolean) => { clearTimeout(timer); child.removeListener('exit', onExit); resolve(exited); };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(ended(child)), milliseconds);
    timer.unref();
    child.once('exit', onExit);
  });
}

/** Only terminate a child we own. Keep its handle until Windows acknowledges exit. */
export async function terminateOwnedProcess(child: ChildProcess): Promise<void> {
  if (ended(child) || !child.pid) return;
  const exit = waitForExit(child, 5000);
  if (process.platform === 'win32') {
    // Kill the owned tree before its root disappears; a name-wide kill could
    // terminate somebody else's Ollama, LM Studio, or llama.cpp session.
    await exec('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }).catch(() => {
      if (!ended(child)) child.kill('SIGKILL');
    });
  } else child.kill();
  if (await exit) return;
  const forcedExit = waitForExit(child, 5000);
  child.kill('SIGKILL');
  if (!(await forcedExit)) throw new Error('The owned local model did not exit.');
}

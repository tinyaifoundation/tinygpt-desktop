import { app } from 'electron';
import { join, basename } from 'node:path';
import { mkdir, readFile, copyFile, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const prepared = new Map<string, Promise<void>>();
/** Pi's native search tools use its bin directory. Stage pinned, packaged helpers before import. */
export async function preparePiTools(storage: string) {
  const agent = join(storage, 'pi-agent');
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.PI_OFFLINE = '1';
  process.env.PI_TELEMETRY = '0';
  if (!prepared.has(agent)) prepared.set(agent, (async () => {
    const source = app.isPackaged ? join(process.resourcesPath, 'work-tools') : join(__dirname, '../../runtimes/work-tools');
    const manifest = JSON.parse(await readFile(join(source, 'prepared.json'), 'utf8'));
    if (manifest.target !== `${process.platform}-${process.arch}`) throw new Error('Prepare Work search tools for this platform before launching.');
    const bin = join(agent, 'bin'); await mkdir(bin, { recursive: true });
    for (const name of ['rg', 'fd']) {
      const filename = name + (process.platform === 'win32' ? '.exe' : '');
      const bytes = await readFile(join(source, filename));
      if (createHash('sha256').update(bytes).digest('hex') !== manifest.files.find((file: any) => file.path === filename)?.sha256) throw new Error('Work search tool verification failed.');
      await copyFile(join(source, filename), join(bin, filename)); if (process.platform !== 'win32') await chmod(join(bin, filename), 0o755);
    }
    if (process.platform === 'win32') {
      // Upstream find/grep omit windowsHide. Restrict this compatibility fix to those executables.
      const cp = createRequire(__filename)('node:child_process') as typeof childProcess & { [key: symbol]: boolean };
      const marker = Symbol.for('tinygpt.headless-search');
      if (!cp[marker]) {
        const spawn = cp.spawn, spawnSync = cp.spawnSync;
        const search = (command: unknown) => typeof command === 'string' && /^(fd|rg)(\.exe)?$/i.test(basename(command));
        cp.spawn = ((command: any, args: any, options: any) => search(command) ? Array.isArray(args) ? spawn(command, args, { ...options, windowsHide: true }) : spawn(command, { ...args, windowsHide: true }) : spawn(command, args, options)) as typeof spawn;
        cp.spawnSync = ((command: any, args: any, options: any) => search(command) ? Array.isArray(args) ? spawnSync(command, args, { ...options, windowsHide: true }) : spawnSync(command, { ...args, windowsHide: true }) : spawnSync(command, args, options)) as typeof spawnSync;
        cp[marker] = true; syncBuiltinESMExports();
      }
    }
  })().catch(error => { prepared.delete(agent); throw error; }));
  await prepared.get(agent);
}

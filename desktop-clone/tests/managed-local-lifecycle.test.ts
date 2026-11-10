import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const fake = vi.hoisted(() => ({ open: vi.fn(), spawn: vi.fn(), terminate: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn: fake.spawn }));
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>(),
  mkdir: vi.fn().mockResolvedValue(undefined), stat: vi.fn().mockResolvedValue({ size: 1561318368 }),
  writeFile: vi.fn().mockResolvedValue(undefined), open: fake.open,
}));
vi.mock('node:net', () => ({ createServer: () => ({ once() {}, listen(_port: number, _host: string, ready: () => void) { ready(); }, address: () => ({ port: 8431 }), close: (done: () => void) => done() }) }));
vi.mock('../src/main/owned-process', () => ({ terminateOwnedProcess: fake.terminate }));
import { ManagedLocalModel } from '../src/main/managed-local';

function child(pid: number) {
  return Object.assign(new EventEmitter(), { pid, exitCode: null as number | null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter() }) as unknown as ChildProcess;
}
function exit(child: ChildProcess) { Object.assign(child, { exitCode: 0 }); child.emit('exit', 0, null); }
beforeEach(() => {
  fake.spawn.mockReset(); fake.terminate.mockReset(); fake.open.mockReset();
  fake.open.mockImplementation(async () => ({ close: vi.fn().mockResolvedValue(undefined) }));
  fake.terminate.mockImplementation((child: ChildProcess) => new Promise<void>(resolve => child.once('exit', () => resolve())));
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/props') ? { default_generation_settings: { n_ctx: 65536 } } : {}))));
});
afterEach(() => vi.unstubAllGlobals());

it('never spawns a model when close interrupts the final startup file operation', async () => {
  const model = new ManagedLocalModel('/private-model', '/bundled');
  let finishOpen!: (file: { close: ReturnType<typeof vi.fn> }) => void;
  fake.open.mockImplementationOnce(() => new Promise(resolve => finishOpen = resolve));
  const starting = model.start();
  await vi.waitFor(() => expect(fake.open).toHaveBeenCalledOnce());
  const failed = expect(starting).rejects.toThrow('canceled');
  const stopping = model.shutdown();
  const file = { close: vi.fn().mockResolvedValue(undefined) }; finishOpen(file);
  await stopping; await failed;
  expect(fake.spawn).not.toHaveBeenCalled(); expect(file.close).toHaveBeenCalledOnce();
  await expect(model.start()).rejects.toThrow('closing');
});

it('retains ownership until exit, shares concurrent stops, and serializes a restart behind exit', async () => {
  const model = new ManagedLocalModel('/private-model', '/bundled');
  const first = child(201), second = child(202);
  fake.spawn.mockReturnValueOnce(first).mockReturnValueOnce(second);
  await model.start(); expect(model.processId()).toBe(201);
  const stopping = model.stop(); expect(model.stop()).toBe(stopping);
  const restarting = model.start();
  await Promise.resolve(); expect(model.processId()).toBe(201); expect(fake.spawn).toHaveBeenCalledOnce();
  exit(first); await stopping; await restarting;
  expect(fake.spawn).toHaveBeenCalledTimes(2); expect(model.processId()).toBe(202);
  const closing = model.shutdown();
  await expect(model.start()).rejects.toThrow('closing');
  exit(second); await closing;
  expect(model.processId()).toBeUndefined(); expect(fake.terminate).toHaveBeenCalledTimes(2);
});

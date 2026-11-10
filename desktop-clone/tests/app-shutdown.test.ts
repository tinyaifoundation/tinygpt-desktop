import { expect, it, vi } from 'vitest';
import { AppShutdown } from '../src/main/app-shutdown';

it('blocks every quit request until cleanup finishes, including a quit raised during cleanup', async () => {
  const shutdown = new AppShutdown();
  const first = { preventDefault: vi.fn() }, second = { preventDefault: vi.fn() }, final = { preventDefault: vi.fn() };
  let stopped!: () => void;
  const models = new Promise<void>(resolve => stopped = resolve);
  const quit = vi.fn(() => { void shutdown.request(final, cleanup, quit); });
  const cleanup = vi.fn(async () => {
    void shutdown.request(second, cleanup, quit);
    await models;
  });
  const pending = shutdown.request(first, cleanup, quit);
  await Promise.resolve();
  expect(first.preventDefault).toHaveBeenCalledOnce(); expect(second.preventDefault).toHaveBeenCalledOnce();
  expect(cleanup).toHaveBeenCalledOnce(); expect(quit).not.toHaveBeenCalled();
  stopped(); await pending;
  expect(quit).toHaveBeenCalledOnce(); expect(final.preventDefault).not.toHaveBeenCalled();
});

it('does not let a failed model shutdown release the app and permits a later cleanup retry', async () => {
  const shutdown = new AppShutdown(), event = { preventDefault: vi.fn() }, quit = vi.fn();
  await expect(shutdown.request(event, async () => { throw Error('model still running'); }, quit)).rejects.toThrow('model still running');
  expect(quit).not.toHaveBeenCalled();
  await shutdown.request(event, async () => {}, quit);
  expect(event.preventDefault).toHaveBeenCalledTimes(2); expect(quit).toHaveBeenCalledOnce();
});

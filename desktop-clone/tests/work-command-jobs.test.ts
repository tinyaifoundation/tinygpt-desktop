import { expect, it } from 'vitest';
import { WorkCommandJobs } from '../src/main/work-command-jobs';

it('streams bounded job output, isolates conversations and stops children with their run', async () => {
  const jobs = new WorkCommandJobs(); let aborted = false;
  const job = jobs.start('a', 'run', new AbortController().signal, (signal, output) => {
    output('progress');
    return new Promise(resolve => signal.addEventListener('abort', () => { aborted = true; resolve({ exitCode: 1, output: 'stopped', truncated: false, timedOut: false }); }, { once: true }));
  });
  expect(job).toMatchObject({ running: true, output: 'progress' });
  expect(() => jobs.status('b', job.jobId)).toThrow('not available');
  expect(await jobs.observe('a', job.jobId, 0, new AbortController().signal)).toMatchObject({ running: true });
  await jobs.endRun('run'); expect(aborted).toBe(true); expect(jobs.status('a', job.jobId)).toMatchObject({ running: false, exitCode: 1 });
  await jobs.shutdown(); expect(() => jobs.status('a', job.jobId)).toThrow('not available');
});

it('returns actual completion and cancellation remains responsive while observing', async () => {
  const jobs = new WorkCommandJobs();
  const job = jobs.start('a', 'run', new AbortController().signal, async () => ({ exitCode: 0, output: 'verified', truncated: false, timedOut: false }));
  expect(await jobs.observe('a', job.jobId, 1, new AbortController().signal)).toMatchObject({ running: false, exitCode: 0, output: 'verified' });
  const next = jobs.start('a', 'run', new AbortController().signal, signal => new Promise(resolve => signal.addEventListener('abort', () => resolve({ exitCode: 1, output: '', truncated: false, timedOut: false }))));
  const controller = new AbortController(); const observation = jobs.observe('a', next.jobId, 5, controller.signal); controller.abort();
  await expect(observation).rejects.toThrow(); await jobs.shutdown();
});

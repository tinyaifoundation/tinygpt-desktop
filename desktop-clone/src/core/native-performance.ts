import type { NativePerformance } from '../shared/diagnostics';

/** Whitelisted native numeric counters survive log rotation. Never retain log
 * lines, paths, prompts, errors, credentials or arbitrary server text. */
export function nativePerformanceObserver(model: 'included' | 'pro', emit: (metric: NativePerformance) => void) {
  let pending = '';
  return (chunk: string) => {
    const lines = (pending + chunk).split('\n'); pending = lines.pop()!.slice(-4096);
    for (const line of lines) {
      const task = line.match(/\btask\s+(\d+)/), taskId = task ? Number(task[1]) : undefined;
      const timing = line.match(/(prompt eval time|\beval time)\s*=\s*([\d.]+) ms\s*\/\s*(\d+) tokens/);
      if (timing) { const durationMs = Number(timing[2]), tokens = Number(timing[3]); emit({ model, taskId, stage: timing[1] === 'prompt eval time' ? 'prefill' : 'generation', durationMs, tokens, tokensPerSecond: durationMs > 0 ? tokens * 1000 / durationMs : 0 }); }
      const progress = line.match(/n_gen\s*=\s*(\d+), tg\s*=\s*([\d.]+) t\/s/);
      if (progress) { const recent = line.match(/tg_3s\s*=\s*([\d.]+) t\/s/); emit({ model, taskId, stage: 'generation', tokens: Number(progress[1]), tokensPerSecond: Number(progress[2]), ...(recent ? { tokensPerSecondRecent: Number(recent[1]) } : {}) }); }
      const draft = line.match(/draft acceptance\s*=\s*([\d.]+).*?\(\s*(\d+) accepted\s*\/\s*(\d+) generated/);
      if (draft) emit({ model, taskId, stage: 'speculation', acceptance: Number(draft[1]), accepted: Number(draft[2]), drafted: Number(draft[3]) });
      const cache = line.match(/prompt state size ([\d.]+) MiB exceeds cache size limit ([\d.]+) MiB/);
      if (cache) emit({ model, stage: 'cache-skip', cacheRequiredMiB: Number(cache[1]), cacheBudgetMiB: Number(cache[2]) });
    }
  };
}

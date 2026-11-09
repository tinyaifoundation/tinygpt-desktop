import { freemem } from 'node:os';

/** Host prompt snapshots include hybrid recurrent state as well as attention KV.
 * Keep a host reserve; this is a lazy cache limit, not a GPU allocation. */
export function promptCacheMiB(freeBytes = freemem()): number {
  const spareMiB = Math.max(0, freeBytes / 2 ** 20 - 4096);
  // A single observed Pro state exceeds 4 GiB. Let machines with sufficient
  // free host RAM preserve it across vision/summary requests. This limit is
  // lazy, still leaves half the spare RAM plus 4 GiB, and allocates no VRAM.
  return Math.max(0, Math.min(16384, Math.floor(spareMiB / 2 / 256) * 256));
}

export function proRequiredFreeBytes(mtp: boolean): number {
  // Leave room for the separate 1.57 GiB prediction head, its KV and scratch.
  return (mtp ? 14.5 : 12.5) * 2 ** 30;
}

export type ManagedPerformance = {
  cacheMiB?: number;
  microbatch?: 128 | 256 | 512;
  cacheK?: 'q8_0' | 'q4_0';
  cacheV?: 'q8_0' | 'q4_0';
  backendSampling?: boolean;
  graphConcurrency?: boolean;
  mtpModel?: string;
  draftTokens?: 1 | 2 | 3;
};

export function managedPerformanceEnv(options: ManagedPerformance = {}): Record<string, string> {
  return options.graphConcurrency ? { GGML_CUDA_GRAPH_OPT: '1' } : {};
}

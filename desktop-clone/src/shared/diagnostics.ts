import { z } from 'zod';

const reading = z.number().finite().min(0).max(1e12).nullable();
export const gpuSampleSchema = z.object({
  status: z.enum(['nvidia', 'unavailable']), hostFreeMiB: reading, hostTotalMiB: reading,
  devices: z.array(z.object({
    index: z.number().int().min(0).max(128), utilizationPct: reading, memoryUtilizationPct: reading,
    usedMiB: reading, totalMiB: reading, smClockMHz: reading, memoryClockMHz: reading,
    powerWatts: reading, powerLimitWatts: reading, temperatureC: reading, pstate: reading,
    powerLimited: z.boolean().nullable(), thermalLimited: z.boolean().nullable(),
    ownedComputeProcesses: reading, otherComputeProcesses: reading, ownedComputeMiB: reading,
  }).strict()).max(16),
}).strict();
export type GpuSample = z.infer<typeof gpuSampleSchema>;
export const nativePerformanceSchema = z.object({
  model: z.enum(['included', 'pro']), stage: z.enum(['configuration', 'prefill', 'generation', 'speculation', 'cache-skip']),
  taskId: z.number().int().min(0).optional(), tokens: reading.optional(), durationMs: reading.optional(), tokensPerSecond: reading.optional(), tokensPerSecondRecent: reading.optional(),
  accepted: reading.optional(), drafted: reading.optional(), acceptance: reading.optional(),
  cacheRequiredMiB: reading.optional(), cacheBudgetMiB: reading.optional(), contextTokens: reading.optional(),
  backend: z.enum(['CPU', 'CUDA', 'Vulkan', 'Metal']).optional(), speculative: z.boolean().optional(),
  gpuIndex: z.number().int().min(0).max(128).optional(),
}).strict();
export type NativePerformance = z.infer<typeof nativePerformanceSchema>;

export const traceEventSchema = z.object({
  errorCode: z.enum(['context-empty', 'context-overflow', 'provider-http', 'message-order', 'runtime', 'unknown']).optional(),
  event: z.enum(['gpu-sample', 'runtime-metric', 'run-start', 'plugins-start', 'plugins-end', 'memory-start', 'memory-end', 'execution-start', 'worker-ready', 'runtime-ready', 'tools-activated', 'bot-runtime-start', 'bot-send', 'bot-accepted', 'context-measure-start', 'context-measure-end', 'tokenizer-ready', 'context-budget', 'request-start', 'prompt-progress', 'request-shape', 'request-headers', 'request-first-data', 'request-progress', 'request-end', 'request-closed', 'request-cancelled', 'request-error', 'context-pruned', 'compaction-detail', 'delegated-usage', 'model-usage', 'output-continuation', 'pro-thinking-limit', 'first-thinking', 'first-text', 'model-progress', 'text-lane', 'preparing-tool', 'optimizing', 'optimized', 'optimization-failed', 'checkpoint', 'usage', 'tool-queued', 'tool-start', 'tool-end', 'approval-start', 'approval-end', 'worker-complete', 'worker-stopped', 'run-complete', 'run-error', 'run-cancelled', 'ui-frame']),
  toolNames: z.array(z.string().max(128)).max(2000).optional(),
  gpu: gpuSampleSchema.optional(), nativePerformance: nativePerformanceSchema.optional(),
  runtime: z.enum(['pi', 'opencode', 'chat']).optional(), runtimeVersion: z.string().max(50).optional(),
  promptCharacters: z.object({system:z.number().int().min(0),user:z.number().int().min(0),reasoning:z.number().int().min(0),assistant:z.number().int().min(0),toolResults:z.number().int().min(0),toolArguments:z.number().int().min(0),schemas:z.number().int().min(0)}).strict().optional(), messageCount: z.number().int().min(0).max(100000).optional(), stablePrefixMessages: z.number().int().min(0).max(100000).optional(), schemasChanged: z.boolean().optional(),
  promptProcessedTokens: z.number().int().min(0).max(100000000).optional(), promptProcessingMs: z.number().int().min(0).max(100000000).optional(),
  cacheReadTokens: z.number().int().min(0).max(100000000).optional(), cacheWriteTokens: z.number().int().min(0).max(100000000).optional(),
  requestId: z.uuid().optional(), operationId: z.uuid().optional(),
  purpose: z.enum(['reply', 'summary', 'metadata']).optional(),
  tool: z.enum(['search_help', 'read_source', 'read_observation', 'list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'run_command', 'load_tools', 'search_skills', 'load_skill', 'read_skill_reference', 'draft_skill', 'copy_skill_files', 'generate_image', 'view_image', 'browser_screenshot', 'calculate', 'present', 'search_web', 'read_page', 'browser_tabs', 'browser_open', 'browser_preview', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_hover', 'browser_press_key', 'browser_close', 'computer_open_app', 'computer_activate_window', 'computer_list_windows', 'computer_read_window', 'computer_screenshot', 'computer_click', 'computer_type', 'computer_press_key', 'computer_scroll', 'list_project_files', 'read_project_file', 'write_project_file', 'search_sources', 'request_plugin_connection', 'create_project_directory', 'edit_project_file', 'review_project_changes', 'run_project_command', 'command_status', 'command_stop', 'native-code', 'extension']).optional(),
  phase: z.enum(['connecting', 'thinking', 'tool-input', 'tool', 'answer', 'waiting', 'prose', 'optimizing']).optional(),
  lane: z.enum(['answer', 'progress', 'unclassified']).optional(),
  outcome: z.enum(['success', 'error', 'denied', 'cancelled', 'interrupted']).optional(),
  failure: z.enum(['timeout', 'authentication', 'rate-limit', 'provider', 'context', 'output-limit', 'model-stall', 'runtime', 'connection', 'cancelled']).optional(),
  runtimeCause: z.enum(['child-exit', 'transport', 'event-stream', 'incomplete-session']).optional(),
  status: z.number().int().min(100).max(599).optional(),
  inputTokens: z.number().int().min(0).max(100000000).optional(), outputTokens: z.number().int().min(0).max(100000000).optional(),
  retainedTokens: z.number().int().min(0).max(10000000).optional(), contextBeforeTokens: z.number().int().min(0).max(10000000).optional(), contextAfterTokens: z.number().int().min(0).max(10000000).optional(), savedCharacters: z.number().int().min(0).max(100000000).optional(),
  budgetTokens: z.number().int().min(0).max(2000000).optional(), fixedTokens: z.number().int().min(0).max(10000000).optional(),
  textChars: z.number().int().min(0).max(10000000).optional(), reasoningChars: z.number().int().min(0).max(10000000).optional(),
  bytes: z.number().int().min(0).max(100000000).optional(), chunks: z.number().int().min(0).max(10000000).optional(),
  updateId: z.number().int().min(1).max(100000000).optional(),
  renderMs: z.number().finite().min(0).max(3600000).optional(), deliveryMs: z.number().finite().min(0).max(3600000).optional(),
  visibility: z.enum(['foreground', 'background', 'offscreen']).optional(),
  cause: z.enum(['snapshot', 'content', 'interaction']).optional(),
  answerVisible: z.boolean().optional(), workVisible: z.boolean().optional(), thinkingVisible: z.boolean().optional(), approvalVisible: z.boolean().optional(), errorVisible: z.boolean().optional(), textHeld: z.boolean().optional(),
}).strict();
export type TraceEvent = z.infer<typeof traceEventSchema>;
export type TraceRecord = TraceEvent & { elapsedMs: number; sequence: number };
export type TraceStamp = { runId: string; updateId: number; publishedAt: number };
export const uiTraceSchema = traceEventSchema.pick({ cause: true, phase: true, updateId: true, renderMs: true, deliveryMs: true, visibility: true, answerVisible: true, workVisible: true, thinkingVisible: true, approvalVisible: true, errorVisible: true, textHeld: true }).extend({ runId: z.uuid(), updateId: z.number().int().min(1).max(100000000) }).strict();
export type UiTrace = z.infer<typeof uiTraceSchema>;
export const traceMetadataSchema = z.object({ runId: z.uuid(), route: z.enum(['byok', 'local']), provider: z.enum(['openai', 'anthropic', 'xai', 'openrouter', 'custom', 'local']), protocol: z.enum(['openai-compatible', 'openai-responses', 'anthropic']), fingerprint: z.string().regex(/^[a-f0-9]{16}$/), version: z.string().max(64).regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/), platform: z.enum(['win32', 'darwin', 'linux']), startedAt: z.number().int().min(0) }).strict();
export type TraceMetadata = z.infer<typeof traceMetadataSchema>;
export interface TraceMetrics { totalMs: number; setupMs: number | null; workerMs: number | null; harnessMs: number | null; tokenizerMs: number | null; firstActivityMs: number | null; firstAnswerMs: number | null; firstModelMs: number | null; compactionMs: number; approvalMs: number; toolMs: number; toolPreparationMs: number; requestCount: number; providerWaitMs: number; maxUiLagMs: number; heldTextMs: number; inputTokens: number; outputTokens: number }
export interface TraceReport extends TraceMetadata { status: 'running' | 'complete' | 'error' | 'cancelled' | 'interrupted'; events: TraceRecord[]; metrics: TraceMetrics; observations: string[] }
export interface DiagnosticsSnapshot { enabled: boolean; persistent: boolean; retentionDays: number; maxRuns: number; runs: Omit<TraceReport, 'events'>[] }
export interface TraceSink { begin(meta: TraceMetadata): void; record(runId: string, event: TraceEvent): void; stamp(runId: string): TraceStamp | undefined }

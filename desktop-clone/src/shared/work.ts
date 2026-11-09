import { z } from 'zod';

export type WorkToolName = 'work_plan' | 'work_finish' | 'work_evidence' | 'work_ask_user' | 'work_history';
export const workToolNames = ['work_plan', 'work_finish', 'work_evidence', 'work_ask_user', 'work_history'] as const;
export const simplePlanSchema = z.object({ steps: z.array(z.string().trim().min(1).max(500)).max(12) }).strict();
export const simpleFinishSchema = z.object({ answer: z.string().trim().min(1).max(32000), status: z.enum(['completed', 'blocked', 'waiting']).default('completed') }).strict();
export const workHistorySchema = z.object({ query: z.string().max(500).default(''), offset: z.number().int().min(0).default(0) }).strict();
export const workAskSchema = z.object({ question: z.string().trim().min(1).max(1000), options: z.array(z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/), label: z.string().trim().min(1).max(160), description: z.string().max(300).optional() }).strict()).max(4).default([]) }).strict();
export const workAnswerSchema = z.object({ questionId: z.uuid(), optionId: z.string().max(40).optional(), text: z.string().trim().min(1).max(4000).optional() }).strict().refine(value => !!value.optionId !== !!value.text, 'Choose one option or provide an answer.');
export interface WorkUserAnswer { questionId: string; question: string; answer: string }
export interface WorkQuestion { id: string; taskId: string; conversationId: string; messageId: string; operationId: string; question: string; options: { id: string; label: string; description?: string }[]; status: 'pending' | 'answered' | 'dismissed'; answer?: string; createdAt: number }
export const WORK_OUTPUT_STALLED_MESSAGE = 'Work paused because the model repeatedly exhausted its response budget without taking another action. Completed work is saved. Select a more capable model or revise the task before resuming.';
export const workReferenceSchema = z.union([z.string().regex(/^e[1-9]\d*$/), z.uuid()]);
export const workEvidenceSchema = z.object({ evidenceId: workReferenceSchema, offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(12000).default(8000) }).strict();
export const workCompletionSchema = z.union([
  z.object({ text: z.string().trim().min(1).max(200), match: z.enum(['exact', 'contains']).default('exact'), state: z.enum(['present', 'absent']).default('present') }).strict(),
  z.object({ url: z.string().trim().min(1).max(2000), match: z.enum(['exact', 'contains']).default('contains') }).strict(),
]);
export const workOutputSchema = z.object({ name: z.string().trim().min(1).max(160), value: z.string().trim().min(1).max(2000), evidenceIds: z.array(workReferenceSchema).max(12).default([]) }).strict();
export const workBlockerSchema = z.object({ kind: z.enum(['permission', 'tool-failure', 'external-dependency', 'capability']), capability: z.enum(['desktop', 'browser-control', 'commands']).optional(), evidenceIds: z.array(workReferenceSchema).max(8).default([]), recoveryEvidenceIds: z.array(workReferenceSchema).max(8).default([]), reason: z.string().trim().min(1).max(1000).describe('The specific obstacle and why supported recovery cannot resolve it. Unperformed steps and incomplete verification are not blockers.') }).strict();
export type WorkStatus = 'running' | 'awaiting-input' | 'waiting' | 'paused' | 'completed' | 'blocked' | 'cancelled';
export interface WorkCriterion { id?: string; description: string; evidenceIds: string[]; verification: string; completion?: z.infer<typeof workCompletionSchema>; requiredOutputs?: string[]; outputs?: z.infer<typeof workOutputSchema>[] }
export interface WorkTask { simple?: boolean; id: string; conversationId: string; messageId: string; runId: string; revision: number; status: WorkStatus; goal: string; steps: string[]; criteria: WorkCriterion[]; summary: string; answer?: string; blocker?: z.infer<typeof workBlockerSchema>; capabilities?: Partial<Record<'desktop' | 'browser-control' | 'commands', boolean>>; userAnswers?: WorkUserAnswer[]; proProgress?: { seen: string[]; stalls: number; decisions: number }; updatedAt: number }
export interface WorkOutcome { status: 'completed' | 'blocked' | 'waiting'; summary: string; answer?: string }
export function isWorkOutcome(status?: WorkStatus): status is WorkOutcome['status'] { return status === 'completed' || status === 'blocked' || status === 'waiting'; }
/** A whole native control envelope is never a user-facing task report. Fenced
 * examples and prose discussing tool syntax remain ordinary answer content. */
export function isWorkToolEnvelope(text: string): boolean { return /^\s*<(?:function\s+name\s*=\s*["'][\w.-]+["'][^>]*>[\s\S]*<\/function|tool_call>[\s\S]*<\/tool_call)>\s*$/.test(text); }
export interface WorkDecision { action: 'continue' | 'stop'; outcome?: WorkOutcome }
export type WorkControl = (event: 'batch') => Promise<WorkDecision>;
export interface WorkOperation { id: string; ref?: string; name: string; input: Record<string, unknown>; result: string; status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown'; signature: string }
export const WORK_PAUSED_MESSAGE = 'Work paused without a verified completion. Progress and tool outcomes are saved. Continue with revised instructions or inspect the recorded blocker.';
export const simpleWorkToolDefinitions = [
  { name: 'work_plan' as const, description: 'Optionally save a short list of steps for display. Planning is not required.', schema: z.toJSONSchema(simplePlanSchema, { io: 'input' }) },
  { name: 'work_ask_user' as const, description: 'Ask for necessary missing information or a decision. The host waits for the answer and continues. Use for questions, not action approvals or routine tool errors.', schema: z.toJSONSchema(workAskSchema, { io: 'input' }) },
  { name: 'work_history' as const, description: 'Read saved operation results without repeating actions. Optional text query and offset page the history.', schema: z.toJSONSchema(workHistorySchema, { io: 'input' }) },
  { name: 'work_finish' as const, description: 'Optional structured outcome: answer and optional status (completed, blocked, waiting). A normal final answer also ends the run; this tool is not required.', schema: z.toJSONSchema(simpleFinishSchema, { io: 'input' }) },
];

// Kept only for displaying errors saved by older builds. No runtime policy uses it.
export const PRO_WORK_STALLED_MESSAGE = "TinyGPT Pro stopped advancing this task after bounded recovery. Completed work is saved. Continue with revised instructions or select a different effort or model; no user approval is missing.";

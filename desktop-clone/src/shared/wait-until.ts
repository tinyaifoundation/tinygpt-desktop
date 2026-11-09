import { z } from 'zod';

export const waitUntilSchema = z.object({
  text: z.string().trim().min(1).max(200),
  state: z.enum(['present', 'absent']).default('present'),
  match: z.enum(['exact', 'contains']).default('exact'),
  timeoutMs: z.number().int().min(1000).max(30000).default(15000),
}).strict();
export const browserWaitUntilSchema = z.union([waitUntilSchema, z.object({ url: z.string().trim().min(1).max(2000), match: z.enum(['exact', 'contains']).default('contains'), timeoutMs: z.number().int().min(1000).max(30000).default(15000) }).strict()]);
export type WaitUntil = z.infer<typeof browserWaitUntilSchema>;
export const WAIT_UNTIL_DESCRIPTION = ' Optional waitUntil:{text:"Connected"} polls fresh reads for up to 15 seconds (timeoutMs:1000..30000). Matching is case-insensitive and exact by default; match:"contains" is optional. state:"absent" waits for text to disappear and requires complete observation coverage. Choose a specific positive status observed in the app where possible; "Not connected" is not "Connected". Only the final snapshot is returned. Check wait.matched; wait.timedOut means the outcome is unverified, not completed. Waiting never repeats an input action.';
export interface WaitResult {
  matched: boolean;
  timedOut: boolean;
  condition: WaitUntil;
  elapsedMs: number;
  polls: number;
  observationComplete: boolean;
  transitionObserved?: boolean;
  evidence?: string;
  notice: string;
}

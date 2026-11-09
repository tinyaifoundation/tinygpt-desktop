import { z } from 'zod';

export const onboardingSchema = z.object({
  version: z.literal(1),
  step: z.number().int().min(0).max(3),
  status: z.enum(['in-progress', 'completed', 'skipped']),
}).strict();
export type OnboardingState = z.infer<typeof onboardingSchema>;

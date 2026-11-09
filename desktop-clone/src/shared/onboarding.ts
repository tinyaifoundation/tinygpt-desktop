import { z } from 'zod';

export const onboardingSchema = z.object({
  version: z.literal(2),
  step: z.number().int().min(0).max(4),
  status: z.enum(['in-progress', 'completed', 'skipped']),
}).strict();
export type OnboardingState = z.infer<typeof onboardingSchema>;
const previousOnboardingSchema = onboardingSchema.extend({ version: z.literal(1), step: z.number().int().min(0).max(3) });
export function readOnboardingState(value: unknown): OnboardingState {
  const previous = previousOnboardingSchema.safeParse(value);
  if (previous.success) return { ...previous.data, version: 2, step: previous.data.step === 3 ? 4 : previous.data.step };
  return onboardingSchema.parse(value);
}

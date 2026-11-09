import { z } from 'zod';
import type { OpenRouterAccount } from '../shared/contracts';
import { boundedJson } from './inference-discovery';

const keySchema = z.object({ data: z.object({ is_free_tier: z.boolean(), limit_remaining: z.number().finite().nullable().optional() }) });
const creditsSchema = z.object({ data: z.object({ total_credits: z.number().finite(), total_usage: z.number().finite() }) });

// A key cap is not the account balance; a previously funded account may be empty.
// PKCE keys usually cannot read /credits, which requires a management key.
export async function openRouterAccount(secret: string, request: typeof fetch = fetch): Promise<OpenRouterAccount> {
  const options = { headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(10000) };
  let key: z.infer<typeof keySchema>['data'];
  try { key = keySchema.parse(await boundedJson('https://openrouter.ai/api/v1/key', options, request)).data; }
  catch { throw new Error('OpenRouter could not verify this key. Check your connection or sign in again.'); }
  const base = { keyRemaining: key.limit_remaining, recommendedAccess: 'free' as const };
  if (key.limit_remaining != null && key.limit_remaining <= 0) return { ...base, status: 'exhausted' };
  if (key.is_free_tier) return { ...base, status: 'free' };
  try {
    const credits = creditsSchema.parse(await boundedJson('https://openrouter.ai/api/v1/credits', options, request)).data;
    const balance = Math.max(0, credits.total_credits - credits.total_usage);
    return { ...base, balance, status: balance > 0 ? 'funded' : 'exhausted', recommendedAccess: balance > 0 ? 'paid' : 'free' };
  } catch { return { ...base, status: 'unknown' }; }
}

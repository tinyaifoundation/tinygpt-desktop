import { describe, expect, it, vi } from 'vitest';
import { openRouterAccount } from '../src/core/openrouter-account';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

describe('OpenRouter account access defaults', () => {
  it('defaults never-funded accounts to free without requesting a balance', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ data: { is_free_tier: true, limit_remaining: null, label: 'private-label' } }));
    const account = await openRouterAccount('private-key', request);
    expect(account).toEqual({ status: 'free', recommendedAccess: 'free', keyRemaining: null });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(account)).not.toContain('private');
  });
  it('does not mistake a positive key cap or paid-account history for current funds', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ data: { is_free_tier: false, limit_remaining: 100 } })).mockResolvedValueOnce(json({}, 403));
    expect(await openRouterAccount('key', request)).toEqual({ status: 'unknown', recommendedAccess: 'free', keyRemaining: 100 });
  });
  it('defaults to paid only when a positive account balance is confirmed', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ data: { is_free_tier: false, limit_remaining: null } })).mockResolvedValueOnce(json({ data: { total_credits: 25, total_usage: 4 } }));
    expect(await openRouterAccount('key', request)).toEqual({ status: 'funded', recommendedAccess: 'paid', balance: 21, keyRemaining: null });
    expect(request.mock.calls.map(([url]) => url)).toEqual(['https://openrouter.ai/api/v1/key', 'https://openrouter.ai/api/v1/credits']);
    expect(request.mock.calls.every(([, options]) => options?.redirect === 'error')).toBe(true);
  });
  it.each([0, -2])('does not enable paid access with an exhausted key cap of %s', async remaining => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ data: { is_free_tier: false, limit_remaining: remaining } }));
    expect(await openRouterAccount('key', request)).toMatchObject({ status: 'exhausted', recommendedAccess: 'free' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([25, 26])('uses free access for zero or negative balances', async usage => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ data: { is_free_tier: false } })).mockResolvedValueOnce(json({ data: { total_credits: 25, total_usage: usage } }));
    expect(await openRouterAccount('key', request)).toMatchObject({ status: 'exhausted', recommendedAccess: 'free', balance: 0 });
  });
  it('keeps verification successful when optional balance information is unavailable or malformed', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ data: { is_free_tier: false } })).mockResolvedValueOnce(json({ data: { total_credits: 'unknown', total_usage: 0 } }));
    expect(await openRouterAccount('key', request)).toMatchObject({ status: 'unknown', recommendedAccess: 'free' });
  });
  it('rejects invalid keys without exposing upstream response text', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ error: 'secret echoed upstream' }, 401));
    await expect(openRouterAccount('key', request)).rejects.toThrow('OpenRouter could not verify this key.');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it } from 'vitest';
import { ConnectorClient } from '../src/main/connector-tools';
import { connectorFailure } from '../src/main/connector-errors';
import { mailPreview, boundedMailMetadata } from '../src/main/gmail-content';

const plain = (text: string) => ({ mimeType: 'text/plain', body: { data: Buffer.from(text).toString('base64url') } });
describe('Gmail triage payloads', () => {
  it('searches metadata in bounded parallel batches, preserving page tokens and per-message failures', async () => {
    let active = 0, peak = 0; const paths: string[] = [];
    const request: typeof fetch = async (address, options) => {
      const url = new URL(String(address)); paths.push(url.pathname + url.search); expect(options?.method).toBe('GET');
      if (url.pathname.endsWith('/messages')) { expect(url.searchParams.get('q')).toBe('in:inbox newer_than:2d'); expect(url.searchParams.get('pageToken')).toBe('opaque-next'); return Response.json({ messages: Array.from({ length: 20 }, (_, i) => ({ id: `mail${i}` })), nextPageToken: 'remaining', resultSizeEstimate: 50 }); }
      expect(url.searchParams.get('format')).toBe('metadata'); expect(url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'Subject', 'Date']);
      active++; peak = Math.max(peak, active); await new Promise(done => setTimeout(done, 2)); active--;
      const id = url.pathname.split('/').at(-1)!;
      return id === 'mail7' ? new Response('secret-provider-error', { status: 404 }) : Response.json({ id, snippet: 'A short preview', labelIds: ['CATEGORY_PROMOTIONS'], payload: { headers: [{ name: 'Subject', value: 'Newsletter' }, { name: 'From', value: 'Example sender' }] } });
    };
    const client = new ConnectorClient('gmail', () => 'fixture-token', request); const tool = client.tools().find(tool => tool.name === 'search_mail')!;
    const result = await tool.run(tool.schema.parse({ query: 'in:inbox newer_than:2d', pageToken: 'opaque-next' }) as any, new AbortController().signal) as any;
    expect(paths).toHaveLength(21); expect(peak).toBe(4); expect(result.nextPageToken).toBe('remaining'); expect(result.partial).toBe(true);
    expect(result.messages).toHaveLength(20); expect(result.messages[0]).toMatchObject({ id: 'mail0', subject: 'Newsletter', from: 'Example sender', labelIds: ['CATEGORY_PROMOTIONS'] });
    expect(result.pageCounts).toEqual({ returned: 20, metadataFailed: 1, labels: { CATEGORY_PROMOTIONS: 19 } });
    expect(result.messages[7]).toMatchObject({ id: 'mail7', code: 'NOT_FOUND' }); expect(JSON.stringify(result)).not.toContain('secret-provider-error'); expect(JSON.stringify(result).length).toBeLessThan(24000);
  });
  it('replaces tracking noise with stable link references and retrieves exact requested URLs without fetching them', () => {
    const urls = Array.from({ length: 60 }, (_, i) => `https://tracker.example/click/${i}?tracking=${'abcdef019283'.repeat(45)}`);
    const body = 'Please review the proposal by Friday.\n' + urls.map(url => `Read more ${url}`).join('\n');
    const value = { payload: plain(body) }; const preview = mailPreview(value);
    expect(preview.text).toContain('Please review the proposal by Friday.'); expect(preview.text).toContain('[link 1: tracker.example]'); expect(preview.text).not.toContain('tracking=');
    expect(preview.text.length).toBeLessThan(body.length / 5); expect(preview.linkCount).toBe(60); expect(preview).not.toHaveProperty('links');
    expect(mailPreview(value, 0, 6000, [2]).links).toEqual([{ id: 2, url: urls[1] }]);
  });
  it('provides accurate text pagination and prefers plain alternatives without duplicating HTML', () => {
    const body = 'Proposal details. '.repeat(1000); const value = { payload: { mimeType: 'multipart/alternative', parts: [plain(body), { mimeType: 'text/html', body: { data: Buffer.from('<p>WRONG DUPLICATE</p>').toString('base64url') } }] } };
    const first = mailPreview(value, 0, 500); expect(first.truncated).toBe(true); expect(first.nextOffset).toBe(500);
    const second = mailPreview(value, first.nextOffset, 500); expect(first.text + second.text).toBe(body.trim().slice(0, 1000)); expect(first.text).not.toContain('WRONG DUPLICATE');
  });
  it('bounds explicit URL requests without shortening an exact URL into a broken one', () => {
    const urls = Array.from({ length: 5 }, (_, i) => `https://example.org/${i}?token=${'a'.repeat(2300)}`);
    const value = { payload: plain('Actionable details. '.repeat(500) + urls.join('\n')) };
    const preview = mailPreview(value, 0, 6000, [1, 2, 3, 4, 5]);
    expect(preview.text).toHaveLength(2000); expect(preview.nextOffset).toBe(2000);
    expect(preview.links?.filter(link => 'url' in link)).toEqual([{ id: 1, url: urls[0] }, { id: 2, url: urls[1] }]);
    expect(preview.links?.[2]).toEqual({ id: 3, unavailable: true }); expect(JSON.stringify(preview).length).toBeLessThan(8000);
  });
  it('reads HTML-only mail as text without scripts, styles, remote media or hidden head content', () => {
    const html = '<head><style>NO STYLE</style>NO HEAD</head><script>NO SCRIPT</script><p>Invoice &amp; amount &#36;10</p><a href="https://example.org/pay?tracking=opaque">Open invoice</a><img src="https://remote.invalid/pixel">';
    const preview = mailPreview({ payload: { mimeType: 'text/html', body: { data: Buffer.from(html).toString('base64url') } } });
    expect(preview.text).toContain('Invoice & amount $10'); expect(preview.text).toContain('Open invoice [link 1: example.org]'); expect(preview.text).not.toMatch(/NO |remote.invalid|tracking=/);
  });
  it('keeps every opaque message ID even when large metadata needs trimming', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: `mail${i}` + 'x'.repeat(190), threadId: 't'.repeat(200), subject: 's'.repeat(200), from: 'f'.repeat(180), snippet: 'p'.repeat(240), labelIds: Array(8).fill('l'.repeat(64)), url: 'https://mail.google.com/' + 'u'.repeat(200) }));
    const bounded = boundedMailMetadata(rows); expect(JSON.stringify(bounded).length).toBeLessThan(11000); expect(bounded.map(row => row.id)).toEqual(rows.map(row => row.id));
  });
  it.each([[401, 'AUTHENTICATION_REQUIRED'], [403, 'PERMISSION_DENIED'], [404, 'NOT_FOUND'], [429, 'RATE_LIMITED']])('preserves safe error classification for HTTP %s', async (status, code) => {
    const client = new ConnectorClient('gmail', () => 'vault-secret', async () => new Response('private-provider-body vault-secret', { status: Number(status), headers: { 'retry-after': '25' } }));
    try { await client.health(new AbortController().signal); throw Error('Expected provider refusal'); } catch (error) { const value = connectorFailure(error); expect(value.code).toBe(code); expect(JSON.stringify(value)).not.toMatch(/vault-secret|private-provider-body/); }
  });
  it('refuses a mismatched message response rather than associating another email with the requested ID', async () => {
    const client = new ConnectorClient('gmail', () => 'fixture', async () => Response.json({ id: 'different-mail', payload: plain('Wrong content') }));
    const tool = client.tools().find(tool => tool.name === 'read_mail')!;
    await expect(tool.run({ messageId: 'requested-mail' }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});

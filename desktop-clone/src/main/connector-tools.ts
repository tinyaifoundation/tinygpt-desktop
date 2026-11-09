import { z } from 'zod';
import type { ExtensionToolDefinition } from '../shared/plugins';
import type { PluginResource, ConnectorKind } from '../shared/plugins';
import { ConnectorRequestError, connectorFailure } from './connector-errors';
import { boundedMailMetadata, mailMetadata, mailPreview, mailEvidenceNote, type GmailMessage } from './gmail-content';

export interface ConnectorTool { name: string; label: string; description: string; category: ExtensionToolDefinition['category']; schema: z.ZodType; run(input: Record<string, unknown>, signal: AbortSignal): Promise<unknown> }
const repository = z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/).max(240).refine(value => !['.', '..'].includes(value.split('/')[1]));
const query = z.string().trim().min(1).max(500);
const id = z.string().regex(/^[A-Za-z0-9_-]+$/).max(200);
const calendarId = z.string().trim().min(1).max(300);
const calendarRange = z.object({ timeMin: z.iso.datetime({ offset: true }), timeMax: z.iso.datetime({ offset: true }) }).refine(value => Date.parse(value.timeMin) < Date.parse(value.timeMax), 'Choose an end time after the start time.');
export class ConnectorClient {
  constructor(readonly kind: ConnectorKind, private token: () => string | undefined | Promise<string | undefined>, private request: typeof fetch = fetch, private scopes: () => string | undefined = () => undefined) {}
  private sendMail(to: string, subject: string, text: string, signal: AbortSignal) {
    return this.api('https://gmail.googleapis.com', '/gmail/v1/users/me/messages/send', signal, 'POST', { raw: Buffer.from(`To: ${to}\r\nSubject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(text).toString('base64')}`).toString('base64url') });
  }
  private async api(base: string, path: string, signal: AbortSignal, method = 'GET', body?: unknown): Promise<unknown> {
    const token = await this.token(); signal.throwIfAborted(); if (!token) throw new Error('Add a connector token before connecting.');
    const url = new URL(path, base); if (url.origin !== new URL(base).origin) throw new Error('Unexpected connector destination.');
    const response = await this.request(url, { method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...(this.kind === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const retry = Number(response.headers.get('retry-after'));
      throw new ConnectorRequestError(response.status === 404 ? 'NOT_FOUND' : response.status === 401 ? 'AUTHENTICATION_REQUIRED' : response.status === 403 ? 'PERMISSION_DENIED' : response.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE', response.status, Number.isFinite(retry) && retry > 0 ? Math.min(3600, Math.ceil(retry)) : undefined);
    }
    // Bound responses before parsing; never retain an unbounded service payload.
    const reader = response.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    if (reader) { try { while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength; if (size > 1024 * 1024) throw new Error('Connector response exceeds 1 MB. Narrow the request.'); chunks.push(item.value); } } finally { await reader.cancel().catch(() => {}); } }
    const text = Buffer.concat(chunks).toString('utf8');
    const result = response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : { text };
    if (this.kind === 'slack' && result.ok === false) throw new Error('Slack refused this action. Check token scopes, channel membership, and workspace policy.');
    return result;
  }
  private async searchMail(input: Record<string, unknown>, signal: AbortSignal) {
    const params = new URLSearchParams({ maxResults: '20', q: String(input.query), fields: 'messages(id,threadId),nextPageToken,resultSizeEstimate', ...(input.pageToken ? { pageToken: String(input.pageToken) } : {}) });
    const page = await this.api('https://gmail.googleapis.com', `/gmail/v1/users/me/messages?${params}`, signal) as { messages?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number };
    const ids = (page.messages ?? []).slice(0, 20); const rows: (ReturnType<typeof mailMetadata> | { id: string; error: string; code: string })[] = new Array(ids.length); let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (cursor < ids.length) {
        signal.throwIfAborted(); const index = cursor++; const messageId = id.parse(ids[index].id);
        try { const metadata = await this.api('https://gmail.googleapis.com', `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&fields=id,threadId,snippet,labelIds,internalDate,payload(headers)`, signal) as GmailMessage; rows[index] = mailMetadata(metadata, messageId); }
        catch (error) { signal.throwIfAborted(); rows[index] = { id: messageId, ...connectorFailure(error) }; }
      }
    }));
    const labelCounts: Record<string, number> = {};
    for (const row of rows) if ('labelIds' in row) for (const label of new Set(row.labelIds.filter(label => ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'].includes(label)))) labelCounts[label] = (labelCounts[label] ?? 0) + 1;
    return { messages: boundedMailMetadata(rows), pageCounts: { returned: rows.length, metadataFailed: rows.filter(row => 'error' in row).length, labels: labelCounts }, nextPageToken: page.nextPageToken, resultSizeEstimate: page.resultSizeEstimate, partial: !!page.nextPageToken || rows.some(row => 'error' in row), note: `${mailEvidenceNote} Triage this metadata first. Open bodies only when needed; use pageToken for the next page. resultSizeEstimate is approximate. pageCounts covers this page only; labels may overlap.` };
  }
  async health(signal: AbortSignal): Promise<{ name: string; email?: string }> {
    if (this.kind === 'gcalendar') { const value = await this.api('https://www.googleapis.com', '/calendar/v3/users/me/calendarList?maxResults=1', signal) as { items?: { summary?: string; id?: string }[] }; return { name: value.items?.[0]?.summary ?? 'Google Calendar account' }; }
    const result = await (this.kind === 'github' ? this.api('https://api.github.com', '/user', signal) : this.kind === 'gmail' ? this.api('https://gmail.googleapis.com', '/gmail/v1/users/me/profile', signal) : this.kind === 'google' || this.kind === 'gdrive' ? this.api('https://www.googleapis.com', '/drive/v3/about?fields=user', signal) : this.api('https://slack.com', '/api/auth.test', signal, 'POST', {})) as { login?: string; emailAddress?: string; user?: { displayName?: string; emailAddress?: string } | string; team?: string };
    return { name: (this.kind === 'github' ? result.login : this.kind === 'gmail' ? result.emailAddress : typeof result.user === 'object' ? result.user.displayName : result.team) ?? 'Connected account', ...(this.kind === 'gmail' ? { email: result.emailAddress } : typeof result.user === 'object' ? { email: result.user.emailAddress } : {}) };
  }
  async resources(query: string, signal: AbortSignal): Promise<PluginResource[]> {
    if (this.kind === 'gmail' || this.kind === 'gcalendar') return [];
    if (this.kind === 'github') { const repositories = await this.api('https://api.github.com', '/user/repos?per_page=30&sort=updated', signal) as { full_name: string }[]; return repositories.filter(repo => repo.full_name.toLowerCase().includes(query.toLowerCase())).map(repo => ({ uri: `github:${repo.full_name}/README.md`, name: `${repo.full_name} README`, mimeType: 'text/markdown' })); }
    if (this.kind === 'google' || this.kind === 'gdrive') { const files = await this.api('https://www.googleapis.com', `/drive/v3/files?pageSize=30&fields=files(id,name,mimeType)&q=${encodeURIComponent(`trashed=false and mimeType='application/vnd.google-apps.document'${query ? ` and name contains '${query.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'` : ''}`)}`, signal) as { files: { id: string; name: string }[] }; return files.files.map(file => ({ uri: `google-doc:${file.id}`, name: file.name, mimeType: 'text/plain' })); }
    const channels = await this.api('https://slack.com', '/api/conversations.list?limit=100&exclude_archived=true', signal) as { channels: { id: string; name: string }[] }; return channels.channels.filter(channel => channel.name.toLowerCase().includes(query.toLowerCase())).map(channel => ({ uri: `slack-channel:${channel.id}`, name: `#${channel.name}`, mimeType: 'text/plain' }));
  }
  async readResource(uri: string, signal: AbortSignal): Promise<string> {
    if (this.kind === 'github' && /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/README\.md$/.test(uri)) { const result = await this.api('https://api.github.com', `/repos/${uri.slice(7).replace('/README.md', '/readme')}`, signal) as { content?: string; encoding?: string; html_url?: string }; if (result.encoding !== 'base64' || !result.content) throw new Error('This resource has no readable text.'); return `Source: ${result.html_url ?? uri}\n\n${Buffer.from(result.content, 'base64').toString('utf8')}`; }
    if ((this.kind === 'google' || this.kind === 'gdrive') && /^google-doc:[A-Za-z0-9_-]+$/.test(uri)) { const result = await this.api('https://www.googleapis.com', `/drive/v3/files/${uri.slice(11)}/export?mimeType=text%2Fplain`, signal) as { text?: string }; return `Source: https://docs.google.com/document/d/${uri.slice(11)}\n\n${result.text ?? ''}`; }
    if (this.kind === 'slack' && /^slack-channel:[A-Za-z0-9_-]+$/.test(uri)) { const result = await this.api('https://slack.com', `/api/conversations.history?limit=100&channel=${uri.slice(14)}`, signal) as { messages: { ts: string; text: string; user?: string }[] }; return result.messages.map(message => `${message.ts} ${message.user ?? ''}: ${message.text}`).join('\n\n'); }
    throw new Error('This resource does not belong to the connector.');
  }
  tools(): ConnectorTool[] {
    const tool = (name: string, label: string, description: string, category: ConnectorTool['category'], schema: z.ZodType, run: ConnectorTool['run']): ConnectorTool => ({ name, label, description, category, schema, run });
    if (this.kind === 'gcalendar') return [
      tool('list_calendars', 'List Google calendars', 'List up to 30 calendars with their IDs, access roles and time zones. Follow nextPageToken for further results.', 'read', z.object({ pageToken: z.string().max(2000).optional() }).strict(), (input, signal) => this.api('https://www.googleapis.com', `/calendar/v3/users/me/calendarList?maxResults=30${input.pageToken ? `&pageToken=${encodeURIComponent(String(input.pageToken))}` : ''}`, signal)),
      tool('list_events', 'Read Google Calendar events', 'Read up to 50 events for an explicit date range, expanding recurring events. Timestamps require a timezone offset. Preserve nextPageToken and report partial results.', 'read', calendarRange.safeExtend({ calendarId: calendarId.default('primary'), query: z.string().max(500).optional(), pageToken: z.string().max(2000).optional() }).strict(), (input, signal) => this.api('https://www.googleapis.com', `/calendar/v3/calendars/${encodeURIComponent(String(input.calendarId))}/events?${new URLSearchParams({ maxResults: '50', singleEvents: 'true', orderBy: 'startTime', timeMin: String(input.timeMin), timeMax: String(input.timeMax), ...(input.query ? { q: String(input.query) } : {}), ...(input.pageToken ? { pageToken: String(input.pageToken) } : {}) })}`, signal)),
      tool('read_event', 'Read Google Calendar event', 'Read an accessible event by its calendar and event IDs.', 'read', z.object({ calendarId: calendarId.default('primary'), eventId: id }).strict(), (input, signal) => this.api('https://www.googleapis.com', `/calendar/v3/calendars/${encodeURIComponent(String(input.calendarId))}/events/${input.eventId}`, signal)),
      tool('check_availability', 'Check calendar availability', 'Read free/busy intervals for up to ten calendar IDs over an explicit timezone-aware range. Inspect per-calendar errors; missing access is not free time.', 'read', calendarRange.safeExtend({ calendars: z.array(calendarId).min(1).max(10) }).strict(), (input, signal) => this.api('https://www.googleapis.com', '/calendar/v3/freeBusy', signal, 'POST', { timeMin: input.timeMin, timeMax: input.timeMax, items: (input.calendars as string[]).map(id => ({ id })) })),
    ];
    if (this.kind === 'github') return [
      tool('list_repositories', 'List repositories', 'List up to 30 repositories accessible to the connected GitHub identity.', 'read', z.object({}).strict(), (_, signal) => this.api('https://api.github.com', '/user/repos?per_page=30&sort=updated', signal)),
      tool('read_file', 'Read repository file', 'Read a file from a repository. The token must grant access; response may contain base64 encoded text.', 'read', z.object({ repository, path: z.string().min(1).max(1000), ref: z.string().max(200).optional() }).strict(), (input, signal) => this.api('https://api.github.com', `/repos/${input.repository}/contents/${String(input.path).split('/').map(encodeURIComponent).join('/')}?${input.ref ? `ref=${encodeURIComponent(String(input.ref))}` : ''}`, signal)),
      tool('list_issues', 'List issues', 'List up to 30 open issues from a repository.', 'read', z.object({ repository }).strict(), (input, signal) => this.api('https://api.github.com', `/repos/${input.repository}/issues?per_page=30&state=open`, signal)),
      tool('create_issue', 'Create issue', 'Create a GitHub issue. This publishes externally and requires the configured approval.', 'write', z.object({ repository, title: z.string().min(1).max(200), body: z.string().max(20000) }).strict(), (input, signal) => this.api('https://api.github.com', `/repos/${input.repository}/issues`, signal, 'POST', { title: input.title, body: input.body })),
    ];
    if (this.kind === 'slack') return [
      tool('search_messages', 'Search Slack', 'Search up to 20 Slack messages available to a user token with search:read.', 'read', z.object({ query }).strict(), (input, signal) => this.api('https://slack.com', `/api/search.messages?count=20&query=${encodeURIComponent(String(input.query))}`, signal)),
      tool('read_channel', 'Read Slack channel', 'Read up to 30 recent messages. Requires channel history scope and membership.', 'read', z.object({ channel: id }).strict(), (input, signal) => this.api('https://slack.com', `/api/conversations.history?limit=30&channel=${input.channel}`, signal)),
      tool('send_message', 'Send Slack message', 'Publish a Slack message to a channel. Requires chat:write and configured approval.', 'send', z.object({ channel: id, text: z.string().min(1).max(12000) }).strict(), (input, signal) => this.api('https://slack.com', '/api/chat.postMessage', signal, 'POST', input)),
    ];
    const googleTools = [
      tool('search_drive', 'Search Google Drive', 'Find up to 30 accessible Drive files using a Drive query. Requires drive.readonly or a suitable narrower scope.', 'read', z.object({ query }).strict(), (input, signal) => this.api('https://www.googleapis.com', `/drive/v3/files?pageSize=30&fields=files(id,name,mimeType,modifiedTime,webViewLink)&q=${encodeURIComponent(String(input.query))}`, signal)),
      tool('read_document', 'Read Google document', 'Export an accessible Google Doc as plain text.', 'read', z.object({ fileId: id }).strict(), (input, signal) => this.api('https://www.googleapis.com', `/drive/v3/files/${input.fileId}/export?mimeType=text%2Fplain`, signal)),
      tool('get_mail_profile', 'Read connected Gmail account', 'Get the connected Gmail account emailAddress. Use this to resolve "me" or "myself" before addressing an email; never guess the address. Does not send mail.', 'read', z.object({}).strict(), (_input, signal) => this.api('https://gmail.googleapis.com', '/gmail/v1/users/me/profile', signal)),
      tool('search_mail', 'Search Gmail', 'Search up to 20 messages with sender, subject, date, labels and snippets. For inbox triage use in:inbox and the requested date range (e.g. newer_than:2d). Classify metadata before opening bodies; skip obvious marketing when requested. Preserve exact IDs and follow nextPageToken using pageToken; report partial coverage.', 'read', z.object({ query, pageToken: z.string().min(1).max(2000).optional() }).strict(), (input, signal) => this.searchMail(input, signal)),
      tool('read_mail', 'Read Gmail message', 'Read a bounded, cleaned preview by exact messageId from search or the user. Tracking URLs become link references. Follow nextOffset with offset for more body text; request up to five specific linkIds for exact URLs. Do not guess IDs or claim a preview is the entire message.', 'read', z.object({ messageId: id, offset: z.number().int().min(0).max(1000000).default(0), maxCharacters: z.number().int().min(200).max(6000).default(6000), linkIds: z.array(z.number().int().min(1).max(5000)).max(5).default([]) }).strict(), async (input, signal) => { const value = await this.api('https://gmail.googleapis.com', `/gmail/v1/users/me/messages/${encodeURIComponent(String(input.messageId))}?format=full`, signal) as GmailMessage; const metadata = mailMetadata(value, String(input.messageId)); return { ...metadata, headers: value.payload?.headers?.filter(header => ['from', 'to', 'subject', 'date'].includes(header.name.toLowerCase())).slice(0, 4).map(header => ({ name: header.name, value: header.value.slice(0, 500) })), ...mailPreview(value, Number(input.offset ?? 0), Number(input.maxCharacters ?? 6000), input.linkIds as number[] | undefined) }; }),
      tool('send_mail_to_self', 'Email my connected Gmail account', 'Send an email to the currently connected Gmail account. Use this for "email me/myself". No recipient parameter: the connector looks up the real account address itself. Call directly with subject and text; TinyGPT asks for required send approval before execution. Requires gmail.send.', 'send', z.object({ subject: z.string().min(1).max(200).refine(value => !/[\r\n]/.test(value)), text: z.string().min(1).max(20000) }).strict(), async (input, signal) => {
        const profile = await this.api('https://gmail.googleapis.com', '/gmail/v1/users/me/profile', signal) as { emailAddress?: string };
        const to = z.email().max(254).parse(profile.emailAddress); const result = await this.sendMail(to, String(input.subject), String(input.text), signal) as Record<string, unknown>;
        return { ...result, to };
      }),
      tool('send_mail', 'Send Gmail message', 'Send a plain-text Gmail email to an explicit address supplied by the user. For "email me/myself", use send_mail_to_self instead. Call directly with to, subject and text: TinyGPT pauses for required send approval before execution. request_plugin_connection is not an approval tool. Requires gmail.send.', 'send', z.object({ to: z.email().max(254), subject: z.string().min(1).max(200).refine(value => !/[\r\n]/.test(value)), text: z.string().min(1).max(20000) }).strict(), (input, signal) => this.sendMail(String(input.to), String(input.subject), String(input.text), signal)),
    ];
    const mailTool = (name: string) => name.endsWith('_mail') || name === 'get_mail_profile' || name === 'send_mail_to_self';
    return googleTools.filter(tool => (this.kind === 'gmail' ? mailTool(tool.name) : this.kind === 'gdrive' ? !mailTool(tool.name) : true) && (!['send_mail', 'send_mail_to_self'].includes(tool.name) || this.scopes() === undefined || this.scopes()!.split(' ').includes('https://www.googleapis.com/auth/gmail.send')));
  }
}

// Test-only fake Gmail service. Never imported by production.
const nativeFetch = global.fetch;
global.gmailFixture = { calls: [], sent: [] };
global.fetch = async (resource, options) => {
  const url = new URL(String(resource));
  if (url.hostname !== 'gmail.googleapis.com') return nativeFetch(resource, options);
  const auth = new Headers(options?.headers).get('Authorization');
  if (auth !== 'Bearer gmail-fixture-token') throw Error('Unexpected Gmail fixture identity.');
  global.gmailFixture.calls.push({ path: url.pathname, method: options?.method ?? 'GET' });
  const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  if (url.pathname.endsWith('/profile')) return json({ emailAddress: 'self@example.test', messagesTotal: 5, threadsTotal: 3 });
  if (url.pathname.endsWith('/messages/send') && options?.method === 'POST') { const body = JSON.parse(options.body); global.gmailFixture.sent.push(Buffer.from(body.raw, 'base64url').toString()); return json({ id: 'fixture-sent-1', threadId: 'fixture-thread-1', labelIds: ['SENT'] }); }
  throw Error('Unexpected Gmail fixture request: ' + url.pathname);
};
require('./chat-smoke-main.cjs');

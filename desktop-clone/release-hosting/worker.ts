type Release = { key: string; filename: string; sha256?: string };
type StoredObject = { size: number; httpEtag: string; body: ReadableStream; customMetadata?: { sha256?: string }; range?: { offset?: number; length?: number }; writeHttpMetadata(headers: Headers): void };
type Env = {
  RELEASES: { get(key: string, options?: { range: Headers }): Promise<StoredObject | null>; head(key: string): Promise<Pick<StoredObject, 'size'> | null> };
  DOWNLOAD_PATH?: string; OBJECT_KEY?: string; EXTRA_RELEASES?: string;
};
function releaseFor(path: string, env: Env): Release | undefined {
  if (path === env.DOWNLOAD_PATH && env.OBJECT_KEY) return { key: env.OBJECT_KEY, filename: 'TinyGPT Setup 0.1.0-prebeta.1.exe' };
  const model = /^\/assets\/sha256\/([a-f0-9]{64})$/.exec(path);
  if (model) return { key: `assets/sha256/${model[1]}`, filename: model[1], sha256: model[1] };
  if (path === '/updates/prebeta/win-x64/prebeta.yml') return { key: 'updates/prebeta/win-x64/prebeta.yml', filename: 'prebeta.yml' };
  const releases = JSON.parse(env.EXTRA_RELEASES || '{}') as Record<string, Release>;
  if (!Object.hasOwn(releases, path)) {
    const release = /^\/releases\/(\d+\.\d+\.\d+-prebeta\.\d+)\/([\w.-]+\.(?:exe|7z|blockmap|txt|yml))$/.exec(path);
    if (release && !release[2].includes('..')) return { key: `releases/${release[1]}/${release[2]}`, filename: release[2] };
    return;
  }
  const release = releases[path];
  if (!release || !release.key || !/^[\w .-]+$/.test(release.filename)) return;
  return release;
}
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Not found', { status: 404 });
    const release = releaseFor(new URL(request.url).pathname, env);
    if (!release) return new Response('Not found', { status: 404 });
    const invalidRange = async () => {
      const object = await env.RELEASES.head(release.key);
      return new Response(null, { status: object ? 416 : 404, headers: object ? { 'Content-Range': `bytes */${object.size}` } : undefined });
    };
    const range = request.headers.get('Range');
    if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) return invalidRange();
    let object: StoredObject | null;
    try { object = await env.RELEASES.get(release.key, { range: request.headers }); }
    catch (error) { if (range) return invalidRange(); throw error; }
    if (!object) return new Response('Not found', { status: 404 });
    const headers = new Headers(); object.writeHttpMetadata(headers);
    headers.set('Content-Type', release.filename.endsWith('.yml') ? 'application/yaml; charset=utf-8' : release.filename.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    headers.set('Content-Disposition', `attachment; filename="${release.filename}"`);
    headers.set('ETag', object.httpEtag); headers.set('Accept-Ranges', 'bytes');
    headers.set('Cache-Control', 'private, max-age=0'); headers.set('X-Content-Type-Options', 'nosniff'); headers.set('X-Robots-Tag', 'noindex, nofollow');
    if (release.sha256 || object.customMetadata?.sha256) headers.set('X-Checksum-SHA256', release.sha256 || object.customMetadata!.sha256!);
    let status = 200, length = object.size;
    if (range && object.range?.length !== undefined && object.range.offset !== undefined) {
      status = 206; length = object.range.length;
      headers.set('Content-Range', `bytes ${object.range.offset}-${object.range.offset + length - 1}/${object.size}`);
    }
    headers.set('Content-Length', String(length));
    if (request.method === 'HEAD') { await object.body.cancel(); return new Response(null, { status, headers }); }
    return new Response(object.body, { status, headers });
  },
};

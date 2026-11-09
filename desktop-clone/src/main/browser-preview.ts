import { createServer } from 'node:http';
import { open, stat } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { scopedPath } from './files';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

/** Static local preview: no child process, package installation or directory listing. */
export async function serveBrowserPreview(workspace: string, requested: string, checkAccess: () => void = () => {}, allowMissingEntry = false) {
  checkAccess();
  let entry = await scopedPath(workspace, requested, allowMissingEntry);
  const info = await stat(entry).catch(error => { if (allowMissingEntry && error.code === 'ENOENT') return undefined; throw error; });
  if (info?.isDirectory()) entry = await scopedPath(workspace, relative(workspace, resolve(entry, 'index.html')), allowMissingEntry);
  if (!['.html', '.htm'].includes(extname(entry).toLowerCase()) || !allowMissingEntry && !(await stat(entry)).isFile()) throw new Error('Choose a static HTML file or a folder containing index.html. For a running app, use browser_open with its HTTP URL.');
  const webRoot = dirname(entry);
  let origin = '';
  const server = createServer(async (request, response) => {
    try {
      checkAccess();
      if (request.headers.host !== new URL(origin).host) { response.writeHead(403).end(); return; }
      if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(request.url ?? '/', origin).pathname);
      const candidate = resolve(webRoot, '.' + pathname);
      const path = await scopedPath(workspace, relative(workspace, candidate));
      const file = (await stat(path)).isDirectory() ? await scopedPath(workspace, relative(workspace, resolve(path, 'index.html'))) : path;
      const mime = types[extname(file).toLowerCase()];
      if (!mime) { response.writeHead(403).end(); return; }
      const handle = await open(file, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > 20_000_000) { response.writeHead(413).end(); return; }
        const body = request.method === 'HEAD' ? undefined : await handle.readFile();
        checkAccess();
        response.writeHead(200, { 'content-type': mime, 'content-length': info.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(body);
      } finally { await handle.close(); }
    } catch { response.writeHead(404, { 'cache-control': 'no-store' }).end('Preview file unavailable.'); }
  });
  await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', accept); });
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url: `${origin}/${encodeURIComponent(basename(entry))}`, async close() {
    server.closeAllConnections(); await new Promise<void>(accept => server.close(() => accept()));
  } };
}

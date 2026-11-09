import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveBrowserPreview } from '../src/main/browser-preview';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'tinygpt-preview-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist', 'assets'), { recursive: true });
  await writeFile(join(root, 'dist', 'index.html'), '<script src="/assets/app.js"></script>');
  await writeFile(join(root, 'dist', 'assets', 'app.js'), 'document.title = "Working app";');
  await writeFile(join(root, '.env'), 'private');
  return root;
}
it('starts an owned coding preview before index.html exists and serves the later build', async () => {
  const root = await fixture(), preview = await serveBrowserPreview(root, 'index.html', () => {}, true); cleanup.push(preview.close);
  expect((await fetch(preview.url)).status).toBe(404);
  await writeFile(join(root, 'index.html'), '<title>Built after preview startup</title>');
  expect(await (await fetch(preview.url)).text()).toContain('Built after preview startup');
});
it('serves current HTML and relative/root asset paths without caching, then releases its port', async () => {
  const root = await fixture(), preview = await serveBrowserPreview(root, 'dist'); cleanup.push(preview.close);
  const page = await fetch(preview.url); expect(page.headers.get('content-type')).toContain('text/html'); expect(page.headers.get('cache-control')).toBe('no-store');
  expect(await page.text()).toContain('/assets/app.js');
  expect(await (await fetch(new URL('/assets/app.js', preview.url))).text()).toContain('Working app');
  await writeFile(join(root, 'dist', 'index.html'), 'Updated'); expect(await (await fetch(preview.url)).text()).toBe('Updated');
  await preview.close(); await expect(fetch(preview.url)).rejects.toThrow();
});
it('rejects protected/outside files, non-static requests and revoked workspace access', async () => {
  const root = await fixture(); let allowed = true;
  const preview = await serveBrowserPreview(root, 'dist/index.html', () => { if (!allowed) throw Error('Revoked'); }); cleanup.push(preview.close);
  expect((await fetch(new URL('/%2e%2e%2f.env', preview.url))).status).toBe(404);
  expect((await fetch(preview.url, { method: 'POST' })).status).toBe(405);
  expect((await fetch(new URL('/assets/', preview.url))).status).toBe(404);
  await expect(serveBrowserPreview(root, '../outside.html')).rejects.toThrow();
  await expect(serveBrowserPreview(root, '.env')).rejects.toThrow();
  allowed = false; expect((await fetch(preview.url)).status).toBe(404);
});

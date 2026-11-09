import { expect, it } from 'vitest';
// @ts-expect-error Release helpers are plain Node ESM used by the Windows build workflow.
import { updateFeed } from '../scripts/release-metadata.mjs';
it('publishes a stable feed pointing only at immutable versioned release files', () => {
  const metadata = { version: '0.1.0-prebeta.3', path: 'setup.exe', files: [{ url: 'setup.exe', sha512: 'fixture' }], packages: { x64: { path: 'app.nsis.7z', sha512: 'payload', size: 3, blockMapSize: 1 } } };
  const feed = updateFeed(metadata, 'Release notes');
  expect(feed.files[0].url).toBe('https://downloads.tinygpt.org/releases/0.1.0-prebeta.3/setup.exe');
  expect(feed.packages.x64.path).toBe('https://downloads.tinygpt.org/releases/0.1.0-prebeta.3/app.nsis.7z');
  expect(feed.packages.x64.sha512).toBe('payload'); expect(feed.releaseNotes).toBe('Release notes');
  expect(() => updateFeed({ ...metadata, path: '../escape.exe' }, '')).toThrow();
  expect(() => updateFeed({ ...metadata, version: '1.0.0' }, '')).toThrow();
});

import { expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditArtifactWriter } from '../scripts/harness-audit-artifacts';

it('preserves every concurrent artifact write and leaves the last complete snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'audit-artifacts-'));
  try {
    const writer = new AuditArtifactWriter(root);
    await Promise.all(Array.from({ length: 60 }, (_, index) => writer.write('case/attempts.json', JSON.stringify({ index, text: 'snapshot'.repeat(2000) }))));
    expect(JSON.parse(await readFile(join(root, 'case/attempts.json'), 'utf8')).index).toBe(59);
    expect(await readdir(join(root, 'case'))).toEqual(['attempts.json']);
    await writer.write('case/attempts.json', JSON.stringify({ index: 60 }));
    expect(JSON.parse(await readFile(join(root, 'case/attempts.json'), 'utf8')).index).toBe(60);
  } finally { await rm(root, { recursive: true, force: true }); }
});

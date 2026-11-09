// Public-source catalog QA. Downloads verified original packages only; never
// installs them in the user's profile, runs upstream scripts, or reads accounts.
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { SkillPackages } from '../src/main/skill-packages';
import { skillCatalog } from '../src/shared/skill-catalog';
async function main() {
  const packages = new SkillPackages(resolve('artifacts/verified-skill-packages'));
  const results: { id: string; files?: number; bytes?: number; commit?: string; error?: string }[] = []; let index = 0;
  try {
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (index < skillCatalog.length) { const item = skillCatalog[index++];
        try { await packages.install(item); let bytes = 0; for (const file of item.source.files) bytes += (await packages.bytes(item.source, file)).length; results.push({ id: item.id, files: item.source.files.length, bytes, commit: item.source.commit }); console.log(`Verified ${item.title} (${item.source.files.length} original files)`); }
        catch (error) { results.push({ id: item.id, error: error instanceof Error ? error.message : 'Verification failed' }); }
      }
    }));
    await writeFile('artifacts/upstream-package-verification.json', JSON.stringify(results, null, 2));
    const failed = results.filter(result => result.error); console.log(JSON.stringify({ verified: results.length - failed.length, files: results.reduce((sum, result) => sum + (result.files ?? 0), 0), bytes: results.reduce((sum, result) => sum + (result.bytes ?? 0), 0), failed })); if (failed.length) process.exitCode = 1;
  } finally { packages.close(); }
}
void main().catch(error => { console.error(error.message); process.exitCode = 1; });

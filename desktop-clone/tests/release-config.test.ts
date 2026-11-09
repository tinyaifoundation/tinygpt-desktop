import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
const { releaseConfigurationIssues } = createRequire(import.meta.url)('../scripts/release-config.cjs');
const signing = { TINYGPT_PUBLISHER_NAME: 'Example Publisher', TINYGPT_SIGNING_ENDPOINT: 'https://eus.codesigning.azure.net', TINYGPT_SIGNING_ACCOUNT: 'example-account', TINYGPT_SIGNING_PROFILE: 'example-profile' };
it('requires signing for local releases and storage plus federation before CI builds', () => {
  expect(releaseConfigurationIssues({})).toHaveLength(4);
  expect(releaseConfigurationIssues(signing)).toEqual([]);
  expect(releaseConfigurationIssues(signing, true)).toContain('Set R2_SECRET_ACCESS_KEY.');
  expect(releaseConfigurationIssues(signing, true)).toContain('Set AZURE_CLIENT_ID.');
});
it('permits explicitly unsigned pre-beta builds while still requiring release authentication and storage in CI', () => {
  expect(releaseConfigurationIssues({ TINYGPT_RELEASE_SIGNING_MODE: 'unsigned' })).toEqual([]);
  const issues = releaseConfigurationIssues({ TINYGPT_RELEASE_SIGNING_MODE: 'unsigned' }, true);
  expect(issues).toContain('Set TINYGPT_UPDATE_PRIVATE_KEY.');
  expect(issues).toContain('Set R2_SECRET_ACCESS_KEY.');
  expect(issues).not.toContain('Set AZURE_CLIENT_ID.');
  expect(releaseConfigurationIssues({ TINYGPT_RELEASE_SIGNING_MODE: 'skip-everything' })).toContain('TINYGPT_RELEASE_SIGNING_MODE must be windows or unsigned.');
});
it('rejects an untrusted signing endpoint without disclosing configuration values', () => {
  const privateValue = 'https://evil.example/secret-value';
  const issues = releaseConfigurationIssues({ ...signing, TINYGPT_SIGNING_ENDPOINT: privateValue, AZURE_CLIENT_ID: 'private-identifier' }, true);
  expect(issues.join('\n')).toMatch(/Microsoft regional HTTPS/);
  expect(issues.join('\n')).toMatch(/AZURE_CLIENT_ID must be a GUID/);
  expect(issues.join('\n')).not.toContain('secret-value');
  expect(issues.join('\n')).not.toContain('private-identifier');
});

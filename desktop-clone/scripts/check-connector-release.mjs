import { readFile } from 'node:fs/promises';
const registrations = JSON.parse(await readFile(new URL('../src/main/connector-registrations.json', import.meta.url), 'utf8'));
const issues = [];
for (const [provider, config] of Object.entries(registrations)) {
  if (!config.clientId) issues.push(`${provider}: missing publisher registration`);
  if (config.releaseStatus !== 'production') issues.push(`${provider}: provider rollout is ${config.releaseStatus}; public release is not ready`);
  if (Object.keys(config).some(key => !['clientId', 'releaseStatus'].includes(key))) issues.push(`${provider}: only public registration identifiers belong in the shipped configuration`);
}
if (!registrations.google.clientId.endsWith('.apps.googleusercontent.com')) issues.push('google: expected a Desktop OAuth client ID');
if (!/^\d+\.\d+$/.test(registrations.slack.clientId)) issues.push('slack: invalid public client ID');
if (issues.length) { console.error(issues.join('\n')); process.exitCode = 1; }
else console.log('Publisher registrations are marked ready. Complete the live acceptance record in docs/CONNECTOR_PRODUCTION.md before shipping.');

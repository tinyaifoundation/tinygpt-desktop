// Shared by the build and the workflow preflight. Never include values in errors.
function releaseConfigurationIssues(env, ci = false) {
  const names = ['TINYGPT_PUBLISHER_NAME', 'TINYGPT_SIGNING_ENDPOINT', 'TINYGPT_SIGNING_ACCOUNT', 'TINYGPT_SIGNING_PROFILE'];
  if (ci) names.push('AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID', 'CLOUDFLARE_ACCOUNT_ID', 'R2_RELEASE_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY');
  const issues = names.filter(name => !env[name]?.trim()).map(name => `Set ${name}.`);
  const endpoint = env.TINYGPT_SIGNING_ENDPOINT?.trim();
  if (endpoint && !/^https:\/\/[a-z0-9]+\.codesigning\.azure\.net\/?$/.test(endpoint)) issues.push('TINYGPT_SIGNING_ENDPOINT must be a Microsoft regional HTTPS signing endpoint.');
  for (const name of ['TINYGPT_PUBLISHER_NAME', 'TINYGPT_SIGNING_ACCOUNT', 'TINYGPT_SIGNING_PROFILE']) {
    if (/[\r\n\0]/.test(env[name] || '')) issues.push(`${name} must be a single value.`);
  }
  if (ci) {
    for (const name of ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'AZURE_SUBSCRIPTION_ID']) {
      if (env[name]?.trim() && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(env[name].trim())) issues.push(`${name} must be a GUID.`);
    }
    if (env.CLOUDFLARE_ACCOUNT_ID?.trim() && !/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID.trim())) issues.push('CLOUDFLARE_ACCOUNT_ID must be a Cloudflare account identifier.');
  }
  return issues;
}
module.exports = { releaseConfigurationIssues };

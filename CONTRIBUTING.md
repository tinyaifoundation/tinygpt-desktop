# Contributing

Use the production app in desktop-clone/. Keep changes focused and describe behavior and verification in your pull request. Changes to settings, user-visible behavior, privacy, storage or limitations must update the bundled handbook and source mappings; read desktop-clone/knowledge/MAINTENANCE.md.

Run handbook:build after reviewing the affected articles, then handbook:check, the handbook tests, typecheck and tests relevant to your change. Include generated handbook JSON with its reviewed Markdown sources. Do not regenerate fingerprints just to silence a freshness error.

Use isolated synthetic profiles for tests. Never include real conversations, account data, API keys, credentials, personal file paths or provider responses in fixtures, screenshots or issues. Do not run live account tests with another person's credentials. Downloaded models and runtime archives belong in ignored caches, not Git.

By submitting original code, you offer that contribution under Apache-2.0. Preserve notices for adapted third-party code. Do not assume the source license covers model weights or branding.

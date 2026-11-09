# TinyGPT repository guidance

The production desktop app is in `desktop-clone/`. Root `src/` is an older implementation; verify changes against the production tree. Preserve unrelated working-copy changes.

## Bundled product handbook

Any change to user-visible features, settings, labels, navigation, defaults, permissions, privacy, storage, platform support or limitations must review and update `desktop-clone/knowledge/` in the same change. Use the current implementation as evidence, not historical README or roadmap claims.

Read `desktop-clone/knowledge/MAINTENANCE.md`. Update the relevant Markdown article and manifest source mappings, including new implementation files/features. The settings reference is generated from `src/renderer/lib/settings-search.ts`; maintain that catalog when settings change. Add meaningful help retrieval tests for new capabilities and limitations.

After reviewing implementation changes, run `npm run handbook:build`, `npm run handbook:check`, `npx vitest run tests/handbook.test.ts`, and `npm run typecheck` from `desktop-clone/`. Commit generated JSON with its source articles. Never regenerate fingerprints merely to silence a failing freshness check. If prose remains accurate, explicitly record that review in the change summary. Do not put private data or secrets in bundled help.

Product help is separate from personal memory and available without personal-memory sharing. Preserve user-data scope restrictions. Documentation describes capability; live permissions and observed tool results establish actual access. Do not claim a setting was changed without a successful action.

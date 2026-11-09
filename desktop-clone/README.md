# TinyGPT desktop

TinyGPT is an open-source desktop AI companion with local models, Chat, Work, a personal Bot, documents, voice, and a paired mobile/web companion. Start with the [project overview](../README.md) for what the app does, downloads, privacy, and current pre-beta availability.

This directory contains the production Electron application. Its public app name is **TinyGPT**. The `desktop-clone` directory name and internal package identifiers are retained for compatibility.

## Find your way around

| Directory | Purpose |
| --- | --- |
| `src/main/` | Desktop services, model processes, tools, storage, and permissions |
| `src/renderer/` | The desktop interface |
| `src/preload/` | The bridge between the interface and desktop services |
| `src/shared/` | Shared schemas, configuration, and bundled handbook data |
| `knowledge/` | Product help, with mappings to the implementation |
| `remote-relay/` | The paired Remote Control mobile/web app and relay |
| `plugin-auth/` | Connector authorization service |
| `scripts/`, `native/` | Runtime preparation, native helpers, and verification |
| `release-hosting/` | Download and update-feed hosting |
| `tests/` | Automated behavior and boundary checks |

## Run locally

Use Node.js 24 or newer. From this directory:

```sh
npm ci
npm run dev
```

Initial preparation downloads pinned models and runtimes. Native components can require platform build tools. Current targets are Windows x64 and Apple Silicon macOS 15+; the public pre-beta download is Windows only. Allow several gigabytes of disk space. Optional cloud models use your own provider account or credentials.

## Check a change

```sh
npm run runtime:work
npm run runtime:rag
npm run handbook:check
npm run typecheck
npm test -- --maxWorkers=2
npm run build
```

For a user-visible change, review the affected handbook articles and source mappings, then run `npm run handbook:build`, `npm run handbook:check`, and `npx vitest run tests/handbook.test.ts`. Commit generated handbook data with the reviewed articles. Read [MAINTENANCE.md](knowledge/MAINTENANCE.md) before updating help fingerprints.

Use synthetic profiles and accounts for testing. Keep conversations, credentials, local paths, runtime caches, and build outputs out of commits. Read [contributing](../CONTRIBUTING.md), [security reporting](../SECURITY.md), [third-party notices](THIRD_PARTY_NOTICES.md), and [release setup](../docs/RELEASING.md) before distributing a build.

# TinyGPT

Private AI, open to everyone. TinyGPT is a desktop companion from TinyAI with Chat, Work, a personal Bot, local memory, documents and voice.

Download testing builds at [tinygpt.org/downloads](https://tinygpt.org/downloads). These are pre-beta releases: expect bugs and unfinished features. Windows x64 is the current downloadable target; Mac downloads are not yet available.

## Develop

The production application lives in `desktop-clone/`. Use Node.js 24 or newer on Windows x64, or Apple Silicon macOS 15+ for Mac runtime development. Some native runtime preparation requires platform build tools; see the scripts and pinned manifests before building on a clean machine.

```sh
cd desktop-clone
npm ci
npm run dev
```

Initial preparation downloads pinned local models and runtimes. Allow several gigabytes of disk space and an internet connection. No provider key is needed for the included local model. Optional cloud providers use your own account or API credentials.

```sh
npm run runtime:work
npm run runtime:rag
npm run handbook:check
npm run typecheck
npm test -- --maxWorkers=2
npm run build
```

## Releases

See [release and signing setup](docs/RELEASING.md). Windows pre-beta releases use signed NSIS web installers, a separate persistent model store and user-controlled in-app updating. Those features are under development in the next build; the published 0.1.0-prebeta.2 download does not have an updater. Publishing is gated on verified signing and release checks.

## Privacy

Conversations and saved memories are local. Chat storage has no application-level encryption. Cloud inference and connected tools can receive the context you send them. File and command approvals control TinyGPT's actions; they are not an operating-system sandbox. Read the [bundled product handbook](desktop-clone/knowledge/) and [privacy policy](https://tinygpt.org/privacy-policy).

## License

TinyGPT's original source code is [Apache-2.0](LICENSE). Third-party components and downloaded model weights retain their own licenses; see [third-party notices](desktop-clone/THIRD_PARTY_NOTICES.md). Model weights, downloaded runtimes, private profiles, credentials, build outputs and internal development records are excluded from this source repository. The TinyGPT name and branding are not granted as trademarks by the source license.

See [contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md).

# TinyGPT

**Private AI, open to everyone.**

TinyGPT is an open-source desktop AI companion from [TinyAI](https://github.com/tinyaifoundation). Talk through an idea, work with your documents, write code, or give your personal Bot something to keep an eye on. Keep your conversations and memories on your computer, and choose the model and tools you want to use.

The included on-device AI is free forever, with no account or subscription required. You can also connect other local models or use your own OpenRouter account. Optional cloud services can charge for usage.

[Download TinyGPT](https://tinygpt.org/downloads) · [Open Remote Control](https://mobile.tinygpt.org) · [Read the handbook](desktop-clone/knowledge/) · [Report a bug](https://github.com/tinyaifoundation/tinygpt-desktop/issues)

> **Pre-beta:** TinyGPT is available for early testing. Expect bugs, unfinished features, and changes between builds. The current download is for Windows x64; a Mac download is not available yet. The downloads page lists the current build and installation notes.

## Why TinyGPT?

We want useful AI to be something people can run, understand, and shape for themselves. TinyGPT brings local models, everyday conversation, and practical tools into one desktop app. You can start with the included local AI and add connections as you need them.

Open source is part of that goal. This repository contains the desktop application, its mobile/web companion, and the product handbook. You can inspect how they work, contribute improvements, or build your own version under Apache-2.0.

## What you can do

### Chat through an idea

Ask questions, brainstorm, draft, learn, or explore a subject. Attach documents and images to give a conversation context. TinyGPT can search the web and use connected tools when the selected model supports them and you allow access.

Conversations are saved locally. Projects keep related chats, instructions, and files together, while the Library gives you a place to find saved sources and generated files.

### Turn a request into work

Work is for tasks that need actions and a result: editing files, working on a codebase, running commands, researching a topic, or preparing an output. It can use a coding agent, browser, and available tools, show its activity, and check what happened.

You choose which actions need approval. Review file changes and command results before relying on them; AI can make mistakes, and permission to run a command gives it real operating-system access.

### Make a Bot your own

Your personal Bot has its own personality, instructions, and notes. Configure what it remembers and which tools it can use. With initiative enabled, it can check in and watch topics you care about while the desktop is running.

For a specific recurring job, create a Scheduled task. Watches and scheduled work depend on the desktop being open, awake, and able to reach the services they need.

### Bring your context

Save details you want TinyGPT to remember, add Project instructions, and work with supported PDFs, documents, spreadsheets, presentations, text, code, and images. Local retrieval helps find relevant passages from the sources available to that conversation or Project.

Memories are explicit and manageable in Personalization. Personal memory and the built-in help handbook are separate, so you can ask how the app works without sharing personal memories.

### Speak, listen, and connect

Dictate a message using local English transcription, review the draft, and send it when ready. Use read aloud to listen to replies. Image understanding and generation depend on the available model or configured service.

Plugins connect supported accounts and services. MCP servers add tools, and skills provide task-specific guidance. A connection still needs the right permissions; installing a plugin or skill does not give it unrestricted access.

### Take the conversation with you

[Remote Control](https://mobile.tinygpt.org) is TinyGPT's mobile and web companion. Use it in a browser or install it as a web app on your phone. Pair it from **Settings → Remote Control** on your desktop and approve the device.

The companion connects to your running desktop and the conversations it is allowed to access. It does not host a separate copy of your AI: closing the desktop app or losing its connection makes remote features unavailable. You can change device access or revoke a pairing from the desktop.

## Local AI and your choice of models

TinyGPT includes an on-device model and local supporting tools. Once the required models and runtimes are installed, supported local features can work offline. First-time setup and model downloads need an internet connection and several gigabytes of disk space. Performance depends on your computer and the model you choose.

In **Settings → Configuration**, you can:

- Use the included TinyGPT model.
- Set up the optional TinyGPT Pro model after a device compatibility check.
- Connect models already running through Ollama, LM Studio, or another compatible local server.
- Connect your own OpenRouter account for supported cloud models.

Web research, cloud inference, connected services, and Remote Control need network access. Model capabilities vary: a model being available does not mean it supports every tool, image, or task.

## What private means here

TinyGPT stores conversations, Projects, preferences, and saved memories on your computer. Local storage and local inference are different choices:

- **Using a local model:** the model processes your request on your device. Tools can still contact websites or external services when used.
- **Using a cloud model:** prompts and relevant context, including selected memories and attachments, can be sent to that provider.
- **Connecting a service:** the service receives the requests needed for its tools. Account scopes, conversation access, and action approvals determine what is available.

Conversation storage does not have application-level encryption. Credentials use the app's protected credential storage where supported. Tool approvals help control actions, but they do not create an operating-system sandbox. Protect your device and review what you connect or approve.

Read the [privacy and permissions guide](desktop-clone/knowledge/privacy.md), [memory guide](desktop-clone/knowledge/memory.md), and [privacy policy](https://tinygpt.org/privacy-policy) for the details.

## Get started

1. Get the current Windows build from [tinygpt.org/downloads](https://tinygpt.org/downloads) and follow its setup notes.
2. Open TinyGPT and go through the welcome experience. Adding your name is optional.
3. Start with the on-device model, or open Configuration to choose another connection.
4. Try a conversation, attach a document, or switch to Work for a task that needs actions.

Use **Search settings** to find a control. The [product handbook](desktop-clone/knowledge/) is also bundled into the app and explains its current features, permissions, and limits.

The published **0.1.0-prebeta.2** Windows build is unsigned and does not have an in-app updater. The next pre-beta pipeline includes an update indicator above the sidebar profile and model reuse to reduce repeated downloads. Windows publisher signing is pending Azure account setup; unsigned pre-beta updates instead require metadata authenticated by TinyGPT's pinned Ed25519 release key, plus matching file checksums. This does not remove Windows publisher warnings. Packaged upgrades still need acceptance testing before being described as verified. See [releases and signing](docs/RELEASING.md).

## Help improve TinyGPT

Early feedback is useful: what you tried, what you expected, what happened, and which build you used. [Open an issue](https://github.com/tinyaifoundation/tinygpt-desktop/issues) for bugs and suggestions. Remove private conversation content, files, credentials, and account details from anything you share.

Code, documentation, usability improvements, and reproducible bug reports are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. For a security vulnerability, follow [SECURITY.md](SECURITY.md) instead of posting sensitive details publicly.

## Build from source

The production app lives in `desktop-clone/`. Development requires **Node.js 24 or newer**. Current native runtime targets are Windows x64 and Apple Silicon on macOS 15 or newer; some preparation steps need platform build tools. A Mac development target does not mean a tested Mac installer is available.

```sh
git clone https://github.com/tinyaifoundation/tinygpt-desktop.git
cd tinygpt-desktop/desktop-clone
npm ci
npm run dev
```

The first run prepares pinned models and native runtimes. Allow internet access, time for downloads, and several gigabytes of free disk space. Downloaded assets and private profiles are excluded from Git.

To prepare the test runtimes and check a change:

```sh
npm run runtime:work
npm run runtime:rag
npm run handbook:check
npm run typecheck
npm test -- --maxWorkers=2
npm run build
```

See the [desktop development guide](desktop-clone/README.md), [handbook maintenance guide](desktop-clone/knowledge/MAINTENANCE.md), and [release guide](docs/RELEASING.md) for more detail.

## License and acknowledgments

TinyGPT's original source code is licensed under [Apache-2.0](LICENSE). Third-party libraries, native runtimes, and model weights retain their own licenses; see the [third-party notices](desktop-clone/THIRD_PARTY_NOTICES.md).

TinyGPT builds on the work of open-source model, runtime, tool, and interface communities. Their original notices remain with the relevant components. The source license does not grant rights to the TinyGPT name or branding as trademarks.

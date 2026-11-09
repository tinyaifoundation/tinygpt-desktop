# Remote Control web app

The production companion is https://mobile.tinygpt.org. It needs a running TinyGPT desktop and approved pairing; it is not standalone hosted inference. Read the [Remote Control handbook](../knowledge/remote.md) for current behavior and privacy boundaries.

To build the companion from desktop-clone/, run `npm run remote:typecheck` and `npm run remote:build`. Generated browser bundles are not committed. Self-hosting needs your own Cloudflare Worker, Durable Objects, domain and push-signing secrets; adjust wrangler.jsonc and set TINYGPT_REMOTE_RELAY_URL for your desktop build. Use `npm run remote:push:setup` to provision push keys directly into your own Cloudflare secrets, then `npm run remote:deploy`. Never copy another deployment’s private keys.

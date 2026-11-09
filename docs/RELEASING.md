# Releases and signing

The development branch contains an updater and an independent model store. Published 0.1.0-prebeta.2 installations require a manual installer upgrade once. Do not label a build signed or updater-ready until the packaged application and two successive signed releases have been verified end to end.

## Publisher setup

Use a paid Azure subscription and Microsoft Artifact Signing Basic with individual Public Trust identity validation. The individual must complete Microsoft's identity checks in the portal; private identity documents and billing information do not belong in GitHub or this repository. Create the account in the confirmed subscription and region, complete identity validation, then create a Public Trust certificate profile.

Create an Entra application/service principal for the release job and a federated credential with audience `api://AzureADTokenExchange`, issuer `https://token.actions.githubusercontent.com`, and subject `repo:tinyaifoundation/tinygpt-desktop:environment:prebeta-release`. Grant only Artifact Signing Certificate Profile Signer access scoped to the intended certificate profile. Do not grant subscription Contributor to the release job and do not create a long-lived client secret for signing.

Create the GitHub environment `prebeta-release` and limit its deployment branch to `main`. Only the manually dispatched release job receives OIDC signing authority and storage credentials. Pull-request jobs get neither.

Environment variables:

| Variable | Meaning |
| --- | --- |
| AZURE_CLIENT_ID | Federated release application's ID |
| AZURE_TENANT_ID | Entra tenant ID |
| AZURE_SUBSCRIPTION_ID | Confirmed paid subscription |
| TINYGPT_PUBLISHER_NAME | Exact verified certificate publisher name |
| TINYGPT_SIGNING_ENDPOINT | Regional HTTPS codesigning.azure.net endpoint |
| TINYGPT_SIGNING_ACCOUNT | Artifact Signing account name |
| TINYGPT_SIGNING_PROFILE | Public Trust certificate profile name |
| CLOUDFLARE_ACCOUNT_ID | Release bucket account |
| R2_RELEASE_BUCKET | Release bucket name |

Environment secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` must be an R2 S3 credential limited to read/write of the release bucket. They are used only during publishing; signing uses federation instead of a stored key. Never put credential values in source files or artifacts.

## Ship

1. Review changes, bump `desktop-clone/package.json` and its lockfile, and add `desktop-clone/release-notes/VERSION.md`. Rebuild and review handbook outputs when needed. Merge reviewed source into main.
2. In GitHub **Actions → Ship Windows pre-beta → Run workflow**, select `main` and dispatch. The job checks signing and publishing configuration before dependency or runtime downloads, then checks source, runs tests, signs, builds and verifies the actual Windows files. Missing configuration fails with variable names only; preflight success does not prove signing identity or storage access.
3. Publishing verifies signatures again, uploads model objects and immutable app artifacts, checks stored bytes (including objects reused after an interrupted job), and replaces `updates/prebeta/win-x64/prebeta.yml` last. Failed uploads cannot expose a partial release through the feed. Do not overwrite versioned artifacts with different bytes; bump the version for a rebuild.
4. Verify the feed and download URLs through the public hostname. Update the website's downloads listing after verification. The website is a separate repository/service; this workflow does not silently deploy it.

The download Worker in `desktop-clone/release-hosting/` must be deployed once with the existing R2 binding, legacy paths and custom domain preserved. It serves only versioned release files, content-addressed model objects and the fixed pre-beta feed. No bucket listing or public write interface is exposed.

## Smaller updates

The app uses electron-updater with manual downloads and explicit restart. Publisher checks are mandatory; builds without a pinned publisher do not enable in-app updates. The feed is HTTPS and updater requests use single byte ranges, matching the Worker. The per-installation staging identifier header is suppressed; no chats, memories or credentials are sent by the updater.

The installer uses `differentialPackage: store-asar`. This trades a larger initial app package for smaller changes to app code. Block maps describe the actual package; the updater downloads changed ranges when its cache is available, reconstructs the package locally, and verifies its checksum. Missing caches or incompatible packages can require the complete app package. Measure bytes between two real releases instead of promising a fixed update size.

Twenty-four pinned model data files currently total approximately 2.48 GB. They are excluded from the app package and kept by checksum in the local profile. A first installation downloads missing model objects. The installer migration helper can reuse matching files from an older installation before it is removed. Each app version uses its own resource view with current small configuration/native runtime files and shared verified model data. Interrupted model downloads resume; changed or corrupt data is verified again. Existing profiles remain in the same directory.

## Acceptance before the first updater release

Verify individual signing and trusted timestamps, the exact publisher shown by Windows, a fresh-profile initial model download, migration from 0.1.0-prebeta.2, offline launch after setup, and a signed version-to-version update. Measure the app delta. Exercise interrupted downloads, an invalid signature/checksum, low disk space, restarting with active tasks, preserved conversations/settings, and a missing updater cache. Retain old artifacts so existing block maps remain available.

Code signing establishes a publisher identity; SmartScreen reputation can still take time for a new publisher. Never disable signature verification to suppress an update error.

## Local preparation and recovery

From `desktop-clone/`, `npm run release:preflight` checks the signing configuration and versioned notes without building or publishing. `npm run release:win` builds and verifies; `npm run release:publish` rechecks the actual signatures and publishes. Local signing also needs an authenticated identity with access to the certificate profile. CI uses the federated identity above.

If a job fails before feed promotion, the previous feed remains active. Rerun the same version only with the same immutable bytes; a rebuild that changes bytes requires a new version. Do not delete old packages needed by installed clients. If a published release has a defect, ship a higher fixed version: installed clients reject downgrades. Do not describe a failed or still-running release as shipped.

The first updater-enabled installer is a one-time manual upgrade for 0.1.0-prebeta.2 testers. After that, new signed releases appear in their sidebar; users choose when to download and restart. No paid Azure subscription or verified Public Trust profile means no signed production release. An Azure sign-up rejection must be resolved with Microsoft billing/subscription support; it is not a reason to remove publisher verification.

# Releases and signing

The Windows pre-beta pipeline supports unsigned installers while Azure publisher verification is pending. Every updater release still requires an Ed25519 proof authenticated by the public key pinned in the app, plus matching artifact checksums. This is separate from Windows Authenticode signing and does not remove unverified publisher or SmartScreen warnings. Published 0.1.0-prebeta.2 installations require a manual installer upgrade once. Record packaged upgrade and transfer measurements before claiming end-to-end update acceptance.

## Update authenticity

`src/shared/update-key.json` contains the public verification key. Its matching PKCS#8 DER private key, encoded as base64, is stored as the protected GitHub environment secret `TINYGPT_UPDATE_PRIVATE_KEY`. Neither the private key nor storage credentials belong in source or build artifacts. Both unsigned and Windows-signed releases authenticate the complete update metadata before the updater sees its URLs or SHA-512 checksums. There is no fallback to unsigned metadata.

The feed is one atomic JSON envelope at `updates/prebeta/win-x64/prebeta.json`. It contains YAML metadata and an Ed25519 signature over a versioned TinyGPT-specific message prefix and the exact YAML bytes. Only immutable release URLs for the authenticated version are accepted. Configured Windows publisher checks remain active in Windows-signed builds as an additional requirement.

Do not replace or delete the private key as routine setup: installed clients pin its public key. Losing it requires a manually installed recovery build unless a transition was authenticated using the existing key. Key rotation needs a deliberate migration plan. Keep the protected environment restricted to reviewed `main` releases.

## Publisher setup

For the `windows` signing mode, use a paid Azure subscription and Microsoft Artifact Signing Basic with individual Public Trust identity validation. The individual must complete Microsoft's identity checks in the portal; private identity documents and billing information do not belong in GitHub or this repository. Create the account in the confirmed subscription and region, complete identity validation, then create a Public Trust certificate profile. The `unsigned` mode does not require Azure and must not claim a Windows publisher identity.

Create an Entra application/service principal for the release job and a federated credential with audience `api://AzureADTokenExchange`, issuer `https://token.actions.githubusercontent.com`, and subject `repo:tinyaifoundation/tinygpt-desktop:environment:prebeta-release`. Grant only Artifact Signing Certificate Profile Signer access scoped to the intended certificate profile. Do not grant subscription Contributor to the release job and do not create a long-lived client secret for signing.

Create the GitHub environment `prebeta-release` and limit its deployment branch to `main`. Only the manually dispatched release job receives OIDC signing authority and storage credentials. Pull-request jobs get neither.

Environment variables (the Azure and publisher entries are needed only in `windows` mode):

| Variable | Meaning |
| --- | --- |
| AZURE_CLIENT_ID | Federated release application's ID |
| AZURE_TENANT_ID | Entra tenant ID |
| AZURE_SUBSCRIPTION_ID | Confirmed paid subscription |
| TINYGPT_PUBLISHER_NAME | Exact verified certificate publisher name; never a placeholder for unsigned builds |
| TINYGPT_SIGNING_ENDPOINT | Regional HTTPS codesigning.azure.net endpoint |
| TINYGPT_SIGNING_ACCOUNT | Artifact Signing account name |
| TINYGPT_SIGNING_PROFILE | Public Trust certificate profile name |
| CLOUDFLARE_ACCOUNT_ID | Release bucket account |
| R2_RELEASE_BUCKET | Release bucket name |

Environment secrets `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` must be an R2 S3 credential limited to read/write of the release bucket. They are used only during publishing; signing uses federation instead of a stored key. Never put credential values in source files or artifacts.

## Ship

1. Review changes, bump `desktop-clone/package.json` and its lockfile, and add `desktop-clone/release-notes/VERSION.md`. Rebuild and review handbook outputs when needed. Merge reviewed source into main.
2. In GitHub **Actions → Ship Windows pre-beta → Run workflow**, select `main` and signing mode `unsigned` while Azure is pending, or `windows` once the verified profile is configured. The job checks configuration and the matching release key before dependency or runtime downloads, then checks source, runs tests, builds and verifies the actual Windows files. Windows mode additionally signs and verifies Authenticode. Missing configuration fails with variable names only.
3. Publishing rechecks the files and declared Windows signing mode, creates a release-key proof, uploads model objects and immutable app artifacts, checks stored bytes (including objects reused after an interrupted job), and replaces `updates/prebeta/win-x64/prebeta.json` last. Failed uploads cannot expose a partial release through the feed. Do not overwrite versioned artifacts with different bytes; bump the version for a rebuild.
4. Verify the feed and download URLs through the public hostname. Update the website's downloads listing after verification. The website is a separate repository/service; this workflow does not silently deploy it.

The download Worker in `desktop-clone/release-hosting/` must be deployed once with the existing R2 binding, legacy paths and custom domain preserved. It serves only versioned release files, content-addressed model objects and the fixed pre-beta feed. No bucket listing or public write interface is exposed.

## Smaller updates

The app uses electron-updater with manual downloads and explicit restart. Release-key verification is mandatory. Builds that pin a Windows publisher additionally enforce its Authenticode signature. After switching to Windows-signed builds, keep shipping in `windows` mode: those clients will reject later unsigned installers. The feed is HTTPS and updater requests use single byte ranges, matching the Worker. The per-installation staging identifier header is suppressed; no chats, memories or credentials are sent by the updater.

The installer uses `differentialPackage: store-asar`. This trades a larger initial app package for smaller changes to app code. Block maps describe the actual package; the updater downloads changed ranges when its cache is available, reconstructs the package locally, and verifies its checksum. Missing caches or incompatible packages can require the complete app package. Measure bytes between two real releases instead of promising a fixed update size.

Twenty-four pinned model data files currently total approximately 2.48 GB. They are excluded from the app package and kept by checksum in the local profile. A first installation downloads missing model objects. The installer migration helper can reuse matching files from an older installation before it is removed. Each app version uses its own resource view with current small configuration/native runtime files and shared verified model data. Interrupted model downloads resume; changed or corrupt data is verified again. Existing profiles remain in the same directory.

## Acceptance before the first updater release

Verify release-key authenticity, a fresh-profile initial model download, migration from 0.1.0-prebeta.2, offline launch after setup, and a version-to-version update. Measure the app delta. Exercise interrupted downloads, altered proofs and invalid checksums, low disk space, restarting with active tasks, preserved conversations/settings, and a missing updater cache. In Windows-signed mode also verify individual signing, trusted timestamps, the exact publisher shown by Windows, and rejection of an incorrect publisher. Retain old artifacts so existing block maps remain available.

Code signing establishes a publisher identity; SmartScreen reputation can still take time for a new publisher. Never disable signature verification to suppress an update error.

## Local preparation and recovery

From `desktop-clone/`, set `TINYGPT_RELEASE_SIGNING_MODE=unsigned` or `windows` in the environment. `npm run release:preflight` checks the configuration, pinned public key and versioned notes without building or publishing. `npm run release:win` builds and verifies; `npm run release:publish` rechecks the actual files and publishes with the private update key. Local Windows signing also needs an authenticated identity with access to the certificate profile. CI uses the federated identity above. Local builds do not need the private update key until publishing.

If a job fails before feed promotion, the previous feed remains active. Rerun the same version only with the same immutable bytes; a rebuild that changes bytes requires a new version. Do not delete old packages needed by installed clients. If a published release has a defect, ship a higher fixed version: installed clients reject downgrades. Do not describe a failed or still-running release as shipped.

The first updater-enabled installer is a one-time manual upgrade for 0.1.0-prebeta.2 testers. After that, new authenticated releases appear in their sidebar; users choose when to download and restart. An Azure sign-up rejection blocks Windows publisher signing and must be resolved with Microsoft billing/subscription support. Until then, unsigned pre-beta builds use release-key verification and clearly disclose their Windows signing status.

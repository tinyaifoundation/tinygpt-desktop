# Updating TinyGPT and keeping local models

Windows x64 release builds can check the TinyGPT pre-beta update channel. Pre-beta installers may be unsigned by a verified Windows publisher while Azure account verification is pending. These builds still require a valid TinyGPT release-key signature before accepting update metadata or downloading replacement files. Development sessions and Mac builds do not enable this updater. The previously published 0.1.0-prebeta.2 build does not contain an updater; install an updater-enabled release manually once before expecting update notifications.

## Check, download and restart

Open **Settings → General → Updates → Check for updates**. A supported build also checks on startup and every four hours while running, refreshing a pending notification if a newer build becomes available. Checks pause while downloading or while a verified update is ready to install. When a newer version is found, **Update available** appears above the sidebar profile. Open it to read plain-text release notes and choose **Download update**. Downloads are not started merely because an update is available. Progress appears in the sidebar and update panel. You can keep using the app during a download.

After a verified download, choose **Restart to update**. The app refuses to restart through this control while Chat, Work, Bot or Scheduled work is active or a workspace terminal is still open. Finish the work and close terminals, then try again. Updates do not install automatically just because you quit the app. Download/check failures provide a retry through checking again; a failed check is not proof that you have the latest version.

Every update verifies metadata signed by TinyGPT's Ed25519 release key, pinned in the installed app. That authenticated metadata contains the version, immutable download locations and SHA-512 checksums; downloaded files must match. Missing, altered or incorrectly signed metadata is rejected, with no fallback to an unauthenticated feed. When the installed build also pins a verified Windows publisher, its updater additionally requires that publisher's valid Windows code signature. A TinyGPT release-key signature does not make an installer Windows-signed or remove an unverified publisher warning.

Update metadata and files come from downloads.tinygpt.org over HTTPS; the app checks that release artifact locations stay on that host and match the authenticated version. Update checks and model downloads expose ordinary network metadata to the hosting service. The updater's per-installation staging identifier header is suppressed. Chats, memories, profile names, API keys and account credentials are not supplied to the updater.

## Smaller app downloads

The app updater uses package block maps and HTTP byte ranges to reuse unchanged blocks from its local update cache. It reconstructs a complete package locally and verifies it before installation. This reduces network transfer when blocks match; it does not eliminate temporary disk-space requirements. Missing or incompatible update caches, or changed compression/package layout, can require downloading the complete app package. A small source edit does not guarantee a particular update size.

## Models are kept separately

New installer builds separate app files from approximately 2.48 GB of included local model data. First launch prepares the model files in a separate local-profile model store, showing progress and downloading only missing, changed or corrupt model objects. Matching model files from a previous installation can be retained by the installer before it removes the old app. Each downloaded file is checked against the size and SHA-256 pinned in the release's model catalog; incomplete downloads can resume on a later launch. Closing the model setup window cancels setup. If setup fails, reopen TinyGPT to continue. Setup needs internet when required files are not already available locally.

The verified models stay across app updates. An app-package fallback download does not normally require downloading unchanged models again. A complete prepared installation can use included local AI and voice offline; optional external providers and online tools still need their own connectivity. This local model store is separate from personal memories and Project indexing. Forgetting personal memories does not clear model weights, and there is no model-cache cleanup button in Personalization. Versioned resource views and update reconstruction can use additional disk space.

Code signing, identity verification and SmartScreen reputation are separate from the illustrated installer. A new signed publisher can still receive a Windows reputation warning. Product help describes the intended release behavior; the installed build's update status establishes whether updates are actually available. Mac pre-beta downloads and Mac updating are not part of the current Windows release pipeline.

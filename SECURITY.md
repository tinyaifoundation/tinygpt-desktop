# Security

TinyGPT is pre-beta. Please report vulnerabilities privately to help@tinygpt.org with the affected version and reproduction steps. Do not post secrets or private account data in public issues. There is no guaranteed response-time or support commitment for pre-beta builds.

Release credentials belong in a protected CI environment. Pull-request checks must not receive signing or storage credentials. The release job uses a verified Windows publisher, validates artifact checksums and promotes update metadata only after complete uploads. Never disable signature checks to make an update pass.

Local chat history is not encrypted by the application. Optional models, tools and plugins have separate data flows. TinyGPT's file and command permissions do not constitute a system sandbox.

# Troubleshooting and current limitations

When a feature fails, inspect the displayed error/status and the actual tool result. Do not repeatedly submit a consequential action without checking whether it already happened. Stop interrupts work where supported; it does not undo completed edits, messages or purchases.

## A model will not answer

Open Configuration and inspect the selected connection, model readiness, credentials and device/memory status. Local servers must be running; optional assets may need installation. Cloud providers need a working network/account and may apply limits or charges. Try a supported model/connection and report the exact error without including keys. Effort, tool use and vision depend on model support.

## A tool or account is unavailable

Check General permissions, relevant runtime settings and the plugin's connection and conversation access. A model may need to load the appropriate tool group before an action is callable. A missing tool or denied action is not permission to use another path. Sign-in/verification requires the user's handoff. Account access cannot be inferred from older conversation claims.

## A file or memory cannot be found

Check the Project, attachment processing state, personal-memory sharing, folder-index status and read permissions. Refresh an eligible index after changes. Inspect retrieval to see actual evidence. Keyword search can still work while local semantic inference recovers. The assistant does not have unrestricted access to every disk file, unrelated Project or prior chat.

## Replies are slow

Inspect Configuration memory and model residency; loading a cold model, long prompts and large tasks take time. Enable Record reply diagnostics in Settings → Diagnostics to inspect recent timing/status, export a report or clear records. Records have retention limits and are pruned at startup/read. Diagnostics do not establish a hardware-independent performance guarantee.

## Limits to remember

Help describes the installed build, not every roadmap item. Model answers, vision and generated content can be wrong. Local features do not make cloud tools offline. File processing has format/size limits; a failed extraction must be reported. Running commands is not a general OS sandbox. Remote/scheduled features depend on the available desktop and connections. A connection to another product's consumer subscription is not automatically a supported inference integration. Ask the assistant to check current tools and status before promising an action.

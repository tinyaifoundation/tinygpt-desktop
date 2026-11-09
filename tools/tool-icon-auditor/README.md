# Tool Icon Auditor

Open **Open Tool Icon Auditor.cmd** in the project root to launch the separate desktop app. It uses the project's installed Electron and Solar dependencies, works offline, and refreshes the audit from `desktop-clone` source on launch.

Choose **Refresh latest tools** to reload the current production source without closing the app. **New tools** lists newly discovered entries. Search or select a tool group, choose a tool, and paste a Solar Linear slug or choose one in the icon browser. **Save replacement** records it on disk. **Recorded changes** keeps all choices, with **Applied** marking choices that match production. **Pending changes** and **Copy update request** include only choices that still differ from the current icons.

Changes are stored in `artifacts/tool-icon-audit/recorded-changes.json`. The file records the tool identifier, current slug, requested slug, group, and timestamp. Changes are written atomically and serialized. They persist across app restarts; the app does not edit the toolchain mappings automatically.

The audit enumerates current built-in, desktop, coding, Work, connector and plugin declarations. It includes host-generated activities and the context-optimization indicator. It renders the actual production icon resolver: explicit per-tool mappings take precedence over browser, extension and bot family defaults. Connector membership comes from connector declarations, rather than source-file positions. The refresh timestamp identifies the source snapshot; this is a development helper, not an inventory of a separately installed release.

The app does not query connected accounts or remote MCP catalogs. Dynamic tool families represent those open-ended catalogs. Hidden rows and actions with no rendered toolchain icon are marked explicitly. Saved choices survive refresh, including choices for retired tools; copying an update request excludes retired tools and already-applied choices. The auditor does not change TinyGPT permissions or apply icon swaps automatically.

The app follows system light/dark appearance. Ctrl+F focuses tool search. It accepts bare slugs such as `file-text`, Iconify names such as `solar:file-text-linear`, and Solar import paths.

Validation: `node --preserve-symlinks --preserve-symlinks-main tools/tool-icon-auditor/check.cjs`. This uses a separate test profile and test change file. It checks search, validation, disk writes, restart persistence, clipboard export, icon selection, removal, and narrow/dark layouts.

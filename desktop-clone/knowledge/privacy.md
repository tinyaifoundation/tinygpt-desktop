# Privacy, permissions and data deletion

TinyGPT stores conversations, Projects, preferences, saved memories and indexes on this computer. Local storage is separate from inference processing. When a cloud inference connection is selected, prompts and relevant context, including retrieved excerpts or attachments, can be sent to that connection. Web tools contact websites, plugins contact their services, and remote access shares permitted information with paired devices.

## Choose privacy controls

In Configuration → OpenRouter, Zero data retention restricts eligible providers and Allow data collection controls collection eligibility. These are routing policies for that connection; they do not prove that every external service or plugin uses the same policy. Use a ready local model for local inference, and consider the separate network effects of tools used in a task.

Settings → General contains tool approvals for reading files/saved sources, changing files, running commands, searching/reading pages, interacting with websites, reading/controlling desktop windows, sending messages and purchases. Choose Ask me first, allow automatically or never allow as appropriate. Approval may be scoped to an action, run or conversation. Never allow remains a boundary; loading tools or skills does not bypass it.

New profiles allow file/saved-source reading by default and ask before writes, commands, browser access/interaction, desktop reads/control, sending and purchases. Existing saved choices can differ; inspect your current controls. Bundled help reads only application documentation and does not require permission to read your personal files.

## Remove information deliberately

Archiving hides a chat; it does not delete it. Forgetting memories/indexes removes retrieval evidence and derived checkpoints while original files/messages remain. Disabling personal-memory sharing prevents eligible future sharing but does not recall text already sent to providers. Clearing browser data removes browser storage; downloads and saved chat sources remain. Revoking a plugin or remote device blocks future access, not past external effects. Use the corresponding controls for each kind of information you want removed.

## Credentials and diagnostics

Provider credentials use the app's protected credential storage where supported. Do not put keys in prompts, memory or generated documentation. Settings → Diagnostics records local reply timing/status when enabled; its records exclude conversation text, files, credentials, URLs and paths and are not automatically uploaded. Review an export before sharing it. Operating-system/device access and any manually exported files have their own privacy boundaries.

During active local runs, Diagnostics can also record numeric GPU load, memory, clocks, power, temperature, limiting states, host-memory availability and counts of app-owned/other compute processes. Process names, command lines, process IDs and GPU UUIDs are not saved. NVIDIA counters require a working local nvidia-smi; unsupported readings remain unavailable. App-managed runtime records include numeric output rates, acceleration acceptance, snapshot budgets and skipped snapshots. Disabling Diagnostics or clearing records stops hardware sampling and discards late results. Existing seven-day/200-run retention applies; no hardware telemetry is automatically uploaded.

The workspace browser’s **Passwords** control opens private sign-in. Saved website passwords use a separate OS credential store; account labels use an encrypted local index. The feature does not return passwords to model tools, chats, memory, sources or previews. Active replies stop and assistant tools pause before credential entry. Fill requires user action and OS authentication, is bound to the exact HTTPS origin and browser profile, and never submits the website’s form automatically. Finish closes the private page before normal browsing continues with the signed-in session. Closing, OS lock/sleep or a five-minute timeout closes the private window. Passwords are removed separately from cookies/browsing data.

This boundary does not make passwords invisible to the website receiving them, nor protect against a compromised OS or unrestricted same-user commands. Windows Credential Manager is protected by the Windows account; TinyGPT’s per-fill Hello approval is not cryptographic protection against another program using that account. macOS Keychain user-presence protection requires a native build and suitable signed app identity. There is no plaintext or unprotected fallback. See the Browser and computer control article for the supported form types and sign-in steps.

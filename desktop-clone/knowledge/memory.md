# Memory and local retrieval

Open Settings → Personalization to manage saved memories, Project folders and Inspect retrieval. TinyGPT uses explicitly saved facts/preferences and indexed eligible content; it does not automatically index unrelated personal chats. Personal-memory sharing defaults on unless explicitly disabled. Project evidence stays within the corresponding Project.

## Save or change a memory

Choose Personal or a Project in Saved memories, select Add memory, enter a title and fact/preference, and save. Edit changes the text. Pause keeps a memory but removes it from retrieval; Enable restores it. Forget removes it and its derived retrieval evidence. Use personal memories controls whether saved personal facts are shared across conversations and Projects. Your profile name is saved as a personal memory when you provide it; manage that sharing here.

## Control folder indexing

Adding a folder to a Project starts indexing by default when no previous index preference exists. In Project folders, Refresh checks changes, Pause stops availability/indexing, and Enable indexing resumes it. Forget index removes indexed text and vectors, clears derived conversation checkpoints and turns indexing off. Original files and conversation messages remain. Forgetting an individual indexed file excludes it from later scans until its folder index is reset.

## Inspect what can be retrieved

Choose a scope in Inspect retrieval, enter a query and open a result to inspect its evidence. No results may mean the scope, sharing setting, file permissions or indexing state excludes the content. Local search combines keyword and semantic retrieval with relevance ranking. Bundled embedding/ranking models run on this computer; keyword search remains useful when inference is unavailable. Indexes are rebuildable search data, not the authoritative originals.

## Privacy and help

Memories and indexes are stored locally, but relevant excerpts can be sent to your chosen inference connection. Disabling sharing does not recall information already sent to a provider or erase original saved messages. Bundled TinyGPT help is a separate application-knowledge category; it remains available when personal-memory sharing is off and contains no personal account data.

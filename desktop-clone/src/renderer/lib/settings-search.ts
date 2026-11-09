export type SettingsSearchEntry = {
  id: string;
  section: string;
  title: string;
  description: string;
  keywords: string;
  targets: string[];
  selector?: string;
  open?: { selector: string; text?: string };
};
type EntryOptions = Partial<Pick<SettingsSearchEntry, 'keywords' | 'targets' | 'selector' | 'open'>>;
const entries: SettingsSearchEntry[] = [];
function section(name: string) {
  return (title: string, description = '', options: EntryOptions = {}) => entries.push({
    id: `${name}:${title}`, section: name, title, description, keywords: '', targets: [title], ...options,
  });
}
const general = section('General');
const permissions = [
  ['Read files and saved sources', 'Read project folders, documents, attachments and saved memories.', 'file access reading permissions'],
  ['Change files', 'Approve creating, writing and editing files.', 'file access write edit permissions'],
  ['Run commands', 'Approve programs, terminal commands and scripts.', 'execute shell terminal bash powershell permissions'],
  ['Search and read pages', 'Approve web search, page reading and browser screenshots.', 'internet browser permissions'],
  ['Interact with websites', 'Approve clicking website controls and filling forms.', 'browser click type permissions'],
  ['Read desktop windows', 'Approve window discovery and document reading.', 'computer screen accessibility permissions'],
  ['Control desktop windows', 'Approve desktop clicks, typing and keyboard actions.', 'computer mouse keyboard permissions'],
  ['Send messages', 'Approve sending messages through tools.', 'email communication permissions'],
  ['Make purchases', 'Approve purchase actions through tools.', 'buy payment permissions'],
] as const;
for (const [title, description, keywords] of permissions) general(title, `${description} Ask me first, allow automatically, or never allow.`, { keywords: `tool approvals ${keywords}` });
general('Version', 'The installed TinyGPT version.', { keywords: 'about update build' });
general('Updates', 'Check for a signed Windows pre-beta update, download it, and restart when ready. Updates never install automatically on quit.', { keywords: 'update upgrade restart download prebeta release version sidebar', targets: ['Updates', 'Check for updates'] });
general('Welcome to TinyGPT', 'Revisit light/dark theme, optional Pro and OpenRouter setup, your name and memories, Bot, voice, and your first conversation with Open welcome.', { keywords: 'onboarding first launch getting started setup tour restart resume free forever name local memory theme light dark Pro OpenRouter Bot add later skip', targets: ['Welcome to TinyGPT', 'Open welcome'] });
general('Language', 'TinyGPT interface language. English.');
general('Storage', 'Conversations, Projects, and preferences are saved on this computer.', { keywords: 'local data history privacy' });
general('Icons', 'Solar icons by 480 Design. CC BY 4.0.', { keywords: 'credits license attribution' });

const configuration = section('Configuration');
configuration('Keep local models loaded', 'Keep local models hot or release idle memory automatically.', { keywords: 'idle timeout unload warm hot vram ram residency', targets: ['Keep local models loaded'] });
configuration('Chat idle timeout', 'Choose when idle local chat and retrieval models release memory.', { keywords: 'minutes timer cool cooldown', selector: '[aria-label="Chat idle timeout"]' });
configuration('TinyGPT', 'Manage the included local model. Start, stop, and check setup.', { keywords: 'built in builtin offline model active ready download', selector: '[aria-label="Configure TinyGPT"]' });
configuration('TinyGPT Pro', 'Manage the optional local model and its setup on compatible devices.', { keywords: 'built in builtin offline model active ready download', selector: '[aria-label="Configure TinyGPT Pro"]', targets: ['Built-in models'] });
configuration('Check device', 'Check whether this computer supports built-in models.', { keywords: 'compatible compatibility hardware graphics gpu', targets: ['Check device', 'Built-in models'] });
for (const [title, description, keywords] of [
  ['Graphics memory', 'Live graphics memory used and available on your device.', 'vram gpu video memory usage capacity monitor chart'],
  ['Shared memory', 'On Apple Silicon, memory is shared by apps, macOS, and graphics.', 'mac ram unified memory usage capacity monitor chart'],
  ['GPU activity', 'Live graphics card activity.', 'gpu load utilization performance monitor chart'],
  ['GPU temperature', 'The current graphics card temperature, when reported.', 'heat cooling celsius performance monitor chart'],
  ['System memory', 'Live system memory used and available.', 'ram computer memory usage capacity monitor chart'],
  ['TinyGPT components', 'Expand the itemized memory breakdown for models, image understanding, speech, search, and the app.', 'memory breakdown itemized allocations monitor'],
] as const) configuration(title, description, { keywords, targets: [title, title === 'Shared memory' ? 'System memory' : 'Graphics memory'] });
const openRouter = { selector: '[aria-label="Configure OpenRouter"]' };
configuration('OpenRouter', 'Connect your account and choose from free and paid models.', { keywords: 'sign in account credits balance connection', selector: openRouter.selector });
configuration('Zero data retention', 'Only use OpenRouter providers that do not retain prompts or replies.', { keywords: 'privacy private logging retention', open: openRouter, targets: ['Zero data retention', 'Privacy', 'OpenRouter'] });
configuration('Allow data collection', 'Allow OpenRouter providers that may use prompts for training.', { keywords: 'privacy private training opt out', open: openRouter, targets: ['Allow data collection', 'Privacy', 'OpenRouter'] });
configuration('Model access', 'Choose free models or all models through OpenRouter.', { keywords: 'free paid price payment budget models', open: openRouter, targets: ['Models', 'Model access', 'OpenRouter'] });
configuration('Cost tier', 'Price range for Auto Router. Higher tiers can cost more.', { keywords: 'openrouter budget pricing low medium high xhigh max', open: openRouter, targets: ['Cost tier', 'Model access', 'OpenRouter'] });
configuration('Local models', 'Connect models already running in Ollama, LM Studio, or another local server.', { keywords: 'scan discover connection llama cpp endpoint server', selector: '[aria-label="Configure Local models"]' });

const notifications = section('Notifications');
for (const [title, description, keywords] of [
  ['Pause alerts', 'Silence desktop alerts and sounds. Activity keeps updating.', 'mute silence do not disturb'],
  ['Desktop notifications', 'Show an alert when work finishes or needs your attention.', 'banner notification center'],
  ['Only when you’re away', 'Keep alerts quiet while you’re viewing the relevant chat.', 'background focus away'],
  ['Message previews', 'Include the chat title and a short preview in desktop alerts.', 'privacy hide text content'],
  ['Unread dots', 'Show blue dots on unread chats and the Activity button.', 'badges unread indicator'],
  ['Chat replies', 'When a Chat reply finishes.', 'completion finished alert'],
  ['Work tasks', 'When a Work task finishes.', 'completion finished alert'],
  ['Bot replies and jobs', 'For each new Bot message, including messages sent while it keeps working and proactive updates.', 'background alert'],
  ['Requests for attention', 'Tool approvals, browser handoffs, and required connections.', 'permissions alerts'],
  ['Problems and interruptions', 'When a reply cannot finish and needs review.', 'errors failed alerts'],
  ['Play a sound', 'A short chime when an eligible alert arrives.', 'notification audio mute'],
  ['Notification sound', 'Choose the TinyGPT chime or a custom sound.', 'chime audio wav mp3'],
  ['Volume', 'Change notification sound volume.', 'notification audio loud quiet'],
  ['Use quiet hours', 'Pause desktop alerts and sounds during these hours, using your local time.', 'schedule night sleep start end quiet from'],
] as const) notifications(title, description, { keywords });
notifications('Quiet from', 'Set the start and end times after enabling quiet hours.', { keywords: 'quiet hours schedule night sleep time', targets: ['Quiet from', 'Use quiet hours'] });
notifications('Choose custom sound', 'Choose a WAV or MP3 notification sound.', { keywords: 'upload custom chime audio', targets: ['Choose custom sound', 'Notification sound'] });
notifications('Test desktop notification', 'Send a test desktop alert.', { keywords: 'preview banner', targets: ['Test desktop notification', 'Desktop notifications'] });
notifications('Preview sound', 'Preview the notification chime.', { keywords: 'test audio', targets: ['Preview sound', 'Play a sound'] });

const profile = section('Profile');
const editProfile = { selector: '.settings-profile-toolbar button', text: 'Edit' };
profile('First name', 'Edit your first name. Your name is saved as a personal memory.', { keywords: 'profile identity personal name edit', open: editProfile, selector: '[aria-label="First name"]' });
profile('Last name', 'Edit your last name. Your name is saved as a personal memory.', { keywords: 'profile identity surname family name edit', open: editProfile, selector: '[aria-label="Last name"]' });
profile('Profile photo', 'Upload, replace, or remove your profile photo.', { keywords: 'avatar picture image edit', open: editProfile, targets: ['Upload photo', 'Upload profile photo'] });
for (const title of ['Token activity', 'Activity insights', 'Most used tools']) profile(title, 'Your local profile usage and activity.', { keywords: 'statistics stats usage history streak tokens' });

const appearance = section('Appearance');
appearance('Theme', 'Choose system, light, or dark appearance.', { keywords: 'dark mode light mode color scheme' });
for (const mode of ['Light theme', 'Dark theme']) {
  for (const [title, field, keywords] of [
    ['Accent', 'accent', 'blue soft blue cyan purple green orange pink color'], ['Background', 'background', 'color'], ['Foreground', 'foreground', 'text color'],
    ['UI font', 'uiFont', 'interface typeface inter satoshi geist figtree public sans manrope roboto dm sans plus jakarta sans'],
    ['Content font', 'contentFont', 'answer text typeface inter satoshi geist figtree public sans manrope roboto dm sans plus jakarta sans'],
    ['Code font', 'codeFont', 'monospace typeface system default inter arial georgia menlo'],
    ['UI font weight', 'uiWeight', 'light regular medium semibold bold'], ['Content font weight', 'contentWeight', 'light regular medium semibold bold'], ['Code font weight', 'codeWeight', 'light regular medium semibold bold'],
  ] as const) appearance(`${mode} ${title.toLowerCase()}`, `Change the ${title.toLowerCase()} for ${mode.toLowerCase()}.`, { keywords, selector: `[aria-label="${mode} ${field}"]`, targets: [title, mode] });
  appearance(`${mode} translucent window`, 'Use a translucent window for this theme.', { keywords: 'transparency transparent sidebar blur', selector: `[aria-label="${mode} translucent window"]` });
  appearance(`${mode} contrast`, 'Adjust contrast for this theme.', { keywords: 'readability accessibility color', selector: `[aria-label="${mode} contrast"]` });
  appearance(`${mode} import`, 'Import a TinyGPT theme JSON file or copy your theme.', { keywords: 'theme export share copy', targets: [mode] });
}
for (const [title, description, keywords] of [
  ['Use pointer cursors', 'Show a pointer over interactive controls.', 'mouse hand cursor'],
  ['App icon', 'Choose the icon used in the Dock or window.', 'desktop dock tinygpt icon dark tinted clear'],
  ['Reduce motion', 'Reduce animations or match your system.', 'animation accessibility motion'],
  ['UI font size', 'Change the size of interface text.', 'text bigger smaller scale accessibility'],
  ['Code font size', 'Change the size of code text.', 'text editor bigger smaller scale'],
  ['Diff markers', 'Choose how additions and removals are marked in code previews.', 'changes color symbols plus minus'],
  ['Font smoothing', 'Change font smoothing.', 'text rendering antialiasing readability'],
] as const) appearance(title, description, { keywords });

const voice = section('Voice');
for (const [title, description, keywords] of [
  ['Bundled transcription', 'Turn speech into a draft on this computer. Microphone audio stays local.', 'dictation speech to text stt moonshine recording'],
  ['Microphone', 'Choose the microphone used for transcription.', 'dictation recording input audio device'],
  ['Automatic punctuation', 'The speech-to-text model supplies punctuation and capitalization.', 'transcription dictation periods commas'],
  ['Pause between phrases', 'The speech-to-text model manages speech boundaries automatically.', 'transcription dictation recording silence'],
  ['Reduce background noise', 'Reduce background noise in microphone audio.', 'noise suppression transcription dictation'],
  ['Reduce speaker echo', 'Reduce echo in microphone audio.', 'echo cancellation transcription dictation'],
  ['Read aloud', 'Show a read-aloud button beside completed answers.', 'tts text to speech spoken answers playback'],
  ['Speech model', 'Choose the bundled streaming text-to-speech model or a connected provider.', 'tts pocket speech provider audio'],
  ['Voice', 'Choose the voice used to read answers aloud.', 'tts read aloud speaker'],
  ['Playback speed', 'Change the speed of spoken answers.', 'read aloud speech tts faster slower'],
  ['Try this voice', 'Preview the selected voice.', 'read aloud speech tts test preview'],
] as const) voice(title, description, { keywords, targets: [title] });
voice('Transcription language', 'The language used for speech-to-text transcription. English.', { keywords: 'dictation speech language', selector: '[aria-label="Transcription language"]' });

const memory = section('Personalization');
memory('Use personal memories', 'Make the personal memories you save available across conversations and Projects. Unrelated personal chats are never indexed automatically.', { keywords: 'memory sharing remember forget personal name privacy' });
memory('Saved memories', 'Add, edit, pause, enable, or forget facts and preferences with personal or Project scope.', { keywords: 'memory remember preferences facts personal name' });
memory('Project folders', 'Folders added to Projects index automatically unless previously paused. Enable, refresh, pause, or forget indexing. Indexes stay on this computer.', { keywords: 'index indexing embeddings semantic search rag documents files knowledge' });
memory('Inspect retrieval', 'Search memories and indexed files, and inspect the evidence available to the assistant.', { keywords: 'memory semantic search embeddings rag knowledge passages evidence' });

const computer = section('Computer use');
computer('Computer tools in Chat', 'Let your assistant read accessible text and use labeled controls in an approved desktop window.', { keywords: 'desktop automation accessibility enable disable computer tools' });
computer('Read desktop windows', 'Window discovery and document reading have separate, scoped approvals.', { keywords: 'desktop computer tools approval ask allow deny screen' });
computer('Control desktop windows', 'Control stays with the chosen window. Consequential actions need a separate confirmation.', { keywords: 'desktop computer tools approval ask allow deny mouse keyboard' });
computer('Local computer runtime', 'Check the bundled computer-use runtime.', { keywords: 'status installed support' });
computer('Mac permissions', 'Allow TinyGPT in Accessibility and Screen Recording on macOS.', { keywords: 'macos screen recording accessibility access', targets: ['Mac permissions', 'Status and controls'] });
computer('Stop computer use', 'Stop desktop actions across chats, or resume computer use.', { keywords: 'emergency stop pause resume shortcut' });

const remote = section('Remote Control');
remote('Allow remote connections', 'Paired devices can access shared chats while TinyGPT is open. Turning this off keeps paired devices saved.', { keywords: 'phone mobile companion remote access enable disable' });
remote('Connection status', 'Check whether remote access is connected.', { keywords: 'phone mobile online offline reconnect internet' });
remote('Paired devices', 'Add a device using its QR code, change conversation access, or revoke access.', { keywords: 'phone mobile companion qr code pair pairing revoke limit all chats disconnect' });
remote('Keep this computer awake', 'Prevent automatic system sleep while remote connections are allowed. Your display can still turn off.', { keywords: 'sleep power remote phone mobile' });
remote('Remove all remote access', 'Forget every paired device. Each device will need a new QR code.', { keywords: 'disconnect revoke phone mobile devices', targets: ['Remove all remote access', 'Paired devices'] });

const plugins = section('Plugins');
plugins('Plugins', 'Manage connections, plugin tools, accounts, and selected knowledge.', { keywords: 'extensions integrations github gmail google drive slack calendar notion connectors oauth accounts' });
plugins('MCP servers', 'Manage custom Model Context Protocol servers and tool connections.', { keywords: 'mcp server http stdio transport custom tools endpoint authentication oauth bearer command environment credentials', open: { selector: '.plugin-library-tabs [role="tab"]:last-child' }, targets: ['MCP'] });
plugins('Skills', 'Manage installed skills and browse the skills library.', { keywords: 'skill install knowledge guidance instructions', open: { selector: '.plugin-library-tabs [role="tab"]:nth-child(2)' }, targets: ['Skills'] });

const browser = section('Browser');
browser('TinyGPT AdBlock', 'Block requests to common ad and tracking domains. Reload open pages after changing this setting.', { keywords: 'ads advertisements ad blocker tracking privacy' });
browser('Site verification', 'When a page needs verification or sign-in, the same tab opens for you; the task resumes after verification clears.', { keywords: 'captcha login chromium browser profile' });
browser('Default search engine', 'Choose Google, Bing, Brave, or DuckDuckGo for web search.', { keywords: 'search engine provider chromium internet' });
browser('Web link open destination', 'Where response links, citations, sources, and new-window links from websites open.', { keywords: 'external default browser tinygpt workspace links destination' });
browser('Local link open destination', 'Where localhost links open.', { keywords: 'localhost local server default browser tinygpt workspace links destination' });
browser('Show full URL', 'Include the path, query, and fragment when the address bar is not focused.', { keywords: 'address bar website link' });
browser('Browsing data', 'Clear history, cookies, site data, and cache from shared and isolated Project profiles. Downloaded files and saved chat sources remain.', { keywords: 'privacy storage clear delete cookies cache sign out' });
browser('Browsing history', 'View visited pages or clear browser history.', { keywords: 'visited websites pages clear delete privacy' });

const work = section('Work settings');
work('Work effort', 'The reasoning level used for Work. Available reasoning depends on the selected model.', { keywords: 'thinking reasoning instant low medium high max' });
for (const [title, description, keywords] of permissions.slice(0, 3)) work(title, `${description} Shared with General tool approvals.`, { keywords: `ask allow automatically deny permissions ${keywords}` });
work('Diff markers', 'How additions and removals appear in code previews.', { keywords: 'code changes color symbols plus minus' });
work('Code font size', 'Change the text size of code previews.', { keywords: 'editor text bigger smaller accessibility', selector: '[aria-label="Work code font size"]' });

const shortcuts = section('Keyboard shortcuts');
const bot = section('Bot');
bot('Remember useful details', 'Enable or disable your Bot memory.', { keywords: 'bot memory remember preferences' });
bot('Browse the web', 'Let your Bot use browser and research tools with shared permissions.', { keywords: 'bot browser search internet' });
bot('Take initiative', 'Let your Bot message first while TinyGPT is open. Proactive checks run between 8 AM and 10 PM.', { keywords: 'bot background tasks proactive watches' });
bot('Check in periodically', 'Choose Off, Every 30 minutes, or Every hour when initiative is enabled.', { keywords: 'bot heartbeat frequency interval', targets: ['Check in periodically', 'Take initiative'] });
bot('Personalization', 'Edit Personality, About you, Instructions, or Notes, then Save personalization.', { keywords: 'bot soul user agents memory notes behavior personality', targets: ['Personalization'] });
bot('Things your bot is keeping an eye on', 'Refresh, pause, resume, or remove private Bot watches.', { keywords: 'bot jobs background watches schedule' });
for (const [title, key] of [['New chat', 'J'], ['Toggle sidebar', 'B'], ['Find in conversation', 'F'], ['Search chats', 'K']]) shortcuts(title, `Ctrl or Command ${key}.`, { keywords: 'keyboard shortcut hotkey navigation' });
section('Archived chats')('Archived chats', 'Find and restore archived chats to return them to the sidebar.', { keywords: 'archive restore unarchive hidden conversations history' });
const diagnostics = section('Diagnostics');
diagnostics('Record reply diagnostics', 'Timing and status records help identify slow replies and delayed UI updates. Conversation text, files, credentials, URLs, and paths are excluded. Nothing is uploaded.', { keywords: 'performance slow lag timing logs debugging privacy' });
diagnostics('Retention', 'Diagnostics are pruned when TinyGPT starts and when diagnostics are read.', { keywords: 'diagnostics records storage days replies limit' });
diagnostics('Recent replies', 'Inspect timing and status records for recent replies.', { keywords: 'diagnostics performance slow first token timeline' });
diagnostics('Export diagnostics', 'Export local timing and status records.', { keywords: 'logs debugging download export', targets: ['Export', 'Local reply diagnostics'] });
diagnostics('Clear diagnostics', 'Clear local diagnostics records.', { keywords: 'logs debugging delete clear', targets: ['Clear records', 'Local reply diagnostics'] });

export const settingsSearchEntries: readonly SettingsSearchEntry[] = entries;
export function normalizeSettingsSearch(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’']/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
export function searchSettings(query: string): SettingsSearchEntry[] {
  const normalized = normalizeSettingsSearch(query);
  if (!normalized) return [];
  const words = normalized.split(/\s+/);
  return entries.flatMap(entry => {
    const title = normalizeSettingsSearch(entry.title), section = normalizeSettingsSearch(entry.section);
    const description = normalizeSettingsSearch(entry.description), keywords = normalizeSettingsSearch(entry.keywords);
    const content = `${title} ${section} ${description} ${keywords}`;
    if (!words.every(word => content.includes(word))) return [];
    const score = (title === normalized ? 100 : title.startsWith(normalized) ? 75 : title.includes(normalized) ? 50 : 0)
      + words.reduce((sum, word) => sum + (title.includes(word) ? 12 : keywords.includes(word) ? 6 : description.includes(word) ? 3 : 1), 0)
      + (section === normalized ? 5 : 0);
    return [{ entry, score }];
  }).sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title)).map(item => item.entry);
}

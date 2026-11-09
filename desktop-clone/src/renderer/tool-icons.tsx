import { CalculatorIcon } from '@solar-icons/react/linear/calculator';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Notebook2Icon } from '@solar-icons/react/linear/notebook-2';
import { ProgrammingIcon } from '@solar-icons/react/linear/programming';
import { DisplayIcon } from '@solar-icons/react/linear/display';
import { DocumentAddIcon } from '@solar-icons/react/linear/document-add';
import { CompassSquareIcon } from '@solar-icons/react/linear/compass-square';
import { GalleryEditIcon } from '@solar-icons/react/linear/gallery-edit';
import { MouseIcon } from '@solar-icons/react/linear/mouse';
import { ExitIcon } from '@solar-icons/react/linear/exit';
import { RefreshSquareIcon } from '@solar-icons/react/linear/refresh-square';
import { WindowFrameIcon } from '@solar-icons/react/linear/window-frame';
import { CursorSquareIcon } from '@solar-icons/react/linear/cursor-square';
import { BookBookmarkIcon } from '@solar-icons/react/linear/book-bookmark';
import { EyeIcon } from '@solar-icons/react/linear/eye';
import { FileSearchIcon } from '@solar-icons/react/linear/file-search';
import { FileQuestionMarkIcon } from '@solar-icons/react/linear/file-question-mark';
import { ToolboxIcon } from '@solar-icons/react/linear/toolbox';
import { SquareTransferHorizontalIcon } from '@solar-icons/react/linear/square-transfer-horizontal';
import { PenNewRoundIcon } from '@solar-icons/react/linear/pen-new-round';
import { ClipboardCopyIcon } from '@solar-icons/react/linear/clipboard-copy';
import { ClipboardIcon } from '@solar-icons/react/linear/clipboard';
import { ClipboardTextIcon } from '@solar-icons/react/linear/clipboard-text';
import { ClipboardListIcon } from '@solar-icons/react/linear/clipboard-list';
import { ClipboardClockIcon } from '@solar-icons/react/linear/clipboard-clock';
import { ClipboardAddIcon } from '@solar-icons/react/linear/clipboard-add';
import { DownloadSquareIcon } from '@solar-icons/react/linear/download-square';
import { Bot, Globe, Images, Camera, FileText, FilePenLine, FolderOpen, SquareChevronRight, FolderSearch, Search, ScanSearch, LibraryBig, MousePointer2, TextCursorInput, Keyboard, Hand, PlugZap, CircleHelp } from './icons';
import { isComputerTool } from '../shared/computer';
import { connectorToolIconKeys } from '../shared/connector-tool-icon-keys';
import overrides from '../shared/tool-icon-overrides.json';
import type { DesktopBridge } from '../shared/contracts';
import type { PluginSnapshot } from '../shared/plugins';
import type { ToolActivity } from '../shared/tools';
import { friendlyToolLabel } from '../shared/tool-labels';

const toolIcons = { list_files: FolderSearch, read_file: FileText, search_files: Search, write_file: FilePenLine, edit_file: FilePenLine, run_command: SquareChevronRight, load_tools: PlugZap, work_history: FileText, calculate: CalculatorIcon, generate_image: Images, view_image: Images, computer_screenshot: Camera, code_delegate: ProgrammingIcon, code_read: FileText, code_glob: FolderSearch, code_grep: Search, code_edit: FilePenLine, code_write: FilePenLine, code_apply_patch: FilePenLine, code_bash: SquareChevronRight, code_todowrite: FileText, create_project_directory: FolderOpen, edit_project_file: FilePenLine, review_project_changes: FileText, run_project_command: SquareChevronRight, search_web: Search, read_page: ScanSearch, list_project_files: FolderSearch, read_project_file: FileText, write_project_file: FilePenLine, search_sources: Search };
const replacementIcons = {
  globe: Globe, 'notebook-2': Notebook2Icon, programming: ProgrammingIcon, display: DisplayIcon,
  'folder-search': FolderSearch, 'document-add': DocumentAddIcon,
  'compass-square': CompassSquareIcon, 'gallery-edit': GalleryEditIcon,
  'plug-circle': PlugZap, 'hand-shake': Hand, 'text-field-focus': TextCursorInput,
  keyboard: Keyboard, mouse: MouseIcon, exit: ExitIcon,
  'refresh-square': RefreshSquareIcon,
  camera: Camera, 'window-frame': WindowFrameIcon, 'cursor-square': CursorSquareIcon,
  'book-bookmark': BookBookmarkIcon, eye: EyeIcon, 'file-search': FileSearchIcon,
  'file-question-mark': FileQuestionMarkIcon, toolbox: ToolboxIcon,
  'square-transfer-horizontal': SquareTransferHorizontalIcon, 'pen-new-round': PenNewRoundIcon,
  'clipboard-copy': ClipboardCopyIcon, clipboard: ClipboardIcon, 'clipboard-text': ClipboardTextIcon,
  'clipboard-list': ClipboardListIcon, 'clipboard-clock': ClipboardClockIcon,
  'clipboard-add': ClipboardAddIcon, 'download-square': DownloadSquareIcon, bot: Bot,
};

export function toolIcon(name: ToolActivity['name'], connectorKey?: string) {
  const key = connectorKey && Object.hasOwn(overrides, connectorKey) ? connectorKey : name;
  const slug = overrides[key as keyof typeof overrides];
  const selected = replacementIcons[slug as keyof typeof replacementIcons];
  if (selected) return selected;
  if (name === 'work_ask_user') return CircleHelp;
  if (name === 'code_devtools' || name.startsWith('browser_')) return Globe;
  const family = name.startsWith('ext_') ? overrides['ext_*'] : name.startsWith('bot_') ? overrides['bot_*'] : undefined;
  return replacementIcons[family as keyof typeof replacementIcons] ?? toolIcons[name as keyof typeof toolIcons] ?? (isComputerTool(name) ? MousePointer2 : LibraryBig);
}

const ConnectorIconKeys = createContext<Record<string, string>>({});
const ToolLabels = createContext<Record<string, string>>({});
export function RemoteToolIconProvider({ tools, children }: { tools: readonly ToolActivity[]; children: ReactNode }) {
  const keys = Object.fromEntries(tools.flatMap(tool => tool.iconKey && Object.hasOwn(overrides,tool.iconKey) ? [[tool.name,tool.iconKey]] : []));
  return <ConnectorIconKeys.Provider value={keys}>{children}</ConnectorIconKeys.Provider>;
}
export function ToolIconProvider({ bridge, children }: { bridge: DesktopBridge; children: ReactNode }) {
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true, revision = 0;
    const update = (snapshot: PluginSnapshot) => {
      const expected = ++revision;
      void connectorToolIconKeys(snapshot).then(next => { if (active && expected === revision) {
        setKeys(next);
        setLabels(Object.fromEntries(snapshot.entries.flatMap(entry => entry.tools.map(tool => [tool.name, tool.label]))));
      } }).catch(() => {});
    };
    const unsubscribe = bridge.onPluginsUpdate(update);
    const expected = revision;
    void bridge.plugins().then(result => { if (active && expected === revision && result.ok) update(result.value); }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  return <ConnectorIconKeys.Provider value={keys}><ToolLabels.Provider value={labels}>{children}</ToolLabels.Provider></ConnectorIconKeys.Provider>;
}
export function useToolIcon(name: ToolActivity['name']) {
  return toolIcon(name, useContext(ConnectorIconKeys)[name]);
}
export function useToolLabel(name: string) {
  return useContext(ToolLabels)[name] || friendlyToolLabel(name);
}

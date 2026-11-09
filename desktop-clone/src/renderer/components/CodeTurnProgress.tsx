import { useContext, useEffect, useMemo, useState } from 'react';
import { subscribeChatUpdates } from '../lib/chat-updates';
import type { CodeChange } from '../../shared/code';
import type { ToolActivity } from '../../shared/tools';
import { codeFileChanges, latestCodeTodos } from '../../core/code-progress';
import { createdFiles, type CreatedFile } from '../../core/created-files';
import { ConversationActions } from './ConversationMessages';
import { FileTree, type FileTreeNode } from './elements/file-tree';
import { TodoList } from './elements/todo-list';

export function CodeTurnProgress({ tools, running }: { tools: ToolActivity[]; running: boolean }) {
  const { bridge, openFile } = useContext(ConversationActions);
  const [changes, setChanges] = useState<CodeChange[]>([]);
  const [error, setError] = useState('');
  const conversationId = tools[0]?.conversationId;
  const revision = tools.map(tool => `${tool.id}:${tool.status}`).join();
  useEffect(() => {
    let live = true;
    if (!bridge || !conversationId) return;
    const refresh = () => void bridge.codeChanges(conversationId).then(result => {
      if (!live) return;
      if (result.ok) { setChanges(result.value); setError(''); } else setError(result.error);
    }).catch(() => { if (live) setError('File changes could not be loaded.'); });
    refresh();
    const unsubscribe = subscribeChatUpdates(bridge, update => { if (update.conversation.id === conversationId && !update.library.activeRuns.some(run => run.conversationId === conversationId)) refresh(); });
    return () => { live = false; unsubscribe(); };
  }, [bridge, conversationId, revision, running]);
  const todos = useMemo(() => latestCodeTodos(tools), [tools]);
  const files = useMemo(() => {
    const runIds = new Set(tools.map(tool => tool.runId));
    const journal = changes.filter(change => runIds.has(change.runId));
    const edits = codeFileChanges(journal);
    const result: (CreatedFile & { additions?: number; deletions?: number })[] = edits.map(change => ({ ...change, projectId: change.projectId ?? undefined, ...(change.projectId === null ? { generated: true } : {}), name: change.path.split(/[\\/]/).at(-1)!, type: 'Code' }));
    // Older/extension write artifacts can lack a journal snapshot.
    for (const artifact of createdFiles(tools)) if (!journal.some(file => (file.projectId ?? undefined) === artifact.projectId && file.path.replaceAll('\\', '/') === artifact.path.replaceAll('\\', '/'))) result.push(artifact);
    return result;
  }, [tools, changes]);
  const nodes: FileTreeNode[] = [];
  const folders = new Set<string>();
  for (const file of files) {
    const path = file.path.replaceAll('\\', '/'); const parts = path.split('/');
    for (let depth = 0; depth < parts.length - 1; depth++) {
      const folder = parts.slice(0, depth + 1).join('/');
      if (!folders.has(folder)) { folders.add(folder); nodes.push({ path: folder, name: parts[depth], depth, kind: 'folder' }); }
    }
    nodes.push({ path: file.path, name: file.name, depth: parts.length - 1, kind: 'file', additions: file.additions, deletions: file.deletions });
  }
  if (running) return todos.length ? <TodoList items={todos} title="Work plan" maxVisible={4} className="my-4 max-w-none rounded-2xl border border-border/60 p-3.5" /> : null;
  const hasCounts = files.every(file => file.additions !== undefined && file.deletions !== undefined);
  return <>{files.length > 0 && <FileTree className="my-4 max-w-none" nodes={nodes} visibleCount={nodes.length} totalAdditions={hasCounts ? files.reduce((n, file) => n + file.additions!, 0) : undefined} totalDeletions={hasCounts ? files.reduce((n, file) => n + file.deletions!, 0) : undefined} onOpenFile={path => { const file = files.find(item => item.path === path); if (file) openFile(file); }} />}{error && <p role="status" className="text-xs text-muted-foreground">{error}</p>}</>;
}

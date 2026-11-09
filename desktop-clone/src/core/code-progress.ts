import { browserActivityLabel } from '../shared/browser-tool-labels';
import { diffLines } from 'diff';
import type { CodeChange } from '../shared/code';
import type { ToolActivity } from '../shared/tools';
import { computerToolLabel } from '../shared/computer';

export interface CodeTodo { id: string; text: string; status: 'pending' | 'active' | 'done' | 'failed' | 'cancelled' }
export function parseCodeTodos(value: unknown): CodeTodo[] {
  if (!Array.isArray(value)) return [];
  const states = { pending: 'pending', in_progress: 'active', completed: 'done', cancelled: 'cancelled', failed: 'failed' } as const;
  return value.slice(0, 100).flatMap((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.content !== 'string' || !item.content.trim() || !Object.hasOwn(states, item.status)) return [];
    return [{ id: String(index), text: item.content.slice(0, 1000), status: states[item.status as keyof typeof states] }];
  });
}
export function latestCodeTodos(tools: ToolActivity[]): CodeTodo[] {
  for (const tool of [...tools].reverse()) {
    if (tool.name !== 'code_todowrite' || tool.status !== 'success' || !tool.result) continue;
    try {
      const result = JSON.parse(tool.result);
      // Older native runs stored the upstream JSON list as text output.
      return parseCodeTodos(result.todos ?? (typeof result.output === 'string' ? JSON.parse(result.output) : result));
    } catch { /* Skip an invalid update; never infer completion from prose. */ }
  }
  return [];
}
export function codeFileChanges(changes: CodeChange[]) {
  const files = new Map<string, CodeChange>();
  for (const change of [...changes].sort((a, b) => a.createdAt - b.createdAt)) {
    if (change.reverted || change.state && change.state !== 'applied') continue;
    const key = `${change.projectId}:${change.path.replaceAll('\\', '/')}`;
    const prior = files.get(key);
    files.set(key, { ...change, before: prior ? prior.before : change.before });
  }
  return [...files.values()].filter(change => change.before !== change.after).sort((a, b) => a.path.localeCompare(b.path)).map(change => {
    const diff = diffLines(change.before ?? '', change.after, { timeout: 50, maxEditLength: 10000 });
    const additions = diff?.reduce((n, part) => n + (part.added ? part.count ?? 0 : 0), 0);
    const deletions = diff?.reduce((n, part) => n + (part.removed ? part.count ?? 0 : 0), 0);
    return { ...change, additions, deletions };
  });
}
export function codeToolLabel(tool: ToolActivity, active = false): string {
  const browser = browserActivityLabel(tool, active);
  if (browser) return browser;
  if (tool.name === 'code_delegate') return 'Coding agent';
  const desktop = computerToolLabel(tool.name, active);
  if (desktop) return desktop;
  const file = tool.target?.split(/[\\/]/).at(-1);
  const labels: Record<string, string> = { read_file: 'Reading', write_file: 'Writing', edit_file: 'Editing', code_read: 'Reading', read_project_file: 'Reading', code_write: 'Writing', write_project_file: 'Writing', code_edit: 'Editing', edit_project_file: 'Editing' };
  if (labels[tool.name]) return `${labels[tool.name]} ${file || 'a file'}`;
  const actions: Record<string, string> = { list_files: 'Browsing files', search_files: 'Searching files', run_command: 'Running a command', load_tools: 'Loading tools', work_history: 'Reading saved results', work_plan: 'Planning the task', work_finish: 'Verifying the outcome', work_evidence: 'Reading saved evidence', command_status: 'Checking a command', command_stop: 'Stopping a command', view_image: 'Viewing an image', browser_screenshot: 'Taking a screenshot', code_bash: 'Running a command', run_project_command: 'Running a command', code_glob: 'Finding files', code_grep: 'Searching files', code_apply_patch: 'Applying changes', code_todowrite: 'Updating the work plan' };
  return actions[tool.name] ?? tool.displayText ?? tool.summary ?? (active ? 'Working…' : 'Worked');
}

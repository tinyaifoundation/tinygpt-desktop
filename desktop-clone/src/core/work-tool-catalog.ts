import { COMPUTER_INSTRUCTIONS } from '../shared/computer';

type Definition = { name: string; description: string; schema: Record<string, any> };
const core = new Set(['search_help', 'read_source', 'read_observation', 'list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'run_command', 'load_tools', 'load_skill', 'work_plan', 'work_ask_user', 'search_web', 'read_page']);
const chatCore = new Set(['search_help', 'read_source', 'read_observation', 'load_tools', 'load_skill', 'calculate', 'present', 'search_web', 'read_page', 'search_sources', 'list_project_files', 'read_project_file', 'write_project_file']);
export const workGroups: Record<string, string[]> = {
  research: ['read_source', 'search_web', 'read_page', 'search_sources', 'calculate'],
  browser: ['browser_tabs', 'browser_preview', 'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_hover', 'browser_press_key', 'browser_close', 'browser_screenshot', 'view_image'],
  desktop: ['computer_open_app', 'computer_activate_window', 'computer_list_windows', 'computer_read_window', 'computer_screenshot', 'computer_click', 'computer_type', 'computer_press_key', 'computer_scroll'],
  services: [],
  skills: ['search_skills', 'read_skill_reference', 'draft_skill', 'copy_skill_files'],
  images: ['view_image', 'generate_image'],
  jobs: ['command_status', 'command_stop'],
  history: ['work_history', 'review_project_changes'],
};

/** The SDK keeps a callable registry; only this small selection crosses the
 * provider boundary. Dormant schemas do not consume its context budget. */
export class WorkToolCatalog {
  private groups = new Set<string>();
  private enabled = new Set<string>();
  constructor(readonly definitions: Definition[], readonly mode: 'work' | 'chat' = 'work') {}
  private isCore(name: string) { return (this.mode === 'chat' ? chatCore : core).has(name); }
  candidates(group: string, query = '') {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.definitions.filter(tool => (workGroups[group]?.includes(tool.name) || group === 'services' && tool.name.startsWith('ext_')) && (!terms.length || terms.some(term => `${tool.name} ${tool.description}`.toLowerCase().includes(term))));
  }
  preview(group: string, query = '', toolNames?: string[]) { const names = new Set(this.candidates(group, group === 'services' && toolNames ? '' : query).filter(tool => group !== 'services' || !toolNames || toolNames.includes(tool.name)).map(tool => tool.name)); return this.definitions.filter(tool => this.isCore(tool.name) || names.has(tool.name)); }
  selectionIssue(group: string, query: string | undefined, budget: number, count: (text: string) => number, toolNames?: string[]) {
    // Discovery and connection cards activate no schemas and must reach the model intact.
    if (group === 'services' && toolNames?.length === 0) return;
    const candidates = this.candidates(group, group === 'services' && toolNames ? '' : query).filter(tool => group !== 'services' || !toolNames || toolNames.includes(tool.name));
    if (candidates.length && count(JSON.stringify(this.preview(group, query, toolNames))) <= budget) return;
    return { error: candidates.length ? 'This group is too large to load together. Nothing was executed.' : 'No available tools match this group and query.', code: 'TOOL_SELECTION_REQUIRED', executed: false, nextAction: 'Call load_tools with a query selecting the needed actions.', tools: this.candidates(group).slice(0, 30).map(tool => ({ name: tool.name, description: tool.description.slice(0, 100) })) };
  }
  enable(group: string, query = '', toolNames: string[] = []) { if (Object.hasOwn(workGroups, group)) { this.groups.clear(); this.enabled.clear(); this.groups.add(group); for (const tool of this.candidates(group, group === 'services' ? '' : query)) if (!tool.name.startsWith('ext_') || toolNames.includes(tool.name)) this.enabled.add(tool.name); } }
  available() { return this.definitions.filter(tool => this.isCore(tool.name) || this.enabled.has(tool.name)); }
  has(name: string) { return this.mode === 'work' && name === 'work_finish' || this.available().some(tool => tool.name === name); }
  groupFor(name: string) { return name.startsWith('ext_') ? 'services' : Object.entries(workGroups).find(([, tools]) => tools.includes(name))?.[0]; }
  guide() { return this.groups.has('desktop') ? COMPUTER_INSTRUCTIONS : ''; }
  select(body: Record<string, any>) {
    const advertised = new Map(this.available().map(tool => [tool.name, tool]));
    if (!Array.isArray(body.tools)) return body;
    const tools = body.tools.flatMap((tool: any) => {
      const name = tool.function?.name ?? tool.name, definition = advertised.get(name);
      if (!definition) return [];
      if (tool.function) return [{ ...tool, function: { ...tool.function, description: definition.description, parameters: definition.schema } }];
      if ('input_schema' in tool) return [{ ...tool, description: definition.description, input_schema: definition.schema }];
      return [{ ...tool, description: definition.description, parameters: definition.schema }];
    });
    // Drop a stale forced choice after the host changes the available tools.
    const forced = body.tool_choice?.function?.name ?? body.tool_choice?.name;
    return { ...body, tools, ...(forced && !advertised.has(forced) ? { tool_choice: 'auto' } : {}) };
  }
}

export function withoutToolMetadata(tool: Definition): Definition {
  if (tool.name.startsWith('work_')) return tool;
  if (tool.name.startsWith('ext_')) { const { __tinygpt_status, __tinygpt_approval, ...properties } = tool.schema.properties ?? {}; return { ...tool, schema: { ...tool.schema, properties } }; }
  const { status, permission, __tinygpt_status, __tinygpt_approval, ...properties } = tool.schema.properties ?? {};
  return { ...tool, schema: { ...tool.schema, properties } };
}

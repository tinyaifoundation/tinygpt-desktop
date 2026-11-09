import { WorkToolCatalog, workGroups } from './work-tool-catalog';
import { COMPUTER_INSTRUCTIONS } from '../shared/computer';

type Definition = { name: string; description: string; schema: Record<string, any> };
export const STABLE_WORK_TOOL_INSTRUCTIONS = 'Common tools remain callable throughout this run. load_tools discovers additional actions and returns their exact parameters without changing the callable functions. For an action returned with invokeWith:"invoke_tool", call invoke_tool with its exact name and an input object matching its parameters. Discovery never grants permissions. Use actual results as evidence of access and success.';
export const invokeWorkTool: Definition = {
  name: 'invoke_tool',
  description: 'Call an additional action discovered through load_tools. Use the exact returned name and parameters. The host validates the action and arguments and applies its normal permissions and approval flow.',
  schema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 128 }, input: { type: 'object', additionalProperties: true } }, required: ['name', 'input'], additionalProperties: false },
};

/** Local inference reuses an ordered prefix, including tool definitions. Keep
 * the wire surface fixed; lazy action schemas travel in appended tool results.
 * This is a captured catalog, never a source of account authorization. */
export class StableWorkTools {
  private catalog: WorkToolCatalog;
  private loaded = new Map<string, Definition>();
  readonly direct: Definition[];
  constructor(readonly definitions: Definition[], private budget: number, private count: (text: string) => number) {
    this.catalog = new WorkToolCatalog(definitions);
    const selected = new Set(this.catalog.available().map(tool => tool.name));
    // Select once, deterministically. Small windows can discover the remainder
    // through the same dispatcher without evicting any of these common tools.
    for (const name of workGroups.browser) {
      if (!definitions.some(tool => tool.name === name)) continue;
      const candidate = definitions.filter(tool => selected.has(tool.name) || tool.name === name);
      if (count(JSON.stringify([...candidate, invokeWorkTool])) <= budget) selected.add(name);
    }
    this.direct = definitions.filter(tool => selected.has(tool.name)).map(tool => tool.name === 'load_tools'
      ? { ...tool, description: tool.description + ' Additional action parameters are returned as data; use invoke_tool when indicated. Common callable tools stay available.' }
      : tool);
    for (const tool of this.direct) this.loaded.set(tool.name, tool);
  }
  private details(group: string, query: string | undefined, selected: Definition[]) {
    if (!selected.length || this.count(JSON.stringify(selected)) > this.budget) throw new Error(JSON.stringify({
      error: selected.length ? 'Select fewer actions to retrieve their parameters.' : 'No available actions match this group and query.',
      code: 'TOOL_SELECTION_REQUIRED', executed: false,
      tools: this.catalog.candidates(group).slice(0, 30).map(tool => ({ name: tool.name, description: tool.description.slice(0, 100) })),
      nextAction: 'Call load_tools with an exact action name or a more specific query.',
    }));
    for (const tool of selected) this.loaded.set(tool.name, tool);
    const direct = new Set(this.direct.map(tool => tool.name));
    return { enabled: group, query, tools: this.direct.map(tool => tool.name),
      actions: selected.map(tool => ({ name: tool.name, description: tool.description, ...(direct.has(tool.name) ? { callDirectly: true } : { parameters: tool.schema, invokeWith: invokeWorkTool.name }) })),
      ...(group === 'desktop' ? { guide: COMPUTER_INSTRUCTIONS } : {}),
      nextAction: 'Common functions remain callable. For an action marked invokeWith, call invoke_tool with its name and input matching parameters. Loading never grants permissions.',
    };
  }
  discover(group: string, query?: string) {
    if (group === 'services') throw new Error('Connected-service discovery must use the host loader.');
    return this.details(group, query, this.catalog.candidates(group, query));
  }
  serviceResult(value: Record<string, any>) {
    if (value.enabled !== 'services' || !Array.isArray(value.toolNames) || value.error) return value;
    // A broad discovery (or a connection card) must not revoke earlier loads.
    if (!value.toolNames.length) return value;
    const names = new Set(value.toolNames);
    const selected = this.definitions.filter(tool => tool.name.startsWith('ext_') && names.has(tool.name));
    if (selected.length !== names.size) throw new Error('The requested action is outside this run’s captured plugin catalog. Nothing was executed.');
    const detail = this.details('services', value.query, selected);
    return { ...value, toolNames: [], actions: detail.actions, nextAction: detail.nextAction };
  }
  resolve(args: { name: string; input: unknown }): Definition {
    if (!args || typeof args.name !== 'string' || !args.input || typeof args.input !== 'object' || Array.isArray(args.input) || JSON.stringify(args.input).length > 120000) throw new Error('Invalid action arguments. Nothing was executed.');
    const definition = this.loaded.get(args.name);
    if (!definition || args.name === 'load_tools') throw new Error('Load this exact action through load_tools before invoking it. Nothing was executed.');
    return definition;
  }
}

import type { ExtensionToolDefinition } from '../shared/plugins';

const noise = new Set(['tool','tools','action','actions','name','names','use','my','the','for','please','to','at','in','from','of','and','me','a','an','it','is','show','all','new','with','today','yesterday','recent','latest','this','week','can','could','would','you','i','should','plugin','plugins','want','need','some','any','that','do','does','give','got','received']);
const normalize = (word: string) => ({ email: 'mail',emails: 'mail',inbox: 'mail',check: 'search',find: 'search',look: 'search',lookup: 'search',searches: 'search',triage: 'search',reading: 'read' } as Record<string,string>)[word] ?? word;

/** Match focused intent within the already-authorized candidate set. */
export function focusedPluginToolQuery(tools: ExtensionToolDefinition[], query: string, pluginNames: string[]): ExtensionToolDefinition[] {
  const text = query.toLowerCase(), words = text.split(/\s+/);
  const exact = tools.filter(tool => words.some(word => [tool.name.toLowerCase(),tool.originalName.toLowerCase(),`ext_${tool.originalName.toLowerCase()}`].includes(word)));
  if (exact.length) return exact;
  let action = text;
  for (const name of [...pluginNames].sort((a,b) => b.length-a.length)) if (name) action = action.replaceAll(name.toLowerCase(),' ');
  const terms = [...new Set(action.split(/[^a-z0-9]+/).filter(word => word && !noise.has(word)).map(normalize))];
  if (!terms.length) return [];
  const ranked = tools.map(tool => {
    const name = `${tool.originalName} ${tool.label}`.toLowerCase().replaceAll('_',' '), description = tool.description.toLowerCase();
    const strong = terms.filter(term => name.includes(term)).length;
    return { tool,score: strong * 4 + terms.filter(term => description.includes(term)).length,eligible: strong > 0 && terms.every(term => name.includes(term) || description.includes(term)) };
  }).filter(item => item.eligible).sort((a,b) => b.score-a.score);
  return ranked.filter(item => item.score === ranked[0]?.score).slice(0,3).map(item => item.tool);
}

import type { ExtensionToolDefinition } from '../shared/plugins';

/** Short model-facing names; canonical IDs remain the host's authority key. */
export function piPluginToolNames(tools: ExtensionToolDefinition[], reserved: string[]) {
  const realToModel = new Map<string,string>(), modelToReal = new Map<string,string>(), used = new Set(reserved);
  for (const [index,tool] of [...tools].sort((a,b) => a.name.localeCompare(b.name)).entries()) {
    const base = tool.originalName.replace(/[^a-zA-Z0-9_]/g,'_').slice(0,45) || 'action';
    const duplicate = tools.filter(other => other.originalName === tool.originalName).length > 1;
    let alias = !duplicate && !used.has(base) ? base : `service_${index+1}_${base}`;
    while (used.has(alias)) alias = `_${alias}`;
    used.add(alias); realToModel.set(tool.name,alias); modelToReal.set(alias,tool.name);
  }
  return {
    model: (name: string) => realToModel.get(name) ?? name,
    canonical: (name: string) => modelToReal.get(name) ?? name,
    loaderResult(value: Record<string,any>): Record<string,any> { return { ...value,
      ...(Array.isArray(value.toolNames) ? {toolNames:value.toolNames.map((name:string)=>realToModel.get(name)??name)} : {}),
      ...(Array.isArray(value.tools) ? {tools:value.tools.map((tool:any)=>({...tool,name:realToModel.get(tool.name)??tool.name}))} : {}),
    }; },
  };
}

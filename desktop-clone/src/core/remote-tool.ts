import type { ToolActivity } from '../shared/tools';
import { sourceUrl } from './citations';
import { toolImageReference } from './tool-preview';
import { presentationVersion } from './remote-presentation';
import overrides from '../shared/tool-icon-overrides.json';
export function remoteTool(tool: ToolActivity, iconKey?: string): ToolActivity {
  let data: Record<string,any> = {}; try { const value = JSON.parse(tool.result ?? '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) data = value; } catch {}
  const sites = new Set<string>();
  const address = (value: unknown) => { const safe = sourceUrl(value); if (!safe) return; const url = new URL(safe); url.search=''; url.hash=''; if (sites.size<8) sites.add(url.toString()); return url.toString(); };
  let target = tool.target?.slice(0,500);
  if (/^(?:read_page|search_web|browser_)/.test(tool.name)) {
    const url = address(tool.target) ?? address(data.url) ?? address(data.page?.url) ?? address(data.source?.url); if (url) target=url;
    for (const result of [...(Array.isArray(data.results) ? data.results : []),...(Array.isArray(data.passages) ? data.passages : [])].slice(0,12)) address(result?.url);
  }
  if (/^(?:code_|.*project_file|view_image)/.test(tool.name) && target) target = target.split(/[\\/]/).at(-1);
  if(target && /^https?:/i.test(target))target=address(target);
  if (target && /^(?:[a-zA-Z]:[\\/]|\\\\)/.test(target)) target = target.split(/[\\/]/).at(-1);
  if(target?.startsWith('/'))target=target.split('/').at(-1);
  // Image previews need a disclosure, not a file badge or raw image reference.
  if (tool.name === 'view_image') target = undefined;
  return {id:tool.id,conversationId:tool.conversationId,runId:tool.runId,name:tool.name,summary:tool.name === 'view_image' ? 'Viewing an image' : tool.summary.slice(0,300),displayText:tool.name === 'view_image' ? undefined : tool.displayText?.slice(0,300),target,status:tool.status,createdAt:tool.createdAt,result:null,...(sites.size ? {sites:[...sites]} : {}),...(toolImageReference(tool) ? {previewImage:true} : {}),...(iconKey && Object.hasOwn(overrides,iconKey) ? {iconKey} : {}),...(tool.name === 'present' ? {remotePresentation:{version:presentationVersion(tool.result ?? '',tool.id),available:!!data.ui}} : {})};
}

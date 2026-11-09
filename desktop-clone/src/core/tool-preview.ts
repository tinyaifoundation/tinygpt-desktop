import type { ToolActivity } from '../shared/tools';
const images = new Set(['view_image','browser_screenshot','computer_screenshot']);
export function toolImageReference(tool: Pick<ToolActivity,'name'|'result'>): string | undefined {
  if (!images.has(tool.name) || !tool.result) return;
  try { const value = JSON.parse(tool.result); const match = /^tinygpt-image:([a-f0-9-]{36})$/i.exec(value?.imageReference); return match?.[1]; } catch { return; }
}
export function hasToolPreview(tool: ToolActivity) { return tool.previewImage === true || !!toolImageReference(tool); }

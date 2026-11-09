import type { ToolPermissions } from '../shared/config';
export const approvalPresets = [
  { id: 'ask', label: 'Ask for approval', description: 'Ask before editing files or using the internet' },
  { id: 'auto', label: 'Approve for me', description: 'Browse automatically; ask before changes and website actions' },
  { id: 'full', label: 'Full access', description: 'Automatically approve available tools within the Project scope' },
] as const;
export type ApprovalPreset = typeof approvalPresets[number]['id'];
export function presetPermissions(id: ApprovalPreset): ToolPermissions { return { desktop: 'ask', desktopInteract: 'ask', read: 'allow', write: id === 'full' ? 'allow' : 'ask', execute: id === 'full' ? 'allow' : 'ask', browser: id === 'ask' ? 'ask' : 'allow', interact: id === 'full' ? 'allow' : 'ask', send: id === 'full' ? 'allow' : 'ask', purchase: id === 'full' ? 'allow' : 'ask' }; }
export function permissionPreset(value: ToolPermissions): ApprovalPreset | 'custom' { return approvalPresets.find(preset => Object.entries(presetPermissions(preset.id)).filter(([key]) => !['desktop', 'desktopInteract'].includes(key)).every(([key, rule]) => value[key as keyof ToolPermissions] === rule))?.id ?? 'custom'; }

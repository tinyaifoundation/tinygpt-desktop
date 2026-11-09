import { defaultToolPermissions, type ApprovalRule, type InferenceRoute, type Mode, type Settings, type ToolPermissions } from '../shared/config';

export const modes: Record<Mode, { title: string; upstream: string; description: string; status: string }> = {
  chat: { title: 'Chat', upstream: 'LibreChat', description: 'Think and write with your assistant.', status: 'Chat supports direct provider and local conversations.' },
  bot: { title: 'Your bot', upstream: 'Pi', description: 'Give your assistant a task to carry out.', status: 'Your personal assistant uses Pi with your selected connection and TinyGPT approvals.' },
  code: { title: 'Work', upstream: 'LibreChat', description: 'Give your assistant an outcome to complete.', status: 'Work uses the shared agent engine with durable tasks, verified outcomes, desktop tools and approved actions.' },
};

export function inferenceIssue(settings: Settings, secrets: Record<InferenceRoute, boolean>): string | null {
  if (settings.route === 'portal') return 'TinyGPT Portal needs its credit wallet and purchase service.';
  if (settings.route === 'byok' && !secrets.byok) return 'Add your provider API key in Settings.';
  if (!settings[settings.route].model) return 'Choose a model in Settings.';
  return null;
}

export interface ToolRequest {
  operation: keyof ToolPermissions;
  insideWorkspace: boolean;
}
// Initial product default, subject to the user's autonomy preferences.
// This policy is not a sandbox and does not yet intercept upstream tool calls.
export function toolDecision(request: ToolRequest, permissions: ToolPermissions = defaultToolPermissions): ApprovalRule {
  const rule = permissions[request.operation];
  if (rule === 'deny') return 'deny';
  // Workspace grants are separate from per-tool approval preferences.
  if (!request.insideWorkspace && ['read', 'write', 'execute'].includes(request.operation)) return 'ask';
  return rule;
}

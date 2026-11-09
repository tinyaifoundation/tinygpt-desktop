// These host actions require a Work task. Advertising them in a personal
// assistant leads to calls the broker must reject, regardless of permission.
const workOnly = new Set(['list_files', 'read_file', 'search_files', 'write_file', 'edit_file', 'run_command', 'create_project_directory', 'edit_project_file', 'review_project_changes', 'run_project_command', 'command_status', 'command_stop', 'copy_skill_files']);
// Bot bubbles do not render Chat's structured presentation cards.
export function assistantToolAllowed(name: string) { return name !== 'present' && !workOnly.has(name); }

/** Describe the actual registry for this turn, not capability inferred from history. */
export function assistantBrowserAccess(definitions: readonly {name:string}[], background: boolean) {
  const tools=definitions.filter(tool=>tool.name.startsWith('browser_')||tool.name==='view_image').map(tool=>tool.name);
  const interactive=!background&&tools.includes('browser_click');
  const notice=!tools.includes('browser_open') ? 'Browser access is off for this assistant turn. Do not claim to have browsed.' : background
    ? 'This turn is a proactive read-only check. Browser click/type/hover/key actions are intentionally excluded here, not missing from the app or awaiting deployment. Foreground Bot replies support interaction when Browse the web is enabled, subject to host approval. Report findings or ask the user to continue in the Bot chat for changes; do not promise to click Save during a watch.'
    : 'This is a foreground Bot reply. Load the browser group to use the listed interactive tools, subject to host approval. Foreground Bot tabs survive between replies while TinyGPT remains open; list tabs and refresh the snapshot after sign-in. Password entry remains user-controlled.';
  return {mode:background?'proactive-read-only':'foreground',interactive,tools,notice};
}

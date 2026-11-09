const labels: Record<string, string> = {
  read_source: 'Read saved documents', model_load: 'Load local model', file_prepare: 'Prepare documents',
  read_observation: 'Read saved observations', code_devtools: 'Browser',
  list_files: 'Browse files', read_file: 'Read files', search_files: 'Search files', write_file: 'Write files', edit_file: 'Edit files', run_command: 'Run commands', load_tools: 'Load tools', work_history: 'Read work history',
  calculate: 'Calculator', present: 'Present content', generate_image: 'Generate images', view_image: 'View images',
  search_web: 'Search the web', read_page: 'Read web pages', search_sources: 'Search saved sources',
  list_project_files: 'Browse project files', read_project_file: 'Read project files', write_project_file: 'Write project files',
  create_project_directory: 'Create project folders', edit_project_file: 'Edit project files', review_project_changes: 'Review changes', run_project_command: 'Run commands',
  code_read: 'Read files', code_glob: 'Find files', code_grep: 'Search files', code_edit: 'Edit files', code_write: 'Write files', code_apply_patch: 'Apply file changes', code_bash: 'Run commands', code_todowrite: 'Update work plan',
  work_plan: 'Plan work', work_finish: 'Finish work', work_evidence: 'Check work evidence', command_status: 'Check command progress', command_stop: 'Stop commands', code_delegate: 'Coding agent',
  browser_tabs: 'Find browser tabs', browser_preview: 'Preview local app', browser_open: 'Open browser', browser_navigate: 'Navigate websites', browser_snapshot: 'Read browser pages', browser_click: 'Click website controls', browser_type: 'Fill website fields', browser_scroll: 'Scroll websites', browser_hover: 'Inspect website controls', browser_press_key: 'Use browser keyboard', browser_close: 'Close browser tabs', browser_screenshot: 'Browser screenshots',
  computer_list_windows: 'Find desktop windows', computer_read_window: 'Read desktop windows', computer_screenshot: 'Desktop screenshots', computer_open_app: 'Open applications', computer_activate_window: 'Focus desktop windows', computer_click: 'Click desktop controls', computer_type: 'Type on desktop', computer_press_key: 'Use desktop keyboard', computer_scroll: 'Scroll desktop windows',
  search_skills: 'Find skills', load_skill: 'Use skills', read_skill_reference: 'Read skill references', draft_skill: 'Create skills', copy_skill_files: 'Copy skill files', request_plugin_connection: 'Connect plugins',
};

export function friendlyToolLabel(name: string): string {
  if (labels[name]) return labels[name];
  const readable = name.replace(/^ext_/, '').replace(/_[a-f0-9]{24}$/, '').replace(/[_-]+/g, ' ').trim();
  if (!readable || /^[a-f0-9]{24}$/.test(readable)) return 'Plugin tool';
  return readable[0].toUpperCase() + readable.slice(1);
}

import type { ToolActivity } from './tools';

type Labels = readonly [request: string, active: string, complete: string];
const fallback: Labels = ['Use the browser', 'Using the browser', 'Used the browser'];
// Host-owned language for approvals, live activity and saved history.
const actions: Record<string, Labels> = {
  list_pages: ['Find open pages', 'Finding open pages', 'Found open pages'],
  select_page: ['Switch browser pages', 'Switching browser pages', 'Switched browser pages'],
  new_page: ['Open a page', 'Opening a page', 'Opened a page'],
  close_page: ['Close a page', 'Closing a page', 'Closed a page'],
  navigate_page: ['Navigate to a page', 'Navigating to a page', 'Navigated to a page'],
  resize_page: ['Resize the browser', 'Resizing the browser', 'Resized the browser'],
  handle_dialog: ['Respond to a website prompt', 'Responding to a website prompt', 'Responded to a website prompt'],
  get_tab_id: ['Find the browser tab', 'Finding the browser tab', 'Found the browser tab'],
  take_snapshot: ['Read the page', 'Reading the page', 'Read the page'],
  take_screenshot: ['Take a screenshot', 'Taking a screenshot', 'Took a screenshot'],
  list_console_messages: ['Check browser messages', 'Checking browser messages', 'Checked browser messages'],
  get_console_message: ['Inspect a browser message', 'Inspecting a browser message', 'Inspected a browser message'],
  list_network_requests: ['Check page requests', 'Checking page requests', 'Checked page requests'],
  get_network_request: ['Inspect a page request', 'Inspecting a page request', 'Inspected a page request'],
  evaluate_script: ['Check how the page works', 'Checking how the page works', 'Checked how the page works'],
  click: ['Click a website control', 'Clicking a website control', 'Clicked a website control'],
  click_at: ['Click on the page', 'Clicking on the page', 'Clicked on the page'],
  hover: ['Inspect a website control', 'Inspecting a website control', 'Inspected a website control'],
  fill: ['Fill a website field', 'Filling a website field', 'Filled a website field'],
  type_text: ['Type on the page', 'Typing on the page', 'Typed on the page'],
  fill_form: ['Fill a website form', 'Filling a website form', 'Filled a website form'],
  drag: ['Drag a page element', 'Dragging a page element', 'Dragged a page element'],
  upload_file: ['Upload a file', 'Uploading a file', 'Uploaded a file'],
  press_key: ['Use the browser keyboard', 'Using the browser keyboard', 'Used the browser keyboard'],
  wait_for: ['Wait for page content', 'Waiting for page content', 'Waited for page content'],
  get_css_styles: ['Inspect page styling', 'Inspecting page styling', 'Inspected page styling'],
  open_devtools: ['Open browser inspection', 'Opening browser inspection', 'Opened browser inspection'],
};
const builtInActions: Record<string, string | Labels> = {
  browser_tabs: 'list_pages', browser_open: 'new_page', browser_navigate: 'navigate_page', browser_close: 'close_page',
  browser_snapshot: 'take_snapshot', browser_screenshot: 'take_screenshot', browser_click: 'click',
  browser_type: 'fill', browser_hover: 'hover', browser_press_key: 'press_key',
  browser_preview: ['Preview the app', 'Opening the app preview', 'Opened the app preview'],
  browser_scroll: ['Scroll the page', 'Scrolling the page', 'Scrolled the page'],
};
const actionLabels = (action: string) => Object.hasOwn(actions, action) ? actions[action] : undefined;
export function browserActionLabel(action: unknown, state: 'request' | 'active' | 'complete' = 'request'): string {
  return (actionLabels(String(action)) ?? fallback)[state === 'request' ? 0 : state === 'active' ? 1 : 2];
}
export function browserActivityLabel(tool: Pick<ToolActivity, 'name' | 'summary'>, active = false): string | undefined {
  let labels: Labels | undefined;
  if (tool.name === 'code_devtools') {
    // Old conversations saved the native action name in their summary.
    const legacy = /^Browser developer tools:\s*([a-z_]+)$/i.exec(tool.summary);
    labels = legacy ? actionLabels(legacy[1]) : Object.values(actions).find(value => value.includes(tool.summary));
  } else if (tool.name.startsWith('browser_')) {
    const action = builtInActions[tool.name];
    labels = typeof action === 'string' ? actionLabels(action) : action;
  } else return undefined;
  return (labels ?? fallback)[active ? 1 : 2];
}

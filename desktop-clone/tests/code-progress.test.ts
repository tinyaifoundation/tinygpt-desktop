import { browserActionLabel, browserActivityLabel } from '../src/shared/browser-tool-labels';
import { expect, it } from 'vitest';
import { codeFileChanges, codeToolLabel, latestCodeTodos, parseCodeTodos } from '../src/core/code-progress';
import type { CodeChange } from '../src/shared/code';
import type { ToolActivity } from '../src/shared/tools';
const tool = (result:string, status:ToolActivity['status']='success') => ({name:'code_todowrite',result,status} as ToolActivity);
it('uses the latest actual todo update, including an empty plan and legacy native output',()=>{
  expect(parseCodeTodos([{content:'Build',status:'in_progress'},{content:'Test',status:'pending'},{content:'bad',status:'invented'}])).toEqual([{id:'0',text:'Build',status:'active'},{id:'1',text:'Test',status:'pending'}]);
  expect(latestCodeTodos([tool(JSON.stringify({output:JSON.stringify([{content:'Build',status:'completed'}])}))])[0].status).toBe('done');
  expect(latestCodeTodos([tool(JSON.stringify({todos:[{content:'Build',status:'pending'}]})),tool('{"todos":[]}')])).toEqual([]);
  expect(latestCodeTodos([tool('{"todos":[]}','error')])).toEqual([]);
});
const change = (values:Partial<CodeChange>) => ({id:'1',conversationId:'c',runId:'r',projectId:'p',path:'src/app.ts',createdAt:1,state:'applied',reverted:false,before:'old\n',after:'new\n',...values} as CodeChange);
it('consolidates repeated edits with net line counts and excludes unsuccessful/undone/no-op changes',()=>{
  const files=codeFileChanges([change({}),change({id:'2',before:'new\n',after:'new\nextra\n',createdAt:2}),change({path:'failed',state:'failed'}),change({path:'undone',reverted:true}),change({path:'noop',before:'x',after:'x'})]);
  expect(files).toHaveLength(1);expect(files[0]).toMatchObject({before:'old\n',after:'new\nextra\n',additions:2,deletions:1});
});
it('Code progress names the actual tool and filename instead of commentary metadata',()=>{
  expect(codeToolLabel({name:'code_read',target:'C:\\Project\\src\\app.ts',displayText:'May I read the whole project?'} as ToolActivity,true)).toBe('Reading app.ts');
  expect(codeToolLabel({name:'code_bash',displayText:'Status: hello\nPermission: May I'} as ToolActivity,true)).toBe('Running a command');
});

it.each([
  ['navigate_page', 'Navigating to a page', 'Navigated to a page'],
  ['list_console_messages', 'Checking browser messages', 'Checked browser messages'],
  ['take_snapshot', 'Reading the page', 'Read the page'],
  ['list_network_requests', 'Checking page requests', 'Checked page requests'],
  ['get_network_request', 'Inspecting a page request', 'Inspected a page request'],
  ['evaluate_script', 'Checking how the page works', 'Checked how the page works'],
])('uses human browser language for %s in new and saved activity', (action, active, complete) => {
  for (const summary of [`Browser developer tools: ${action}`, browserActionLabel(action)]) {
    const tool = { name: 'code_devtools', summary, displayText: action } as ToolActivity;
    expect(browserActivityLabel(tool, true)).toBe(active);
    expect(browserActivityLabel(tool)).toBe(complete);
    expect(codeToolLabel(tool, true)).toBe(active);
  }
});
it('keeps browser fallbacks and other browser tools human-readable', () => {
  expect(browserActionLabel('constructor')).toBe('Use the browser');
  expect(browserActionLabel('future_internal_tool')).toBe('Use the browser');
  expect(browserActivityLabel({ name: 'code_devtools', summary: 'Browser developer tools: future_internal_tool' }, true)).toBe('Using the browser');
  expect(browserActivityLabel({ name: 'browser_scroll', summary: 'scroll_internal' })).toBe('Scrolled the page');
  expect(browserActivityLabel({ name: 'code_read', summary: 'Read a file' })).toBeUndefined();
});

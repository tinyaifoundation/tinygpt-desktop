import { it,expect } from 'vitest';
import { focusedPluginToolQuery } from '../src/core/plugin-tool-query';
import type { ExtensionToolDefinition } from '../src/shared/plugins';
const tool = (originalName: string,label: string,description: string): ExtensionToolDefinition => ({ name:`ext_${originalName}_fixture`,originalName,pluginId:'gmail',label,description,schema:{type:'object'},category:originalName.startsWith('send')?'send':'read' });
const tools = [tool('search_mail','Search Gmail','Search message metadata in the inbox by query and date range.'),tool('read_mail','Read Gmail','Read a message preview by ID.'),tool('send_mail','Send Gmail','Send mail to an explicit address.'),tool('get_mail_profile','Get Gmail profile','Get the connected email account address.')];
it('loads the search action for the natural-language queries from the failed Bot conversation', () => {
  for (const query of ['gmail check email inbox','Gmail search tool name','ext_search_mail Gmail inbox today','Gmail find my emails today','Gmail search tool action']) expect(focusedPluginToolQuery(tools,query,['Gmail','gmail']).map(tool=>tool.originalName)).toEqual(['search_mail']);
});
it('preloads the relevant read action for the latest actual user request', () => {
  expect(focusedPluginToolQuery(tools.filter(tool=>tool.category==='read'),'Can you triage my gmail for emails I got today?',[]).map(tool=>tool.originalName)).toEqual(['search_mail']);
});
it('preserves exact action names and leaves broad or unrelated queries as discovery', () => {
  expect(focusedPluginToolQuery(tools,'Gmail get_mail_profile',['Gmail'])[0].originalName).toBe('get_mail_profile');
  expect(focusedPluginToolQuery(tools,'ext_search_mail_fixture',['Gmail'])[0].originalName).toBe('search_mail');
  expect(focusedPluginToolQuery(tools,'Gmail',['Gmail'])).toEqual([]); expect(focusedPluginToolQuery(tools,'Gmail unrelated astronomy',['Gmail'])).toEqual([]);
});

import { describe, expect, it } from 'vitest';
import { botProviderRequest, botTools } from '../src/main/bot-provider';
import type { ChatWorkerInput } from '../src/shared/chat';
const input: ChatWorkerInput = { runId: 'test', route: 'byok', provider: 'custom', endpoint: 'http://127.0.0.1:1234/v1', model: 'selected-model', protocol: 'openai-compatible', secret: 'vault-only-key', instructions: 'Host approval policy', messages: [{ role: 'user', text: 'Selected branch' }], tools: true };
describe('Bot inference capability', () => {
  it('retains native repair prompts and earlier tool results after the initial user envelope', () => {
    const request = botProviderRequest(input, { messages: [{ role: 'user', content: 'Native envelope' }, { role: 'assistant', tool_calls: [{ id: 'x' }] }, { role: 'tool', tool_call_id: 'x', content: 'Actual tool outcome' }, { role: 'user', content: 'Native follow-up instructions' }] });
    expect(request.body.messages.some((message: any) => message.content === 'Actual tool outcome')).toBe(true); expect(request.body.messages.at(-1).content).toBe('Native follow-up instructions'); expect(JSON.stringify(request.body)).not.toContain('Native envelope');
  });
  it('preserves native background/session history and persona with supplemental context across protocols', () => {
    for (const protocol of ['openai-compatible', 'openai-responses', 'anthropic'] as const) {
      const native = { messages: [{ role: 'user', content: 'Native scheduled task' }, { role: 'assistant', content: 'Native session history' }], input: [{ role: 'user', content: 'Native scheduled task' }], instructions: 'Native identity Milo', system: [{ type: 'text', text: 'Native identity Milo' }], tools: [{ type: 'function', function: { name: 'exec' } }] };
      const result = botProviderRequest({ ...input, protocol }, native, true);
      expect(JSON.stringify(result.body)).toContain('Native scheduled task'); expect(JSON.stringify(result.body)).toContain('Host approval policy'); expect(result.body.tools).toEqual(native.tools); expect(JSON.stringify(result.body)).not.toContain('vault-only-key');
      if (protocol === 'anthropic') expect(result.body.system[0].text).toBe('Native identity Milo');
      else if (protocol === 'openai-responses') expect(result.body.instructions).toContain('Native identity Milo');
    }
  });
  it('captures the selected model, vault credential, host policy and branch while retaining native action results', () => {
    const request = botProviderRequest(input, { model: 'fixture', messages: [{ role: 'system', content: 'Upstream policy' }, { role: 'user', content: 'Native envelope' }, { role: 'assistant', content: null, tool_calls: [{ id: 'x' }] }, { role: 'tool', tool_call_id: 'x', content: 'Saved report' }] });
    expect(request.url).toBe(input.endpoint + '/chat/completions'); expect(request.headers.Authorization).toBe('Bearer vault-only-key'); expect(request.body.model).toBe('selected-model');
    expect(request.body.messages[0].content).toBe('Upstream policy'); expect(request.body.messages[1].content).toContain('Host approval policy'); expect(JSON.stringify(request.body)).not.toContain('vault-only-key'); expect(JSON.stringify(request.body)).not.toContain('Native envelope');
    expect(request.body.messages[2]).toEqual({ role: 'user', content: 'Selected branch' }); expect(request.body.messages.at(-1).content).toBe('Saved report');
  });
  it('preserves Responses function outputs without replaying another branch', () => {
    const request = botProviderRequest({ ...input, protocol: 'openai-responses' }, { input: [{ role: 'user', content: 'Other branch' }, { type: 'function_call_output', call_id: 'x', output: 'Actual outcome' }] });
    expect(request.url).toBe(input.endpoint + '/responses'); expect(request.body.instructions).toContain('Host approval policy'); expect(request.body.input.at(-1).output).toBe('Actual outcome'); expect(JSON.stringify(request.body)).not.toContain('Other branch');
  });
  it('uses Responses image parts and replaces its native input_text user envelope', () => {
    const image = 'data:image/png;base64,AAAA';
    const request = botProviderRequest({ ...input, protocol: 'openai-responses', messages: [{ role: 'user', text: 'Inspect image', images: [image] }] }, { input: [{ role: 'user', content: [{ type: 'input_text', text: 'Native envelope' }] }, { type: 'function_call_output', call_id: 'x', output: 'Actual outcome' }] });
    expect(request.body.input[0].content).toEqual([{ type: 'input_text', text: 'Inspect image' }, { type: 'input_image', image_url: image, detail: 'auto' }]);
    expect(request.body.input).toHaveLength(2); expect(request.body.input[1].output).toBe('Actual outcome'); expect(JSON.stringify(request.body)).not.toContain('Native envelope');
  });
  it('preserves Anthropic tool-result user blocks and uses only the vault key header', () => {
    const request = botProviderRequest({ ...input, protocol: 'anthropic', provider: 'anthropic' }, { messages: [{ role: 'user', content: [{ type: 'text', text: 'Other branch' }] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'x' }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'Actual outcome' }] }] });
    expect(request.url).toBe(input.endpoint + '/messages'); expect(request.headers['x-api-key']).toBe(input.secret); expect(request.headers.Authorization).toBeUndefined(); expect(request.body.messages.at(-1).content[0].type).toBe('tool_result'); expect(JSON.stringify(request.body)).not.toContain('Other branch');
  });
  it('removes action declarations when the captured connection has tools disabled', () => {
    const request = botProviderRequest({ ...input, tools: false }, { messages: [], tools: [{}], tool_choice: 'required' }); expect(request.body.tools).toBeUndefined(); expect(request.body.tool_choice).toBeUndefined(); expect(botTools({ ...input, tools: false })).toEqual([]);
  });
});

  it('uses the configured native context capacity rather than the Chat replay cap', () => {
    const result = botProviderRequest({ ...input, contextWindowTokens: 2000000 }, { messages: [{ role: 'user', content: 'Native compacted checkpoint' }] }, true);
    expect(result.inputTokens).toBe(1883616);
    expect(result.inputTokens).toBeGreaterThan(69713);
    expect(JSON.stringify(result.body)).not.toContain('Selected branch');
    expect(JSON.stringify(result.body)).toContain('Native compacted checkpoint');
  });
  it('offers image actions only when the captured model supports vision', () => {
    expect(botTools(input).some(tool => tool.name === 'view_image')).toBe(false);
    expect(botTools({ ...input, vision: true }).some(tool => tool.name === 'view_image')).toBe(true);
    expect(botTools(input).some(tool => tool.name === 'react_to_message')).toBe(true);
  });

it('keeps Bot plugin schemas private until the discovery tool loads a subset', () => {
  const name = 'ext_read_mail_aaaaaaaaaaaaaaaaaaaaaaaa' as const;
  const configured = { ...input, extensionTools: [{ name, originalName: 'read_mail', pluginId: 'fixture', label: 'Read mail', description: 'PRIVATE_PLUGIN_SCHEMA', schema: { type: 'object', properties: {} }, category: 'read' as const }] };
  expect(botTools(configured).some(tool => tool.name === 'load_tools')).toBe(true);
  expect(botTools(configured).some(tool => tool.name === name)).toBe(false);
  expect(JSON.stringify(botProviderRequest(configured, { messages: [] }).body)).not.toContain('PRIVATE_PLUGIN_SCHEMA');
  expect(botTools({ ...configured, loadedPluginTools: [name] }).some(tool => tool.name === name)).toBe(true);
});

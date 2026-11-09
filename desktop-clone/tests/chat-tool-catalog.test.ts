import { expect, it } from 'vitest';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { runLibreChat } from '../src/core/librechat';
import { WorkToolCatalog } from '../src/core/work-tool-catalog';
import { agentTools } from '../src/core/agent-tools';
import { contextPolicy } from '../src/core/context';
import { builtInModelInfo } from '../src/shared/managed-local';

it('keeps the 64k built-in configuration and reserves output/checkpoint headroom', () => {
  for (const variant of ['included', 'pro'] as const) {
    const info = builtInModelInfo(variant); expect(info.contextWindowTokens).toBe(65536);
    const policy = contextPolicy({ route: 'local', ...info });
    expect(policy.window).toBe(65536); expect(policy.inputTokens + policy.outputTokens).toBeLessThan(65536);
  }
});
it('advertises common Chat tools while keeping specialized tools discoverable and permission-neutral', () => {
  const definitions = agentTools({ mode: 'chat', computer: false, vision: false });
  const catalog = new WorkToolCatalog(definitions, 'chat');
  const names = () => catalog.available().map(tool => tool.name);
  expect(names()).toEqual(expect.arrayContaining(['load_tools', 'calculate', 'present', 'search_sources', 'read_project_file']));
  expect(names()).not.toContain('browser_open'); expect(names()).not.toContain('draft_skill'); expect(names()).not.toContain('generate_image');
  catalog.enable('browser'); expect(names()).toContain('browser_click'); expect(names()).not.toContain('computer_click');
  catalog.enable('skills'); expect(names()).toContain('search_skills'); expect(names()).not.toContain('browser_click');
  expect(catalog.has('work_finish')).toBe(false);
});

it.each([16384, 64000, 65536])('completes a discovered browser workflow at configured context %s', async contextWindowTokens => {
  const tools: string[] = [], bodies: any[] = []; let requests = 0, answer = '';
  const steps: [string, unknown][] = [['load_tools', { group: 'browser', query: 'browser_open browser_type browser_click browser_close' }], ['browser_open', { url: 'https://fixture.invalid' }], ['browser_type', { tabId: '11111111-1111-4111-8111-111111111111', elementId: 't1', text: 'MAPLE' }], ['browser_click', { tabId: '11111111-1111-4111-8111-111111111111', elementId: 't0' }], ['browser_close', { tabId: '11111111-1111-4111-8111-111111111111' }]];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); bodies.push(body); const step = steps[requests++];
    const delta = step ? { role: 'assistant', tool_calls: [{ index: 0, id: 'step-' + requests, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] } : { role: 'assistant', content: 'APPLIED=MAPLE' };
    const frame = (delta: any, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'fixture-' + requests, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: Math.ceil(raw.length / 3), completion_tokens: 50, total_tokens: Math.ceil(raw.length / 3) + 50 } } : {}) }) + '\n\n';
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(delta, null) + frame({}, step ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await runLibreChat({ runId: randomUUID(), route: 'byok', provider: 'custom', model: 'fixture', protocol: 'openai-compatible', secret: 'fixture-only', endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`, contextWindowTokens, maxOutputTokens: 4096, mode: 'chat', tools: true, instructions: 'Use load_tools before browser actions. Verify the outcome.', messages: [{ role: 'user', text: 'Open the fixture, type MAPLE, apply and verify it, then close the tab.' }] }, new AbortController().signal, text => answer += text, async request => {
      tools.push(request.name);
      if (request.validationError) throw Error(request.validationError);
      if (request.name === 'load_tools') return JSON.stringify({ enabled: 'browser', query: (request.input as any).query });
      return JSON.stringify({ tabId: '11111111-1111-4111-8111-111111111111', text: 'APPLIED=MAPLE', snapshotKind: 'accessibility', elements: [{ id: 't1', role: 'textbox', label: 'Audit value' }, { id: 't0', role: 'button', label: 'Apply audit' }] });
    });
    expect(answer).toBe('APPLIED=MAPLE'); expect(tools).toEqual(steps.map(step => step[0]));
    for (const body of bodies) {
      expect(JSON.stringify(body)).toContain('assistant inside TinyGPT Desktop');
      expect(JSON.stringify(body).match(/<tinygpt-runtime-context>/g)).toHaveLength(1);
    }
    expect(bodies[0].tools.some((tool: any) => tool.function.name === 'browser_open')).toBe(false);
    expect(bodies[1].tools.some((tool: any) => tool.function.name === 'browser_open')).toBe(true);
    // The current common catalog, including source readers and bounded browser
    // observations, must still fit within a 16 KiB schema budget at all windows.
    expect(Buffer.byteLength(JSON.stringify(bodies[0].tools))).toBeLessThan(16 * 1024);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);

it('rejects an oversized connected service selection and recovers with one action without sending dormant schemas', async () => {
  const extensionTools = Array.from({ length: 12 }, (_, i) => ({ name: `ext_audit_action_${i}` as const, originalName: `action_${i}`, pluginId: 'audit', label: 'Audit action', category: 'read' as const, description: 'Connected audit action.', schema: { type: 'object', properties: { value: { type: 'string', description: 'q7x9k2m4v8z3b6n1'.repeat(220) } } } }));
  expect(JSON.stringify(extensionTools).length).toBeLessThan(64000);
  expect(new WorkToolCatalog(extensionTools, 'chat').selectionIssue('services', '', 1, text => text.length, [])).toBeUndefined();
  const bodies: any[] = []; const results: any[] = []; let answer = '';
  const steps: [string, unknown][] = [['load_tools', { group: 'services' }], ['calculate', { expression: '1+1' }], ['load_tools', { group: 'services', query: 'action_0' }], ['ext_audit_action_0', {}]];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw); bodies.push(body); const step = steps[bodies.length - 1];
    const delta = step ? { role: 'assistant', tool_calls: [{ index: 0, id: 'selection-' + bodies.length, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] } : { role: 'assistant', content: 'SERVICE_OK' };
    const frame = (delta: any, finish_reason: string | null) => 'data: ' + JSON.stringify({ id: 'selection-' + bodies.length, object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(finish_reason ? { usage: { prompt_tokens: Math.ceil(raw.length / 3), completion_tokens: 50, total_tokens: Math.ceil(raw.length / 3) + 50 } } : {}) }) + '\n\n';
    response.writeHead(200, { 'content-type': 'text/event-stream' }).end(frame(delta, null) + frame({}, step ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await runLibreChat({ runId: randomUUID(), route: 'byok', provider: 'custom', model: 'fixture', protocol: 'openai-compatible', secret: 'fixture-only', endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`, contextWindowTokens: 64000, maxOutputTokens: 4096, mode: 'chat', tools: true, extensionTools, instructions: 'Discover service tools before calling them.', messages: [{ role: 'user', text: 'Discover and use audit action zero.' }] }, new AbortController().signal, text => answer += text, async request => {
      if (request.validationError) return request.validationError;
      const result = request.name === 'load_tools' ? { enabled: 'services', toolNames: (request.input as any).query ? ['ext_audit_action_0'] : extensionTools.map(tool => tool.name) } : { result: 'OK' };
      results.push(result); return JSON.stringify(result);
    });
    expect(answer).toBe('SERVICE_OK');
    const names = (body: any) => body.tools.map((tool: any) => tool.function.name);
    expect(names(bodies[1]).some((name: string) => name.startsWith('ext_'))).toBe(false);
    expect(JSON.stringify(bodies[1].messages)).toContain('TOOL_SELECTION_REQUIRED');
    expect(names(bodies[3]).filter((name: string) => name.startsWith('ext_'))).toEqual(['ext_audit_action_0']);
    expect(results).toHaveLength(4);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);

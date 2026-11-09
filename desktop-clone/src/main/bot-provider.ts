import { isComputerTool } from '../shared/computer';
import type { ChatWorkerInput } from '../shared/chat';
import { endpointSchema } from '../shared/config';
import { effortPayload } from '../core/effort';
import { openRouterPayload } from '../core/openrouter-policy';
import { botContextPolicy } from '../core/bot-context';
import { visionTool } from '../shared/vision';
import { botReactionTool } from '../shared/bot-reactions';
import { toolDefinitions } from '../shared/tools';
import { toolStatusSchema, approvalTextSchema } from '../shared/tool-display';
// Foreground turns use a new native session for each selected TinyGPT branch.
// Only its initial user envelope is replaced; native follow-up/repair prompts
// and all action results belong to OpenClaw and must stay in the current loop.
const firstUserIndex = (messages: any[]) => messages.findIndex(item => item.role === 'user' && (typeof item.content === 'string' || Array.isArray(item.content) && item.content.some((part: any) => ['text', 'input_text'].includes(part.type)) || item.content === undefined));

export function botTools(input: ChatWorkerInput) {
  return input.tools ? [botReactionTool, ...toolDefinitions.filter(tool => !isComputerTool(tool.name) && (input.vision === true || input.imageTools === true || !visionTool(tool.name)) && !['request_plugin_connection', 'present', 'create_project_directory', 'edit_project_file', 'review_project_changes', 'run_project_command', 'copy_skill_files'].includes(tool.name)), ...(input.extensionTools ?? []).filter(tool => input.loadedPluginTools?.includes(tool.name)).map(tool => ({ ...tool, schema: { ...tool.schema, properties: { ...(tool.schema.properties as object ?? {}), __tinygpt_status: toolStatusSchema, __tinygpt_approval: approvalTextSchema } } }))] : [];
}
export function botProviderRequest(input: ChatWorkerInput, native: Record<string, any>, preserveNativeHistory = false) {
  const endpoint = endpointSchema.parse(input.endpoint).replace(/\/+$/, '');
  const policy = botContextPolicy(input);
  const instructions = `${input.instructions.replace('You are TinyGPT, a helpful assistant.', 'You are the user’s personal bot; use the name and identity in your native context.')}\n\nTinyGPT user message IDs available for optional emoji reactions: ${JSON.stringify(input.messages.filter(message => message.role === 'user' && message.id).slice(-8).map(message => ({ id: message.id, text: message.text.slice(0, 200) })))}\nTinyGPT supplemental context: Reply as natural text messages. Send brief useful progress messages before long actions, then complete messages when ready. Do not add HTML/XML wrappers, bracketed stage/status labels, or internal reply-routing tags to visible text. Preserve ordinary Markdown, links and literal code examples when useful. Preserve your OpenClaw identity, instructions, memory and native tool policies. Native tools in this request are available alongside TinyGPT's supplemental actions. Native commands follow OpenClaw approvals; TinyGPT actions follow TinyGPT approvals. Never bypass either denial. TinyGPT status/permission argument metadata applies only to tinygpt_action, not native tools.\n${input.tools ? `The supplemental tinygpt_action tool accepts {name,input}. These additional actions connect TinyGPT plugins and saved content; follow their schemas exactly:\n${JSON.stringify(botTools(input))}` : 'Tools are disabled for this inference connection.'}`;
  const history = input.messages.map(message => ({ role: message.role, content: message.images?.length ? [{ type: 'text', text: message.text }, ...message.images.map(url => ({ type: 'image_url', image_url: { url } }))] : message.text }));
  // OpenClaw owns the current turn's action loop. TinyGPT supplies the selected
  // branch/history and authorized context, including saved outcomes for Continue.
  let body: Record<string, any> = { ...native, model: input.model, stream: true };
  let path = '/chat/completions';
  if (input.protocol === 'openai-responses') {
    path = '/responses';
    const nativeHistory = Array.isArray(native.input) ? native.input : [];
    const lastUser = firstUserIndex(nativeHistory);
    const messages = history.map(message => ({ ...message, content: typeof message.content === 'string' ? message.content : message.content.map(part => 'text' in part ? { type: 'input_text', text: part.text } : { type: 'input_image', image_url: part.image_url.url, detail: 'auto' }) }));
    body.input = preserveNativeHistory ? nativeHistory : [...messages, ...nativeHistory.slice(lastUser + 1)]; body.instructions = [native.instructions, instructions].filter(Boolean).join('\n\n'); body.max_output_tokens = policy.outputTokens;
    delete body.messages; delete body.max_tokens;
  } else if (input.protocol === 'anthropic') {
    path = '/messages';
    const nativeHistory = Array.isArray(native.messages) ? native.messages : [];
    const lastUser = firstUserIndex(nativeHistory);
    const messages = history.map(message => ({ ...message, content: typeof message.content === 'string' ? message.content : message.content.map(part => {
      if (part.type === 'text') return part;
      const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec('image_url' in part ? part.image_url.url : '');
      if (!match) throw new Error('This image could not be sent. Attach it again.');
      return { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } };
    }) }));
    body.messages = preserveNativeHistory ? nativeHistory : [...messages, ...nativeHistory.slice(lastUser + 1)]; body.system = [...(Array.isArray(native.system) ? native.system : native.system ? [{ type: 'text', text: native.system }] : []), { type: 'text', text: instructions }]; body.max_tokens = policy.outputTokens;
  } else {
    const nativeHistory = Array.isArray(native.messages) ? native.messages : [];
    const lastUser = firstUserIndex(nativeHistory);
    body.messages = preserveNativeHistory ? [...nativeHistory, { role: 'system', content: instructions }] : [...nativeHistory.filter(message => ['system', 'developer'].includes(message.role)), { role: 'system', content: instructions }, ...history, ...nativeHistory.slice(lastUser + 1).filter(message => !['system', 'developer'].includes(message.role))]; body.max_tokens = policy.outputTokens;
    delete body.max_completion_tokens;
  }
  if (!input.tools) { delete body.tools; delete body.tool_choice; }
  // Never retain upstream's synthetic credentials, model or reasoning defaults.
  delete body.reasoning; delete body.reasoning_effort; delete body.thinking;
  body = openRouterPayload(effortPayload(body, input, policy.outputTokens), input);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (input.protocol === 'anthropic') { headers['x-api-key'] = input.secret ?? ''; headers['anthropic-version'] = '2023-06-01'; }
  else headers.Authorization = `Bearer ${input.secret || 'tinygpt-local'}`;
  return { url: endpoint + path, body, headers, inputTokens: policy.inputTokens };
}

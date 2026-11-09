import type { ChatWorkerInput } from '../shared/chat';

/** Local OpenAI-compatible servers accept JSON-schema constrained decoding.
 * Keep this opt-in and metadata-only; ordinary answers and tools are unchanged. */
export function structuredMetadataFetch(request: typeof fetch, input: ChatWorkerInput): typeof fetch {
  return (resource, options) => {
    if (input.provider === 'local' && input.purpose === 'metadata' && input.outputSchema && typeof options?.body === 'string') {
      const body = JSON.parse(options.body);
      options = { ...options, body: JSON.stringify({ ...body,response_format: { type: 'json_schema',json_schema: { name: 'scheduled_suggestions',strict: true,schema: input.outputSchema } } }) };
    }
    return request(resource,options);
  };
}

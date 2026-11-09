/** LangChain's completion adapter reads reasoning_content, whereas OpenRouter
 * uses reasoning/reasoning_details. Normalize only this transport boundary.
 * No tool arguments are executed or presented as completed actions here. */
export function openRouterStreamFetch(request: typeof fetch, preparingTool: () => void): typeof fetch {
  return async (resource, options) => {
    const response = await request(resource, options);
    if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream')) return response;
    const decoder = new TextDecoder(); const encoder = new TextEncoder(); let pending = ''; let announced = false;
    function frame(event: string): string {
      const lines = event.split(/\r?\n/); const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return event;
      try {
        const value = JSON.parse(data); let changed = false;
        for (const choice of value.choices ?? []) {
          const delta = choice.delta; if (!delta) continue;
          if (!announced && delta.tool_calls?.length) { announced = true; preparingTool(); }
          if (delta.reasoning_content == null) {
            const reasoning = typeof delta.reasoning === 'string' ? delta.reasoning : Array.isArray(delta.reasoning_details)
              ? delta.reasoning_details.filter((part: any) => part.type === 'reasoning.text' && typeof part.text === 'string').map((part: any) => part.text).join('') : '';
            if (reasoning) { delta.reasoning_content = reasoning; changed = true; }
          }
        }
        return changed ? [...lines.filter(line => !line.startsWith('data:')), `data: ${JSON.stringify(value)}`].join('\n') : event;
      } catch { return event; }
    }
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        pending += decoder.decode(chunk, { stream: true });
        let boundary: RegExpExecArray | null;
        while ((boundary = /\r?\n\r?\n/.exec(pending))) { const event = pending.slice(0, boundary.index); pending = pending.slice(boundary.index + boundary[0].length); controller.enqueue(encoder.encode(frame(event) + '\n\n')); }
        if (pending.length > 2000000) throw new Error('Provider stream frame exceeded its supported size.');
      },
      flush(controller) { pending += decoder.decode(); if (pending) controller.enqueue(encoder.encode(frame(pending))); },
    }));
    const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-encoding');
    return new Response(body, { status: response.status, statusText: response.statusText, headers });
  };
}

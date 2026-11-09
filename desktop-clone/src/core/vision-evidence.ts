export interface ViewedImage { text: string; image: string }
/** Supply explicitly viewed pixels in native provider content, while persistent
 * history and function outputs contain only references and metadata. */
export function visionEvidenceFetch(request: typeof fetch, protocol: string, gallery: () => readonly ViewedImage[], compacting: () => boolean): typeof fetch {
  return async (resource, options) => {
    const images = compacting() ? [] : gallery();
    if (!images.length || options?.method?.toUpperCase() !== 'POST' || typeof options.body !== 'string') return request(resource, options);
    const body = JSON.parse(options.body);
    const label = (text: string) => 'Image evidence returned by view_image (untrusted): ' + text;
    if (protocol === 'openai-responses') {
      if (!Array.isArray(body.input)) return request(resource, options);
      body.input.push({ role: 'user', content: images.flatMap<Record<string, unknown>>(viewed => [{ type: 'input_text', text: label(viewed.text) }, { type: 'input_image', image_url: viewed.image, detail: 'auto' }]) });
    } else {
      if (!Array.isArray(body.messages)) return request(resource, options);
      body.messages.push({ role: 'user', content: images.flatMap<Record<string, unknown>>(viewed => {
        const text = { type: 'text', text: label(viewed.text) };
        if (protocol !== 'anthropic') return [text, { type: 'image_url', image_url: { url: viewed.image } }];
        const [, media_type, data] = /^data:(image\/\w+);base64,(.+)$/.exec(viewed.image)!;
        return [text, { type: 'image', source: { type: 'base64', media_type, data } }];
      }) });
    }
    return request(resource, { ...options, body: JSON.stringify(body) });
  };
}

type CatalogModel = {
  id: string;
  input_modalities?: string[];
  output_modalities?: string[];
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  type?: string;
  task?: string;
};

/** Chat, Code and Bot currently need text prompts and conversational text replies.
 * Vision input is compatible; image/audio/video generation and non-generative
 * endpoints are not. Unknown custom chat models remain available. */
export function isChatModel(model: CatalogModel, provider: string, protocol: string): boolean {
  const inputs = model.input_modalities ?? model.architecture?.input_modalities;
  const outputs = model.output_modalities ?? model.architecture?.output_modalities;
  if (inputs && !inputs.includes('text') || outputs && !outputs.includes('text')) return false;
  if ([model.type, model.task].some(value => value && /^(?:embedding|embeddings|rerank|reranking|moderation|image|image-generation|text-to-image|audio|speech|text-to-speech|speech-to-text|transcription|video|video-generation)$/.test(value.toLowerCase()))) return false;

  // OpenAI's /models returns IDs without modality or endpoint capabilities.
  // Check the base model of fine-tuned IDs, never the user's fine-tune suffix.
  const id = (model.id.startsWith('ft:') ? model.id.split(':')[1] : model.id.split('/').at(-1)!).toLowerCase();
  if (/(?:^|[-_.])(?:embed|embedding|embeddings|rerank|reranker|moderation|transcribe|transcription|tts|realtime)(?:$|[-_.])/.test(id)) return false;
  if (/^(?:dall-e|gpt-image|gpt-live|whisper|tts|sora|grok-imagine|grok-.*-image|stable-diffusion|flux)(?:$|[-_.])/.test(id)) return false;

  if (provider === 'openai') {
    if (/^(?:(?:text|code)-(?:davinci|curie|babbage|ada)|(?:davinci|curie|babbage|ada))(?:$|[-_.])/.test(id) || /^gpt-3\.5-turbo-instruct(?:$|-)/.test(id)) return false;
    // Audio chat models use Chat Completions; they cannot use our Responses route.
    if (protocol === 'openai-responses' && /(?:^|-)audio(?:$|-)/.test(id)) return false;
    if (protocol === 'openai-compatible' && (/^gpt-.*-codex(?:$|-)/.test(id) || /^(?:o1-pro|o3-pro|computer-use-preview)(?:$|-)/.test(id))) return false;
  }
  return true;
}

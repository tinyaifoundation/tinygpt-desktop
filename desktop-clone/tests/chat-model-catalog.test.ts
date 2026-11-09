import { describe, expect, it, vi } from 'vitest';
import { checkConnection } from '../src/core/connections';
import { defaultSettings } from '../src/shared/config';

const response = (data: unknown) => new Response(JSON.stringify(data));

describe('models usable by the composer', () => {
  it('excludes specialized OpenAI endpoints while retaining chat, reasoning, vision and chat fine-tunes', async () => {
    const compatible = ['gpt-4.1', 'gpt-4o', 'o3', 'gpt-5.3-codex', 'ft:gpt-4.1:team:image-helper:id', 'future-chat-model'];
    const incompatible = ['gpt-image-1', 'gpt-image-2.5-sunburst', 'dall-e-3', 'sora-2', 'text-embedding-3-small', 'omni-moderation-latest', 'whisper-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'gpt-4o-transcribe', 'gpt-4o-transcribe-diarize', 'gpt-realtime', 'gpt-4o-realtime-preview', 'gpt-live-1', 'gpt-audio', 'gpt-4o-audio-preview', 'babbage-002', 'davinci-002', 'gpt-3.5-turbo-instruct', 'ft:davinci-002:team:chat:id'];
    const settings = { ...defaultSettings, byok: { ...defaultSettings.byok, model: 'gpt-image-1' } };
    const report = await checkConnection(settings, 'byok', 'key', async () => response({ data: [...compatible, ...incompatible].map(id => ({ id })) }));
    expect(report.models).toEqual([...compatible].sort()); expect(report.modelAvailable).toBe(false);
    expect(report.modelDetails?.map(model => model.id)).toEqual(report.models);
  });
  it('keeps text-capable vision and audio chat models when their chat endpoint is used', async () => {
    const settings = { ...defaultSettings, byok: { ...defaultSettings.byok, protocol: 'openai-compatible' as const } };
    const report = await checkConnection(settings, 'byok', 'key', async () => response({ data: [{ id: 'gpt-audio' }, { id: 'gpt-4o-audio-preview' }, { id: 'gpt-4o', input_modalities: ['text', 'image'], output_modalities: ['text'] }, { id: 'gpt-image-1' }] }));
    expect(report.models).toEqual(['gpt-4o', 'gpt-4o-audio-preview', 'gpt-audio']);
    expect(report.modelDetails?.find(model => model.id === 'gpt-4o')?.images).toBe(true);
  });
  it('uses explicit modalities and tasks for custom providers, preserving unfamiliar text models', async () => {
    const settings = { ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'custom' as const, protocol: 'openai-compatible' as const } };
    const report = await checkConnection(settings, 'byok', 'key', async () => response({ data: [
      { id: 'vision-chat', architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } },
      { id: 'multimodal-chat', output_modalities: ['text', 'image'] }, { id: 'unknown-chat' },
      { id: 'image-only', output_modalities: ['image'] }, { id: 'video-only', architecture: { output_modalities: ['video'] } },
      { id: 'speech-only', output_modalities: ['audio'] }, { id: 'no-output', output_modalities: [] },
      { id: 'audio-transcript', input_modalities: ['audio'], output_modalities: ['text'] },
      { id: 'vector-model', type: 'embedding' }, { id: 'ranking-model', task: 'reranking' }, { id: 'nomic-embed-text' },
    ] }));
    expect(report.models).toEqual(['multimodal-chat', 'unknown-chat', 'vision-chat']);
    expect(report.modelDetails?.find(model => model.id === 'vision-chat')?.images).toBe(true);
  });
  it('reads the native xAI language catalog with full modalities and aliases, excluding generation models', async () => {
    const settings = { ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'xai' as const, protocol: 'openai-compatible' as const, endpoint: 'https://api.x.ai/v1', model: 'grok-current' } };
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response({ models: [
      { id: 'grok-chat', aliases: ['grok-current', 'grok-chat'], input_modalities: ['text', 'image'], output_modalities: ['text'], context_length: 131072 },
      { id: 'new-generation-name', input_modalities: ['text'], output_modalities: ['video'] },
      { id: 'grok-imagine-image', output_modalities: ['image'] },
    ] }));
    const report = await checkConnection(settings, 'byok', 'key', request);
    expect(request.mock.calls[0][0]).toBe('https://api.x.ai/v1/language-models');
    expect(request.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer key' });
    expect(report.models).toEqual(['grok-chat', 'grok-current']); expect(report.modelAvailable).toBe(true);
    expect(report.modelDetails?.find(model => model.id === 'grok-current')).toMatchObject({ images: true, contextWindowTokens: 131072 });
  });
  it('uses standard discovery for compatible xAI providers at another endpoint', async () => {
    const settings = { ...defaultSettings, byok: { ...defaultSettings.byok, provider: 'xai' as const, endpoint: 'https://compatible.example/v1' } };
    const request = vi.fn<typeof fetch>().mockImplementation(async () => response({ data: [{ id: 'chat' }] }));
    expect((await checkConnection(settings, 'byok', 'key', request)).models).toEqual(['chat']);
    expect(request.mock.calls[0][0]).toBe('https://compatible.example/v1/models');
  });
  it('excludes known specialized models from local catalogs without modality metadata', async () => {
    const report = await checkConnection(defaultSettings, 'local', undefined, async () => response({ data: [{ id: 'my-chat-model' }, { id: 'nomic-embed-text:latest' }, { id: 'bge-reranker-v2-m3' }] }));
    expect(report.models).toEqual(['my-chat-model']);
  });
});

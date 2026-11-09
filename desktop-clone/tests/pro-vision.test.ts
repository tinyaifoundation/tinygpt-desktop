import { expect, it, vi } from 'vitest';
import { analyzeProImage } from '../src/main/pro-vision';
import { managedLocalPins, managedServerArgs } from '../src/main/managed-local';

const image = 'data:image/png;base64,aW1hZ2U=';
it('uses authenticated Pro image input without redirects or reasoning overhead', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'TASK COMPLETE, 42 Mbps' }, finish_reason: 'stop' }] })));
  expect(await analyzeProImage('http://127.0.0.1:9000/v1', 'fixture-key', image, 'Read the heading and speed.', new AbortController().signal, request)).toEqual({ observation: 'TASK COMPLETE, 42 Mbps', incomplete: false });
  const [url, options] = request.mock.calls[0];
  expect(url).toBe('http://127.0.0.1:9000/v1/chat/completions'); expect(options?.redirect).toBe('error');
  expect(options?.headers).toMatchObject({ Authorization: 'Bearer fixture-key' });
  const body = JSON.parse(options!.body as string);
  expect(body).toMatchObject({ model: 'tinygpt-pro', reasoning_effort: 'none', stream: false });
  expect(body.messages[1].content[0].image_url.url).toBe(image); expect(body.messages[0].content).toContain('untrusted');
});

it('rejects remote endpoints, malformed images, cancellation and empty observations', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }] })));
  await expect(analyzeProImage('https://example.com/v1', 'key', image, 'Read', new AbortController().signal, request)).rejects.toMatchObject({ code: 'VISION_UNAVAILABLE' });
  await expect(analyzeProImage('http://localhost/v1', 'key', 'https://example.com/image.png', 'Read', new AbortController().signal, request)).rejects.toMatchObject({ code: 'VISION_IMAGE_INVALID' });
  await expect(analyzeProImage('http://localhost/v1', 'key', image, 'Read', AbortSignal.abort(Error('Stopped')), request)).rejects.toThrow('Stopped');
  expect(request).not.toHaveBeenCalled();
  await expect(analyzeProImage('http://localhost/v1', 'key', image, 'Read', new AbortController().signal, request)).rejects.toMatchObject({ code: 'VISION_EMPTY' });
});

it('configures the pinned Pro vision tower without adding another GPU model', () => {
  expect(managedLocalPins.proVision.size).toBe(629246976); expect(managedLocalPins.proVision.sha256).toBe('6807ede61d570bb86ba34b756a0fa109edc33668604de867c6ea6d8f1d631903');
  const args = managedServerArgs('model.gguf', 9000, 'key', 'CUDA', false, 'pro', 'vision.gguf');
  expect(args[args.indexOf('--mmproj') + 1]).toBe('vision.gguf'); expect(args).toContain('--no-mmproj-offload'); expect(args[args.indexOf('--ctx-size') + 1]).toBe('65536');
});

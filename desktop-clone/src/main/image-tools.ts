import { nativeImage } from 'electron';
import { basename } from 'node:path';
import { readLimited, scopedPath } from './files';
import type { HistoryStore } from './history';
import type { BrowserController } from './browser';
import { fileDestination, prepareFileDestination } from './file-destination';
import { imageReference } from '../shared/vision';
import type { ImageCrop } from '../shared/vision';
import { createHash } from 'node:crypto';
export interface ToolImage { image: string; mime: string; size: number; width: number; height: number; originalWidth?: number; originalHeight?: number }
export interface ImageMetadata { title: string; imageReference: string; width: number; height: number; originalWidth?: number; originalHeight?: number; imageSha256?: string; crop?: ImageCrop }
export interface ViewedImage { metadata: ImageMetadata; transport: { type: string; text: string; image: string }; original?: Buffer }

export function normalizeToolImage(bytes: Buffer, crop?: ImageCrop): ToolImage {
  // Decode actual pixels, rather than trusting the extension or a remote URL.
  let image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('Choose a readable PNG, JPEG, or WebP image.');
  const original = image.getSize();
  if (original.width * original.height > 32000000) throw new Error('This image has too many pixels. Use an image with 32 megapixels or fewer.');
  if (crop) { if (crop.x + crop.width > original.width || crop.y + crop.height > original.height) throw new Error('The image crop is outside the original image. Use its originalWidth and originalHeight.'); image = image.crop(crop); }
  const selected = image.getSize(), ratio = Math.min(1, 1536 / Math.max(selected.width, selected.height));
  const normalized = image.resize({ width: Math.max(1, Math.round(selected.width * ratio)), height: Math.max(1, Math.round(selected.height * ratio)) });
  // Prefer lossless pixels for text, diagrams and transparency. Fall back to
  // JPEG only when a photograph's PNG would exceed the transport budget.
  let encoded = normalized.toPNG(); let mime = 'image/png';
  if (encoded.length > 2_000_000) { encoded = normalized.toJPEG(85); mime = 'image/jpeg'; }
  if (encoded.length > 2_000_000) throw new Error('This image is too large to view. Use a smaller image.');
  return { image: `data:${mime};base64,${encoded.toString('base64')}`, mime, size: encoded.length, ...normalized.getSize(), originalWidth: original.width, originalHeight: original.height };
}
export class ImageTools {
  constructor(private history: HistoryStore, private browser: BrowserController, private normalize = normalizeToolImage) {}
  async view(conversationId: string, requested: string, signal: AbortSignal, crop?: ImageCrop): Promise<ViewedImage> {
    signal.throwIfAborted();
    let source, pixels, original: Buffer;
    const reference = /^tinygpt-image:([a-f0-9-]{36})$/i.exec(requested);
    if (reference) {
      source = this.history.sources.detail(conversationId, reference[1]);
      if (!source.image) throw new Error('This reference is not an image.');
      const data = /^data:image\/(?:jpeg|png|webp);base64,([A-Za-z0-9+/]+=*)$/.exec(source.image);
      if (!data || data[1].length > 20_971_520) throw new Error('Choose a readable PNG, JPEG, or WebP image.');
      original = this.history.sources.originalImage(conversationId, source.id) ?? Buffer.from(data[1], 'base64');
      pixels = this.normalize(original, crop);
    } else {
      const { root } = await prepareFileDestination(this.history, conversationId, signal);
      const path = await scopedPath(root, requested);
      original = await readLimited(path); const preview = this.normalize(original); pixels = crop ? this.normalize(original, crop) : preview; signal.throwIfAborted();
      if (root !== fileDestination(this.history, conversationId).root || path !== await scopedPath(root, requested)) throw new Error('The Project folder changed. Select it again.');
      // Immutable snapshots keep old references meaningful after a file changes.
      source = this.history.sources.add(conversationId, { kind: 'project-file', title: basename(path), text: '', ...preview, originalImage: original });
    }
    signal.throwIfAborted();
    const metadata: ImageMetadata = { title: source.title, imageReference: imageReference(source.id), width: pixels.width, height: pixels.height, originalWidth: pixels.originalWidth ?? pixels.width, originalHeight: pixels.originalHeight ?? pixels.height, imageSha256: createHash('sha256').update(original).digest('hex'), ...(crop ? { crop } : {}) };
    return { metadata, transport: { type: 'tinygpt-image-result', text: JSON.stringify(metadata), image: pixels.image }, original };
  }
  async screenshot(conversationId: string, tabId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const capture = await this.browser.capture(conversationId, tabId);
    signal.throwIfAborted();
    const data = /^data:image\/png;base64,([A-Za-z0-9+/]+=*)$/.exec(capture);
    if (!data || data[1].length > 20_971_520) throw new Error('This image is too large to view. Use a smaller image.');
    return this.saveCapture(conversationId, Buffer.from(data[1], 'base64'), 'Browser screenshot', { tabId });
  }
  saveCapture(conversationId: string, bytes: Buffer, title: string, context: Record<string, string> = {}) {
    const pixels = this.normalize(bytes);
    const source = this.history.sources.add(conversationId, { kind: 'project-file', title, text: '', ...pixels, originalImage: bytes, privateImage: true });
    return { title: source.title, imageReference: imageReference(source.id), width: pixels.width, height: pixels.height, originalWidth: pixels.originalWidth ?? pixels.width, originalHeight: pixels.originalHeight ?? pixels.height, ...context,
      nextRead: { tool: 'view_image', input: { image: imageReference(source.id), question: 'Describe the visible controls and dialog. State which details cannot be read.' } }, nextAction: 'Use view_image with this exact image reference. If not loaded, load_tools group:images query:view_image. Capture alone does not inspect pixels. Do not read an image reference as a file or capture the desktop instead. Use current browser snapshots for live control references.' };
  }
}

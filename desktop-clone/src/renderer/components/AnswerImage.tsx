import { createContext, useContext, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from 'react';
import type { DesktopBridge } from '../../shared/contracts';
import { answerUrlTransform, savedAnswerImage } from '../../core/answer-images';
const ImageContext = createContext<{ resolve: (id: string) => Promise<string | null> }>({ resolve: async () => null });
export function AnswerImagesProvider({ bridge, conversationId, children }: { bridge: DesktopBridge; conversationId: string | null; children: ReactNode }) {
  const value = useMemo(() => {
    // Share reads across Markdown and generated UI, scoped to this conversation.
    const images = new Map<string, Promise<string | null>>();
    return { resolve: (id: string) => {
      if (!conversationId) return Promise.resolve(null);
      let pending = images.get(id);
      if (!pending) {
        pending = bridge.source(conversationId, id).then(result => result.ok && result.value.image && answerUrlTransform(result.value.image, 'src') ? result.value.image : null).catch(() => null);
        if (images.size >= 32) images.delete(images.keys().next().value!);
        images.set(id, pending);
      }
      return pending;
    } };
  }, [bridge, conversationId]);
  return <ImageContext.Provider value={value}>{children}</ImageContext.Provider>;
}
export function AnswerImage({ src, alt, title }: ComponentProps<'img'> & { node?: unknown }) {
  const { resolve } = useContext(ImageContext);
  const reference = typeof src === 'string' ? src : '';
  const id = savedAnswerImage(reference);
  const [resolved, setResolved] = useState<{ reference: string; image: string | null } | null>(null);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    let live = true;
    if (id) void resolve(id).then(image => { if (live) setResolved({ reference, image }); });
    return () => { live = false; };
  }, [id, reference, resolve]);
  const image = id ? resolved?.reference === reference ? resolved.image : undefined : answerUrlTransform(reference, 'src') || null;
  if (image === undefined) return <span className="answer-image-loading" role="status" aria-label={'Loading image: ' + (alt || 'Image')} />;
  if (!image || failed === image) return <span className="answer-image-unavailable" role="img" aria-label={alt || 'Image unavailable'}>{alt ? alt + ' · Image unavailable' : 'Image unavailable'}</span>;
  return <img className="answer-image" src={image} alt={alt || ''} title={title} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(image)} />;
}

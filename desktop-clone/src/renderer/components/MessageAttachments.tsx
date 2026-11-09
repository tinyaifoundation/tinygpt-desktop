import { useContext, useEffect, useRef, useState } from 'react';
import type { SourceSummary } from '../../shared/tools';
import { Image, LoaderCircle, Paperclip, RefreshCw } from '../icons';
import { ConversationActions } from './ConversationMessages';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
import '../message-attachments.css';

// A visible message can contain eight photos. Keep historical thumbnails from
// flooding the relay when several messages enter the viewport together.
let loading = 0;
const waiting: Array<() => void> = [];
function imageRequest<T>(read: () => Promise<T>): Promise<T> {
  return new Promise((resolve,reject) => {
    const start = () => { loading++; void Promise.resolve().then(read).then(resolve,reject).finally(() => { loading--; waiting.shift()?.(); }); };
    if (loading < 4) start(); else waiting.push(start);
  });
}
const validImage = (value: unknown): value is string => typeof value === 'string' && /^data:image\/(?:jpeg|png|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(value);

function MessageImage({ source }: { source: SourceSummary }) {
  const actions = useContext(ConversationActions), current = useRef(actions); current.current = actions;
  const button = useRef<HTMLButtonElement>(null);
  const [image,setImage] = useState(''), [full,setFull] = useState(''), [open,setOpen] = useState(false);
  const [error,setError] = useState(false), [fullError,setFullError] = useState(false), [retry,setRetry] = useState(0), [fullRetry,setFullRetry] = useState(0);
  const thumbnail = useRef('');
  async function read(fullSize: boolean) {
    const actions = current.current;
    if (actions.previewAttachment) return (await actions.previewAttachment(source.conversationId,source.id,fullSize)).image;
    const result = await actions.bridge?.source(source.conversationId,source.id);
    if (!result?.ok || !result.value.image) throw Error('Image unavailable.');
    return result.value.image;
  }
  useEffect(() => {
    let active = true, started = false;
    setError(false);
    const load = () => {
      if (started) return; started = true;
      void imageRequest(async () => { if (!active) return ''; return read(false); }).then(value => {
        if (!active) return;
        if (!validImage(value)) throw Error('Image unavailable.');
        thumbnail.current = value; setImage(value);
      }).catch(() => { if (active) setError(true); });
    };
    const observer = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => { if (entries.some(entry=>entry.isIntersecting)) { observer?.disconnect(); load(); } },{rootMargin:'200px'}) : null;
    if (observer && button.current) observer.observe(button.current); else load();
    return () => { active = false; observer?.disconnect(); };
  },[source.id,source.conversationId,retry]);
  useEffect(() => {
    if (!open || full) return;
    let active = true; setFullError(false);
    void imageRequest(async () => {
      if (!active) return '';
      // The existing desktop source bridge already returns the full image.
      return current.current.previewAttachment ? read(true) : thumbnail.current;
    }).then(value => { if (active) { if (!validImage(value)) throw Error('Image unavailable.'); setFull(value); } }).catch(() => { if (active) setFullError(true); });
    return () => { active = false; };
  },[open,full,fullRetry,source.id,source.conversationId]);
  return <>
    <button ref={button} type="button" className="message-image-attachment" data-slot="message-image-attachment" aria-label={`${error?'Retry image preview':'Preview image'}: ${source.title}`} title={source.title} aria-busy={!image&&!error} onClick={() => { if (error) { setError(false); setRetry(value=>value+1); } else if (image) setOpen(true); }}>
      {image ? <img src={image} alt={source.title} loading="lazy" onError={()=>{setImage('');setError(true);}} /> : error ? <RefreshCw aria-hidden="true" /> : <Image aria-hidden="true" />}
    </button>
    <Dialog open={open} change={setOpen} title="Image preview" titleHidden className="message-image-dialog"><img src={full||image} alt={source.title} />{!full&&(fullError?<button type="button" className="message-image-retry" onClick={()=>setFullRetry(value=>value+1)}><RefreshCw />Load larger image</button>:<span className="message-image-loading" role="status"><LoaderCircle className="animate-spin" />Loading image…</span>)}</Dialog>
  </>;
}

export function MessageAttachments({ sources }: { sources: SourceSummary[] }) {
  const actions = useContext(ConversationActions);
  if (!sources.length) return null;
  return <div className="message-attachments">{sources.map(source => source.kind === 'image' || source.mime.startsWith('image/')
    ? <MessageImage key={source.id} source={source} />
    : <Button key={source.id} variant="outline" size="sm" className="max-w-full rounded-xl text-xs" onClick={()=>actions.openSource(source.id)}><Paperclip className="size-3.5 shrink-0" /><span className="truncate">{source.title}</span>{source.processing && source.processing.status !== 'ready' && <span>{source.processing.status === 'preparing' ? 'Preparing…' : source.processing.status === 'partial' ? 'Partial' : 'Could not read'}</span>}</Button>)}</div>;
}

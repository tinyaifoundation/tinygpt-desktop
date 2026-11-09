import { useContext,useEffect,useRef,useState } from 'react';
import type { ToolActivity } from '../../shared/tools';
import type { ToolImagePreview as Preview } from '../../shared/remote-media';
import { ConversationActions } from './ConversationMessages';
import { LoaderCircle,RefreshCw } from '../icons';
import { Button } from './ui/button';
import { Dialog } from './ui/dialog';
export function ToolImagePreview({ tool }: { tool: ToolActivity }) {
  const actions = useContext(ConversationActions), current = useRef(actions); current.current = actions;
  const [preview,setPreview] = useState<Preview | null>(null), [error,setError] = useState(''), [open,setOpen] = useState(false), [retry,setRetry] = useState(0);
  useEffect(() => {
    let active = true; setError(''); setPreview(null);
    void (async()=>{
      const value = current.current.previewTool ? await current.current.previewTool(tool.conversationId,tool.id) : await current.current.bridge?.toolPreview(tool.conversationId,tool.id).then(result=>{if(!result.ok)throw Error(result.error);return result.value;});
      if (!value || !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value.image)) throw Error('Preview unavailable.');
      if (active) setPreview(value);
    })().catch(()=>{if(active)setError('Couldn’t load this preview.');}); return()=>{active=false;};
  },[tool.id,tool.conversationId,retry]);
  return <div className="tool-image-preview" data-slot="tool-image-preview">{preview ? <><button type="button" className="tool-image-open" aria-label={'Open image preview: '+preview.title} onClick={()=>setOpen(true)}><img src={preview.image} alt={preview.title} loading="lazy" /><span>{preview.width} × {preview.height}</span></button><Dialog open={open} change={setOpen} title={preview.title} className="tool-image-dialog"><img src={preview.image} alt={preview.title} /></Dialog></> : error ? <div className="tool-image-placeholder"><p>{error}</p><Button variant="ghost" onClick={()=>setRetry(value=>value+1)}><RefreshCw />Try again</Button></div> : <div className="tool-image-placeholder" role="status"><LoaderCircle className="animate-spin" />Loading preview…</div>}</div>;
}

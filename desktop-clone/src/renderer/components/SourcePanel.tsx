import { useEffect, useRef, useState } from 'react';
import { Search, X, Trash2, FileText } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import type { ChatUpdate, Conversation } from '../../shared/chat';
import type { SourceDetail, SourceExcerpt } from '../../shared/tools';
import { Button } from './ui/button';
import { Input } from './ui/input';
export function SourcePanel({ conversation, bridge, update, previewId, close, openWeb, openImage }: { conversation: Conversation; bridge: DesktopBridge; update: (value: ChatUpdate) => void; previewId: string | null; close: () => void; openWeb?: (url: string) => void; openImage?: (source: SourceDetail) => void }) {
  const [query, setQuery] = useState(''); const [hits, setHits] = useState<SourceExcerpt[] | null>(null); const [detail, setDetail] = useState<SourceDetail | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const previewRequest = useRef(0);
  useEffect(() => () => { previewRequest.current++; }, [conversation.id]);
  async function preview(id: string, navigate = true) {
    const request = ++previewRequest.current;
    setError('');
    try {
      const result = await bridge.source(conversation.id, id);
      if (request !== previewRequest.current) return;
      if (!result.ok) { setError(result.error); return; }
      setDetail(result.value);
      if (navigate && result.value.image && openImage) openImage(result.value);
      if (navigate && result.value.kind === 'page' && result.value.url && openWeb) openWeb(result.value.url);
    } catch { if (request === previewRequest.current) setError('The source could not be loaded.'); }
  }
  useEffect(() => { if (previewId) void preview(previewId, false); return () => { previewRequest.current++; }; }, [previewId, conversation.id]);
  async function search() { previewRequest.current++; setBusy(true); setError(''); setDetail(null); try { const result = await bridge.searchSources(conversation.id, query); if (result.ok) setHits(result.value); else setError(result.error); } catch { setError('The sources could not be searched.'); } finally { setBusy(false); } }
  return <aside aria-label="Saved sources" className="workspace-sources flex min-h-0 flex-1 flex-col overflow-auto bg-background p-5">
    <div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-semibold">Sources</h2><Button variant="ghost" size="icon" aria-label="Close sources" onClick={close}><X /></Button></div>
    <p className="mb-4 text-xs leading-5 text-muted-foreground">{conversation.projectId ? 'Saved sources are available to chats in this Project.' : 'Saved sources stay in this conversation.'} Files and pages are indexed locally.</p>
    <form className="mb-4 flex gap-2" onSubmit={event => { event.preventDefault(); void search(); }}><Input aria-label="Search saved sources" placeholder="Search your sources" value={query} onChange={event => setQuery(event.target.value)} /><Button size="icon" aria-label="Search sources" disabled={busy || !query.trim()}><Search /></Button></form>
    {error && <p role="alert" className="mb-4 text-xs text-destructive">{error}</p>}
    {detail ? <div className="min-w-0"><Button size="sm" variant="ghost" onClick={() => setDetail(null)}>All sources</Button><h3 className="my-3 break-words text-sm font-medium">{detail.title}</h3>{detail.url && <p className="mb-3 break-all text-xs text-muted-foreground">{detail.url}</p>}{detail.image ? <img src={detail.image} alt={detail.title} className="content-source-image border" /> : <pre className="whitespace-pre-wrap break-words text-xs leading-6">{detail.text || 'This source has no extracted text.'}</pre>}</div> : hits ? <div className="space-y-4"><Button size="sm" variant="ghost" onClick={() => setHits(null)}>All sources</Button>{!hits.length && <p className="text-sm text-muted-foreground">No matching passages yet.</p>}{hits.map((hit, index) => <button key={`${hit.sourceId}:${index}`} className="w-full rounded-lg border p-3 text-left" onClick={() => void preview(hit.sourceId)}><p className="mb-2 text-sm font-medium">{hit.title}</p><p className="text-xs leading-5 text-muted-foreground">{hit.text.slice(0, 500)}</p></button>)}</div> : <div className="space-y-3">{!conversation.sources.length && <p className="text-sm text-muted-foreground">Attach a document, read a Project file, or save a web page to begin.</p>}{conversation.sources.map(source => <div key={source.id} className="rounded-lg border p-3"><div className="flex items-start gap-2"><FileText className="mt-0.5 size-4 shrink-0" /><button className="min-w-0 flex-1 break-words text-left text-sm font-medium" onClick={() => void preview(source.id)}>{source.title}</button><Button size="icon" variant="ghost" aria-label={`Remove source ${source.title}`} onClick={() => void (async () => { const result = await bridge.removeSource(conversation.id, source.id); if (result.ok) update(result.value); else setError(result.error); })()}><Trash2 className="size-3.5" /></Button></div>{source.kind === 'page' && <Button size="sm" variant="ghost" className="mt-1 h-6 px-0 text-xs text-muted-foreground" onClick={() => void preview(source.id, false)}>View saved snapshot</Button>}<p className="mt-2 text-xs text-muted-foreground">{source.kind.replace('-', ' ')} · {Math.max(1, Math.round(source.size / 1024))} KB</p></div>)}</div>}
  </aside>;
}

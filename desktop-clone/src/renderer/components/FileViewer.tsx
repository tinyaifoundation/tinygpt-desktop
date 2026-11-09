import { useEffect, useRef, useState } from 'react';
import { EditorView, basicSetup } from 'codemirror';
import { Decoration, ViewPlugin, type DecorationSet } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { EditorState, Compartment } from '@codemirror/state';
import { openSearchPanel } from '@codemirror/search';
import { Search, WrapText } from '../icons';
import { EditorScrollbars } from './EditorScrollbars';
import { ControlTooltip } from './ui/tooltip';
import { WorkspaceScroll } from './WorkspaceScroll';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { unifiedMergeView } from '@codemirror/merge';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseDocument } from 'yaml';
import type { FilePreview } from '../../shared/workspace';
const bytes = (file: FilePreview) => Uint8Array.from(atob(file.bytesBase64 ?? ''), char => char.charCodeAt(0));
const indentationGuides = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(update: import('@codemirror/view').ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = this.build(update.view); }
  build(view: EditorView) { const builder = new RangeSetBuilder<Decoration>(); for (const { from, to } of view.visibleRanges) { for (let pos = from; pos <= to;) { const line = view.state.doc.lineAt(pos); const whitespace = /^[\t ]+/.exec(line.text)?.[0]; if (whitespace) builder.add(line.from, line.from + whitespace.length, Decoration.mark({ class: 'cm-indent-guides' })); pos = line.to + 1; } } return builder.finish(); }
}, { decorations: value => value.decorations });

const codeHighlight = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier, tags.operatorKeyword], color: 'var(--code-keyword)' },
  { tag: [tags.string, tags.regexp], color: 'var(--code-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--code-number)' },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], color: 'var(--code-function)' },
  { tag: [tags.typeName, tags.className], color: 'var(--code-type)' },
  { tag: [tags.comment, tags.meta], color: 'var(--muted-foreground)', fontStyle: 'italic' },
]));

function TextEditor({ file, text, change, original, findRequest }: { file: FilePreview; text: string; change: (text: string) => void; original?: string; findRequest?: number }) {
  const [viewport,setViewport]=useState<HTMLElement|null>(null); const [cursor,setCursor]=useState({line:1,column:1}); const [wrapped,setWrapped]=useState(false); const wrap=useRef(new Compartment());
  const container = useRef<HTMLDivElement>(null); const editor = useRef<EditorView | null>(null); const changeRef = useRef(change); changeRef.current = change;
  useEffect(() => {
    if (!container.current) return;
    const extension = file.name.split('.').at(-1)?.toLowerCase();
    const language = ['js', 'jsx', 'ts', 'tsx'].includes(extension ?? '') ? javascript({ typescript: extension?.startsWith('ts'), jsx: extension?.endsWith('x') }) : extension === 'json' ? json() : ['md', 'mdx'].includes(extension ?? '') ? markdown() : extension === 'css' ? css() : ['html', 'htm', 'xml'].includes(extension ?? '') ? html() : extension === 'py' ? python() : ['yaml', 'yml'].includes(extension ?? '') ? yaml() : [];
    const view = new EditorView({ parent: container.current, state: EditorState.create({ doc: text, extensions: [basicSetup, language, codeHighlight, indentationGuides, EditorState.tabSize.of(2), wrap.current.of([]), ...(original !== undefined ? unifiedMergeView({ original, mergeControls: false, diffConfig: { timeout: 50, scanLimit: 5000 }, collapseUnchanged: { margin: 3, minSize: 12 } }) : []), EditorState.readOnly.of(original !== undefined || !file.writable), EditorView.editable.of(original === undefined && file.writable), EditorView.contentAttributes.of({ 'aria-label': `${original !== undefined ? 'Diff for' : 'Edit'} ${file.name}` }), EditorView.updateListener.of(update => { if (update.docChanged) changeRef.current(update.state.doc.toString()); if(update.selectionSet||update.docChanged){const head=update.state.selection.main.head;const line=update.state.doc.lineAt(head);setCursor({line:line.number,column:head-line.from+1});} }), EditorView.theme({ '&': { height: '100%', backgroundColor: 'var(--background)', color: 'var(--foreground)' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--font-mono, monospace)', fontSize: '12px', lineHeight: '1.7' }, '.cm-content': { padding: '8px 0' }, '.cm-gutters': { backgroundColor: 'var(--background)', color: 'var(--muted-foreground)', border: 'none', paddingRight: '12px' }, '.cm-cursor': { borderLeftColor: 'var(--foreground)' }, '&.cm-focused': { outline: 'none' }, '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--accent) 45%, transparent)' }, '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--accent)' } })] }) }); editor.current = view; setViewport(view.scrollDOM);
    return () => { view.destroy(); editor.current = null; };
  }, [file.id, file.writable, file.name, original]);
  useEffect(() => { const view = editor.current; if (view && view.state.doc.toString() !== text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); }, [text]);
  useEffect(()=>{editor.current?.dispatch({effects:wrap.current.reconfigure(wrapped?EditorView.lineWrapping:[])});},[wrapped,file.id,original]);
  useEffect(() => { if (findRequest && editor.current) openSearchPanel(editor.current); }, [findRequest]);
  return <><div className="workspace-editor-surface"><div className="workspace-code-editor" ref={container}/><EditorScrollbars viewport={viewport}/></div><footer className="workspace-editor-status"><ControlTooltip label="Find in file"><button aria-label="Find in file" onClick={()=>{if(editor.current)openSearchPanel(editor.current);}}><Search/></button></ControlTooltip><ControlTooltip label="Toggle word wrap"><button aria-label="Toggle word wrap" aria-pressed={wrapped} onClick={()=>setWrapped(value=>!value)}><WrapText/></button></ControlTooltip><span>Ln {cursor.line}, Col {cursor.column}</span><span className="workspace-status-spacer"/><span>{file.name.split('.').at(-1)?.toUpperCase()??'TEXT'}</span><span>UTF-8</span><span>{text.includes('\r\n')?'CRLF':'LF'}</span><span>{original!==undefined?'Diff':file.writable?'Editable':'Read only'}</span></footer></>;
}

export function FileDiffViewer({ name, before, after }: { name: string; before: string; after: string }) {
  return <TextEditor file={{ id: name, name, kind: 'text', writable: false } as FilePreview} text={after} original={before} change={() => {}} />;
}

function PdfPreview({ file }: { file: FilePreview }) {
  const canvas = useRef<HTMLCanvasElement>(null); const [page, setPage] = useState(1); const [count, setCount] = useState(0); const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false; let task: import('pdfjs-dist').PDFDocumentLoadingTask | undefined; let render: import('pdfjs-dist').RenderTask | undefined;
    void (async () => {
      const pdf = await import('pdfjs-dist'); const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url'); pdf.GlobalWorkerOptions.workerSrc = worker.default;
      if (disposed) return;
      task = pdf.getDocument({ data: bytes(file) }); const document = await task.promise; if (disposed) return; setCount(document.numPages);
      const pdfPage = await document.getPage(Math.min(page, document.numPages)); const target = canvas.current; if (!target || disposed) return;
      const natural = pdfPage.getViewport({ scale: 1 }); const scale = Math.min(2, Math.max(0.35, ((target.parentElement?.clientWidth ?? 600) - 32) / natural.width)); const viewport = pdfPage.getViewport({ scale: scale * devicePixelRatio });
      target.width = viewport.width; target.height = viewport.height; target.style.width = `${viewport.width / devicePixelRatio}px`; target.style.height = `${viewport.height / devicePixelRatio}px`;
      render = pdfPage.render({ canvas: target, viewport }); await render.promise;
    })().catch(() => { if (!disposed) setError('This PDF could not be previewed. Save a copy to open it in another app.'); });
    return () => { disposed = true; render?.cancel(); void task?.destroy(); };
  }, [file.id, file.sha256, page]);
  return <div className="workspace-pdf"><nav aria-label="PDF pages"><button disabled={page <= 1} onClick={() => setPage(value => value - 1)}>Previous</button><span>{page} / {count || '…'}</span><button disabled={!count || page >= count} onClick={() => setPage(value => value + 1)}>Next</button></nav>{error ? <p role="alert">{error}</p> : <WorkspaceScroll viewportClassName="workspace-pdf-page"><canvas ref={canvas} aria-label={`PDF page ${page}`} /></WorkspaceScroll>}</div>;
}

function OfficePreview({ file }: { file: FilePreview }) {
  const container = useRef<HTMLDivElement>(null); const [error, setError] = useState(''); const [documentHtml, setDocumentHtml] = useState(''); const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[]>([]); const [sheet, setSheet] = useState(0);
  useEffect(() => {
    let disposed = false; let viewer: { destroy: () => void } | undefined; setError(''); setSheets([]); setDocumentHtml(''); setSheet(0);
    void (async () => {
      if (file.kind === 'docx') {
        const { renderAsync } = await import('docx-preview'); if (disposed) return; const body = document.createElement('div'); const styles = document.createElement('div');
        await renderAsync(bytes(file), body, styles, { inWrapper: true, breakPages: true, useBase64URL: true, renderAltChunks: false });
        if (!disposed) setDocumentHtml(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data: blob:">${styles.innerHTML}</head><body>${body.innerHTML}</body></html>`);
      } else if (file.kind === 'xlsx') {
        const { default: Excel } = await import('exceljs'); if (disposed) return; const workbook = new Excel.Workbook(); await workbook.xlsx.load(bytes(file) as never);
        const cellText = (value: unknown): string => { if (value && typeof value === 'object') { const cell = value as { text?: string; result?: unknown; formula?: string; richText?: { text: string }[] }; return cell.text ?? (cell.result != null ? String(cell.result) : cell.richText?.map(part => part.text).join('') ?? (cell.formula ? `=${cell.formula}` : '')); } return value == null ? '' : String(value); };
        const values = workbook.worksheets.map(item => { const rows: string[][] = []; for (let index = 1; index <= Math.min(item.rowCount, 2000); index++) { const row = item.getRow(index); const cells = []; for (let column = 1; column <= Math.min(item.columnCount, 100); column++) cells.push(cellText(row.getCell(column).value)); rows.push(cells); } return { name: item.name, rows }; });
        if (!disposed) setSheets(values);
      } else {
        const { PptxViewer, RECOMMENDED_ZIP_LIMITS } = await import('@aiden0z/pptx-renderer'); if (disposed || !container.current) return;
        const opened = await PptxViewer.open(bytes(file), container.current, { zipLimits: RECOMMENDED_ZIP_LIMITS, lazySlides: true, lazyMedia: true, listOptions: { windowed: true, initialSlides: 4, batchSize: 4 }, pdfjs: false }); if (disposed) opened.destroy(); else viewer = opened;
      }
    })().catch(() => { if (!disposed) setError('This document could not be previewed. Save a copy to open it in another app.'); });
    return () => { disposed = true; viewer?.destroy(); container.current?.replaceChildren(); };
  }, [file.id, file.sha256]);
  if (error) return <p className="workspace-note" role="alert">{error}</p>;
  if (file.kind === 'docx') return documentHtml ? <iframe className="workspace-document-frame" title={file.name} sandbox="" srcDoc={documentHtml} /> : <p className="workspace-note">Opening document…</p>;
  if (file.kind === 'xlsx') return <div className="workspace-sheet"><nav aria-label="Workbook sheets">{sheets.map((item, index) => <button key={item.name} aria-pressed={sheet === index} onClick={() => setSheet(index)}>{item.name}</button>)}</nav><WorkspaceScroll viewportClassName="workspace-sheet-scroll"><table><tbody>{sheets[sheet]?.rows.map((row, index) => <tr key={index}><th>{index + 1}</th>{row.map((cell, column) => <td key={column}>{cell}</td>)}</tr>)}</tbody></table>{!sheets.length && <p className="workspace-note">Opening workbook…</p>}</WorkspaceScroll><p className="workspace-note">Preview shows up to 2,000 rows and 100 columns per sheet.</p></div>;
  return <div className="workspace-slides" ref={container} />;
}

function MarkdownPreview({ text, openWeb }: { text: string; openWeb: (url: string) => void }) {
  let content = text; let properties: [string, unknown][] = [];
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (frontmatter && frontmatter[1].length < 50000) { try { const document = parseDocument(frontmatter[1]); if (!document.errors.length) { const value: unknown = document.toJS({ maxAliasCount: 20 }); if (value && typeof value === 'object' && !Array.isArray(value)) { JSON.stringify(value); properties = Object.entries(value).slice(0, 50); content = text.slice(frontmatter[0].length); } } } catch { /* Invalid or circular frontmatter stays visible as source text. */ } }
  return <WorkspaceScroll viewportClassName="workspace-markdown">{properties.length > 0 && <section className="workspace-properties" aria-label="Document properties"><h2>Properties</h2><dl>{properties.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')}</dd></div>)}</dl></section>}<Markdown remarkPlugins={[remarkGfm]} components={{ a: ({ href, children }) => <a href={href} onClick={event => { event.preventDefault(); if (href && /^https?:\/\//i.test(href)) openWeb(href); }}>{children}</a>, img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image]'}</span> }}>{content}</Markdown></WorkspaceScroll>;
}
export function FileViewer({ file, text = file.text ?? '', change, raw, openWeb, findRequest }: { file: FilePreview; text?: string; change: (text: string) => void; raw: boolean; openWeb: (url: string) => void; findRequest?: number }) {
  if (file.kind === 'text') return !raw && /\.(md|mdx)$/i.test(file.name) ? <MarkdownPreview text={text} openWeb={openWeb} /> : <TextEditor file={file} text={text} change={change} findRequest={findRequest} />;
  if (file.kind === 'image') return <WorkspaceScroll viewportClassName="workspace-image"><img src={`data:${file.mime};base64,${file.bytesBase64}`} alt={file.name} /></WorkspaceScroll>;
  if (file.kind === 'pdf') return <PdfPreview file={file} />;
  if (['docx', 'xlsx', 'pptx'].includes(file.kind)) return <OfficePreview file={file} />;
  return <p className="workspace-note">Preview isn’t available for this file type. Save a copy or reveal it to open it with another app.</p>;
}

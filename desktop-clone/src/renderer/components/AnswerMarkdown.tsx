import { isValidElement, memo, useContext, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { useAuiState } from '@assistant-ui/react';
import { MarkdownTextPrimitive, type CodeHeaderProps, type SyntaxHighlighterProps } from '@assistant-ui/react-markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, FileText } from '../icons';
import { AnswerImage } from './AnswerImage';
import { answerUrlTransform } from '../../core/answer-images';
import { citationIndex } from '../../core/citations';
import { CitedText, Citation, MessageCitations } from './MessageCitations';
import { SyntaxHighlighter as ShikiHighlighter } from './elements/shiki-highlighter';
import { MermaidDiagram } from './elements/mermaid-diagram';
import { Button } from './ui/button';

function CodeHeader({ language, code }: CodeHeaderProps) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); } }, [copied]);
  return <div className="code-header"><span>{language === 'mermaid' ? 'Mermaid diagram' : language || 'Code'}</span><Button variant="ghost" size="sm" aria-label="Copy code" onClick={() => { void navigator.clipboard.writeText(code).then(() => { setCopied(true); setFailed(false); }, () => setFailed(true)); }}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{failed ? 'Copy unavailable' : copied ? 'Copied' : 'Copy code'}</Button></div>;
}
function flattenText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  return isValidElement<{ children?: ReactNode }>(node) ? flattenText(node.props.children) : '';
}
function MarkdownLink({ href, children, node: _node, ...props }: ComponentProps<'a'> & { node?: unknown }) {
  const { sources } = useContext(MessageCitations);
  const index = citationIndex(sources, href, flattenText(children));
  if (index >= 0) return <Citation index={index} />;
  return <a {...props} href={href} className={href?.startsWith('tinygpt-source:') ? 'source-chip' : undefined}>{href?.startsWith('tinygpt-source:') && <FileText className="mr-1 inline size-3 align-middle" />}{children}</a>;
}
function MarkdownTable({ node: _node, ...props }: ComponentProps<'table'> & { node?: unknown }) {
  return <div className="answer-table-scroll" role="region" aria-label="Table" tabIndex={0}><table {...props} /></div>;
}
const cited = <T extends 'p' | 'li' | 'td' | 'th' | 'strong' | 'em' | 'del'>(Tag: T) =>
  function CitedElement({ children, node: _node, ...props }: ComponentProps<T> & { node?: unknown }) {
    // These tags all receive the same display-only Markdown attributes.
    const Element = Tag as 'p';
    return <Element {...props as ComponentProps<'p'>}><CitedText>{children}</CitedText></Element>;
  };
function SyntaxHighlighter({ language, code }: SyntaxHighlighterProps) {
  const streaming = useAuiState(s => s.message.status?.type === 'running');
  return <ShikiHighlighter code={code} language={language || 'text'} streaming={streaming} />;
}
function RuntimeMermaid({ code }: SyntaxHighlighterProps) {
  const streaming = useAuiState(s => s.message.status?.type === 'running');
  return <MermaidDiagram code={code} streaming={streaming} />;
}
const markdownComponents = {
  CodeHeader, SyntaxHighlighter, a: MarkdownLink, img: AnswerImage, table: MarkdownTable,
  p: cited('p'), li: cited('li'), td: cited('td'), th: cited('th'), strong: cited('strong'), em: cited('em'), del: cited('del'),
};
const markdownPlugins = [remarkGfm];
const languageComponents = { mermaid: { SyntaxHighlighter: RuntimeMermaid } };
const urlTransform = answerUrlTransform;

// Same renderer vocabulary for streamed answers and strings inside generated UI.
export const MarkdownText = memo(function MarkdownText() {
  return <div className="chat-prose"><MarkdownTextPrimitive smooth={false} defer components={markdownComponents} componentsByLanguage={languageComponents} remarkPlugins={markdownPlugins} urlTransform={urlTransform} /></div>;
});
function StandaloneCode({ children }: ComponentProps<'pre'>) {
  const child = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
  const code = flattenText(child?.props.children ?? children).replace(/\n$/, '');
  const language = /language-([^\s]+)/.exec(child?.props.className ?? '')?.[1] ?? 'text';
  return <><CodeHeader code={code} language={language} />{language === 'mermaid' ? <MermaidDiagram code={code} /> : <ShikiHighlighter code={code} language={language} />}</>;
}
const standaloneComponents = { ...markdownComponents, pre: StandaloneCode };
export const MarkdownBody = memo(function MarkdownBody({ value }: { value: string }) {
  return <div className="chat-prose"><ReactMarkdown components={standaloneComponents} remarkPlugins={markdownPlugins} urlTransform={urlTransform}>{value}</ReactMarkdown></div>;
});

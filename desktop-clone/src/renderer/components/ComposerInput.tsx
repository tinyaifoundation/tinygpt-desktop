import { ComposerPrimitive, useAuiState } from '@assistant-ui/react';
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { ScrollArea } from './ui/scroll-area';
import { composerSkillPrefix, removeComposerSkill } from '../lib/composer-skill';

/** The textarea grows with the draft; the shared ScrollArea owns overflow.
 * Keep the native textarea and assistant-ui's IME, draft and submit behavior. */
export function ComposerInput({ scrollClassName = '', onHeightChange, highlightSkillCommand = false, references, onBackspaceAtStart, onKeyDown, ...props }: Omit<ComponentProps<typeof ComposerPrimitive.Input>, 'ref' | 'asChild' | 'render' | 'submitOnEnter'> & { scrollClassName?: string; highlightSkillCommand?: boolean; references?: ReactNode; onBackspaceAtStart?: () => void }) {
  const text = useAuiState(state => state.composer.text);
  const lastWarm = useRef(0);
  useEffect(() => {
    if (!text.trim()) return;
    const timer = setTimeout(() => {
      if (Date.now() - lastWarm.current < 15000) return;
      lastWarm.current = Date.now(); void window.tinygpt?.warmModel?.().catch(() => {});
    }, 300);
    return () => clearTimeout(timer);
  }, [text]);
  const prefix = highlightSkillCommand ? composerSkillPrefix(text) : undefined;
  const input = useRef<HTMLTextAreaElement>(null);
  const highlight = useRef<HTMLDivElement>(null);
  const inlineReferences = useRef<HTMLDivElement>(null);
  const textStart = useRef<HTMLSpanElement>(null);
  const [referenceLayout, setReferenceLayout] = useState({ indent: 0, paddingTop: 0 });
  const measureReferences = () => {
    const field = input.current, container = inlineReferences.current, marker = textStart.current;
    if (!field || !container || !marker) return;
    // Reserve only the first line's space for references. Later lines retain the
    // full native textarea width, including when references wrap onto more rows.
    const previousPadding = field.style.paddingTop;
    field.style.paddingTop = '';
    const style = getComputedStyle(field);
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingRight = parseFloat(style.paddingRight) || 0;
    for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing'] as const) container.style[property] = style[property];
    field.style.paddingTop = previousPadding;
    container.style.top = `${paddingTop}px`;
    container.style.left = `${paddingLeft}px`;
    container.style.width = `${field.clientWidth - paddingLeft - paddingRight}px`;
    const next = { indent: marker.offsetLeft, paddingTop: paddingTop + marker.offsetTop };
    setReferenceLayout(current => current.indent === next.indent && current.paddingTop === next.paddingTop ? current : next);
  };
  const measure = useRef(measureReferences); measure.current = measureReferences;
  useLayoutEffect(measureReferences);
  useLayoutEffect(() => {
    const field = input.current, container = inlineReferences.current;
    if (!field || !container) return;
    const resize = new ResizeObserver(() => measure.current());
    resize.observe(field); resize.observe(container);
    let alive = true;
    void document.fonts.ready.then(() => { if (alive) measure.current(); });
    return () => { alive = false; resize.disconnect(); };
  }, [!!references]);
  const syncHighlight = () => {
    if (!input.current || !highlight.current) return;
    const style = getComputedStyle(input.current);
    for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'tabSize', 'textAlign', 'textIndent', 'wordBreak', 'overflowWrap', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'boxSizing'] as const) highlight.current.style[property] = style[property];
    highlight.current.style.width = `${input.current.offsetWidth}px`;
  };
  const sync = useRef(syncHighlight); sync.current = syncHighlight;
  useLayoutEffect(syncHighlight);
  const reveal = useRef<() => void>(() => {});
  useLayoutEffect(() => {
    const field = input.current;
    const viewport = field?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    if (!field || !viewport) return;
    let frame = 0;
    // A mirror locates the caret in wrapped text without changing the selection.
    const mirror = document.createElement('div'), marker = document.createElement('span');
    mirror.setAttribute('aria-hidden', 'true');
    Object.assign(mirror.style, { position: 'fixed', top: '0', left: '-100000px', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', pointerEvents: 'none' });
    document.body.append(mirror);
    const showCaret = () => {
      frame = 0;
      sync.current();
      if (document.activeElement !== field) return;
      if (viewport.scrollHeight <= viewport.clientHeight) { viewport.scrollTop = 0; return; }
      const style = getComputedStyle(field);
      for (const property of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'tabSize', 'textIndent', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'boxSizing'] as const) mirror.style[property] = style[property];
      mirror.style.width = `${field.clientWidth}px`;
      const position = field.selectionDirection === 'backward' ? field.selectionStart : field.selectionEnd;
      if (position === 0) { viewport.scrollTop = 0; return; }
      if (position === field.value.length) { viewport.scrollTop = viewport.scrollHeight; return; }
      mirror.textContent = field.value.slice(0, position);
      marker.textContent = '\u200b'; mirror.append(marker);
      const top = field.getBoundingClientRect().top - viewport.getBoundingClientRect().top + viewport.scrollTop + marker.offsetTop;
      const bottom = top + (Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5);
      if (top < viewport.scrollTop) viewport.scrollTop = Math.max(0, top);
      else if (bottom > viewport.scrollTop + viewport.clientHeight) viewport.scrollTop = bottom - viewport.clientHeight;
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(showCaret); };
    reveal.current = schedule;
    field.addEventListener('input', schedule); field.addEventListener('focus', schedule);
    document.addEventListener('selectionchange', schedule);
    const resize = new ResizeObserver(schedule); resize.observe(field); resize.observe(viewport);
    schedule();
    return () => { reveal.current = () => {}; cancelAnimationFrame(frame); resize.disconnect(); field.removeEventListener('input', schedule); field.removeEventListener('focus', schedule); document.removeEventListener('selectionchange', schedule); mirror.remove(); };
  }, []);
  return <ScrollArea type="auto" className={`composer-input-scroll ${scrollClassName}`} viewportClassName="composer-input-viewport" viewportTabIndex={-1}>
    <div className="composer-input-highlight-wrap">
      {references && <div ref={inlineReferences} className="composer-inline-references">{references}<span ref={textStart} className="composer-inline-text-start" aria-hidden="true" /></div>}
      {prefix && <div ref={highlight} className="composer-input-highlight" aria-hidden="true"><span className="composer-skill-token">{text.slice(0, prefix.end)}</span>{text.slice(prefix.end)}{text.endsWith('\n') ? '\u200b' : null}</div>}
      <ComposerPrimitive.Input {...props} style={{ ...props.style, ...(references ? { textIndent: referenceLayout.indent, paddingTop: referenceLayout.paddingTop } : {}) }} className={`${props.className ?? ''}${prefix ? ' has-skill-command' : ''}`} ref={input} onKeyDown={event => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) return;
        const field = event.currentTarget;
        if (field.selectionStart === 0 && field.selectionEnd === 0 && onBackspaceAtStart) {
          if (event.key === 'Backspace') { event.preventDefault(); onBackspaceAtStart(); return; }
          if (event.key === 'ArrowLeft' && !event.shiftKey) {
            const references = field.closest('.composer')?.querySelectorAll<HTMLElement>('[data-composer-reference]');
            if (references?.length) { event.preventDefault(); references[references.length - 1].focus(); return; }
          }
        }
        if (!highlightSkillCommand) return;
        const removed = removeComposerSkill(field.value, event.key, field.selectionStart, field.selectionEnd);
        if (!removed) return;
        event.preventDefault();
        field.setRangeText(removed.text, 0, field.value.length, 'start');
        field.setSelectionRange(removed.caret, removed.caret);
        field.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: event.key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward' }));
      }} onHeightChange={(height, meta) => { onHeightChange?.(height, meta); reveal.current(); }} />
    </div>
  </ScrollArea>;
}

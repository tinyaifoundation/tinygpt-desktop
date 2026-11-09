import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import { useEffect, useRef, useState } from 'react';
import type { DesktopBridge } from '../../shared/contracts';
import type { BrowserScroll } from '../../shared/workspace';
import { ScrollBar } from './ui/scroll-area';

// The page lives in a sandboxed native view. This real Radix scroll area mirrors
// its vertical geometry in an adjacent gutter, outside the native view's bounds.
export function BrowserPageScrollbar({ bridge, conversationId, tabId, enabled }: { bridge: DesktopBridge; conversationId: string; tabId: string; enabled: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<BrowserScroll>({ height: 1, viewport: 1, top: 0 });
  const [height, setHeight] = useState(1);
  const lastApplied = useRef(0); const lastInput = useRef(0); const frame = useRef(0);
  function synchronize(value: BrowserScroll) {
    const element = viewport.current;
    if (!element || performance.now() - lastInput.current < 200) return;
    lastApplied.current = Math.max(0, Math.min(element.scrollHeight - element.clientHeight, value.top / Math.max(1, value.viewport) * element.clientHeight));
    if (Math.abs(element.scrollTop - lastApplied.current) > 1) element.scrollTop = lastApplied.current;
  }
  useEffect(() => {
    const element = viewport.current; if (!element) return;
    const resize = () => setHeight(element.clientHeight || 1); resize();
    const observer = new ResizeObserver(resize); observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let disposed = false; let pending = false;
    async function refresh() {
      if (pending || disposed) return; pending = true;
      try {
        const result = await bridge.workspaceBrowserScroll({ conversationId, tabId });
        if (!disposed && result.ok) {
          setMetrics(previous => result.value.height === previous.height && result.value.viewport === previous.viewport && result.value.top === previous.top ? previous : result.value);
          synchronize(result.value);
        }
      } catch { /* A navigating/closed page is sampled again on the next tick. */ }
      finally { pending = false; }
    }
    void refresh(); const timer = window.setInterval(() => void refresh(), 150);
    return () => { disposed = true; clearInterval(timer); cancelAnimationFrame(frame.current); };
  }, [enabled, bridge, conversationId, tabId]);
  const contentHeight = Math.max(height, metrics.height / Math.max(1, metrics.viewport) * height);
  useEffect(() => {
    synchronize(metrics);
  }, [metrics, height]);
  return <ScrollAreaPrimitive.Root type="always" className="browser-page-scrollbar" data-slot="scroll-area" aria-hidden={!enabled}>
    <ScrollAreaPrimitive.Viewport ref={viewport} className="browser-page-scroll-viewport" data-slot="scroll-area-viewport" tabIndex={enabled ? 0 : -1} aria-label="Scroll browser page" onKeyDown={event => {
      if (!enabled || event.altKey || event.metaKey) return;
      const element = event.currentTarget;
      const top = event.key === 'Home' ? 0 : event.key === 'End' ? element.scrollHeight : event.key === 'PageDown' ? element.scrollTop + element.clientHeight * .9 : event.key === 'PageUp' ? element.scrollTop - element.clientHeight * .9 : event.key === 'ArrowDown' ? element.scrollTop + 40 : event.key === 'ArrowUp' ? element.scrollTop - 40 : null;
      if (top !== null) { event.preventDefault(); element.scrollTo({ top, behavior: 'instant' }); }
    }} onScroll={event => {
      const element = event.currentTarget;
      if (!enabled || Math.abs(element.scrollTop - lastApplied.current) < 1) return;
      lastApplied.current = element.scrollTop;
      lastInput.current = performance.now(); cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        const position = Math.max(0, Math.min(1, element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight)));
        void bridge.workspaceBrowserScroll({ conversationId, tabId, position }).catch(() => {});
      });
    }}><div style={{ height: contentHeight, width: 1 }} /></ScrollAreaPrimitive.Viewport>
    {enabled && <ScrollBar className="browser-page-scroll-track" />}
  </ScrollAreaPrimitive.Root>;
}

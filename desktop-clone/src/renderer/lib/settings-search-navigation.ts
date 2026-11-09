import { useEffect, type RefObject } from 'react';
import { normalizeSettingsSearch, type SettingsSearchEntry } from './settings-search';

export type SettingsSearchRequest = { entry: SettingsSearchEntry; key: number };
function findTarget(root: Element, entry: SettingsSearchEntry): HTMLElement | undefined {
  if (entry.selector) {
    const target = root.querySelector<HTMLElement>(entry.selector);
    if (target) return target;
  }
  const candidates = root.querySelectorAll<HTMLElement>('[data-setting-title], [aria-label], .settings-row-title, .device-metric-label, .catalog-card-copy strong, h1, h2, h3, label, button');
  for (const title of entry.targets) {
    const normalized = normalizeSettingsSearch(title);
    for (const candidate of candidates) {
      if (candidate.matches('input[type="file"], [hidden]')) continue;
      const label = candidate.getAttribute('data-setting-title') ?? candidate.getAttribute('aria-label') ?? candidate.textContent ?? '';
      if (normalizeSettingsSearch(label) === normalized) return candidate;
    }
  }
}

export function useSettingsSearchNavigation(request: SettingsSearchRequest | null, section: string, content: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    if (!request || request.entry.section !== section || !content.current) return;
    let finished = false, opened = false;
    let highlighted: HTMLElement | undefined;
    let highlightTimer: ReturnType<typeof setTimeout> | undefined;
    const root = content.current;
    const highlight = (target: HTMLElement) => {
      finished = true; observer.disconnect(); clearTimeout(deadline);
      for (let parent: HTMLElement | null = target.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true;
      highlighted = target.closest<HTMLElement>('.settings-row, .profile-edit-field, .device-metric, .catalog-card, .settings-content-group, .profile-hero, .profile-usage') ?? target;
      highlighted.dataset.settingsSearchMatch = 'true';
      highlighted.scrollIntoView({ block: 'center', inline: 'nearest', behavior: document.documentElement.dataset.motion === 'reduce' ? 'auto' : 'smooth' });
      const control = target.matches('button, input:not([type="file"]), select, textarea, [tabindex]') ? target : highlighted.querySelector<HTMLElement>('button:not(:disabled), input:not([type="file"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)');
      if (control && !control.matches(':disabled')) control.focus({ preventScroll: true });
      highlightTimer = setTimeout(() => highlighted?.removeAttribute('data-settings-search-match'), 5000);
    };
    const locate = () => {
      if (finished) return;
      if (request.entry.open && !opened) {
        const button = root.querySelector<HTMLButtonElement>(request.entry.open.selector);
        if (button && !button.disabled) {
          opened = true;
          // Search can open a management dialog or an edit form. It never
          // invokes a toggle, save, download, pairing, or destructive action.
          if (!request.entry.open.text || button.textContent?.trim() === request.entry.open.text) { button.click(); return; }
        }
        if (!opened) return;
      }
      const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')];
      for (const scope of dialogs.length && request.entry.open ? dialogs : [root]) {
        const target = findTarget(scope, request.entry);
        if (target) { highlight(target); return; }
      }
    };
    const observer = new MutationObserver(locate);
    observer.observe(document.body, { childList: true, subtree: true });
    const deadline = setTimeout(() => {
      if (finished) return;
      // Conditional controls stay conditional. Land at their section rather
      // than enabling a feature to make its dependent fields appear.
      const fallback = document.querySelector<HTMLElement>('[role="dialog"] h2') ?? root.querySelector<HTMLElement>('h1, h2');
      if (fallback) highlight(fallback); else observer.disconnect();
    }, 4000);
    locate();
    return () => { finished = true; observer.disconnect(); clearTimeout(deadline); clearTimeout(highlightTimer); highlighted?.removeAttribute('data-settings-search-match'); };
  }, [request, section, content]);
}

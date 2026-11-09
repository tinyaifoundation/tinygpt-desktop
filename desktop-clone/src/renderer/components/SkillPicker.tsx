import { useEffect, useId, useRef, useState } from 'react';
import { useAui, useAuiState } from '@assistant-ui/react';
import { BookOpen } from '../icons';
import type { DesktopBridge } from '../../shared/contracts';
import type { PluginView } from '../../shared/plugins';
import type { Mode } from '../../shared/config';
import { composerSkillPrefix } from '../lib/composer-skill';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from './ui/popover';
import { Button } from './ui/button';

export function SkillPicker({ bridge, projectId, mode, disabled, showButton = true }: { bridge: DesktopBridge; projectId: string | null; mode: Mode; disabled: boolean; showButton?: boolean }) {
  const aui = useAui(); const text = useAuiState(state => state.composer.text);
  const [entries, setEntries] = useState<PluginView[]>([]); const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [cursor, setCursor] = useState({ text: '', index: 0 });
  useEffect(() => { let alive = true; const refresh = () => { void bridge.skills().then(result => { if (alive && result.ok) setEntries(result.value.entries); }).catch(() => {}); }; refresh(); const unsubscribe = bridge.onPluginsUpdate(refresh); return () => { alive = false; unsubscribe(); }; }, [bridge]);
  const skills = entries.filter(entry => entry.config.enabled && entry.config.rules.load_skill !== 'deny' && entry.manifest.modes.includes(mode) && (entry.config.projectIds === null || projectId !== null && entry.config.projectIds.includes(projectId))).flatMap(entry => entry.manifest.skills.map(skill => ({ id: `${entry.id}/${skill.name}`, name: skill.name, description: skill.description })));
  const selected = composerSkillPrefix(text);
  const named = skills.filter(skill => skill.name === selected?.token);
  const active = skills.find(skill => skill.id === selected?.token) ?? (named.length === 1 ? named[0] : undefined);
  const command = text.match(/^\/(?:skill\s+)?([^\s/]*)$/); const query = command?.[1]?.toLowerCase() ?? '';
  const matches = skills.filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query));
  const suggesting = !disabled && !!command && matches.length > 0 && dismissed !== text;
  const visible = suggesting ? matches.slice(0, 6) : skills;
  const highlighted = cursor.text === text ? Math.min(cursor.index, visible.length - 1) : 0;
  function choose(id: string) {
    if (disabled) return;
    const skill = skills.find(item => item.id === id); if (!skill) return;
    const token = skills.filter(item => item.name === skill.name).length === 1 ? skill.name : id;
    const remainder = command ? '' : selected ? text.slice(selected.bodyStart) : text;
    aui.composer().setText(`/skill ${token} ${remainder}`); setOpen(false); setDismissed(text);
    requestAnimationFrame(() => {
      const input = container.current?.closest('.composer')?.querySelector<HTMLTextAreaElement>('textarea');
      input?.focus(); input?.setSelectionRange(input.value.length, input.value.length);
    });
  }
  useEffect(() => {
    if (!suggesting) return;
    const input = container.current?.closest('.composer')?.querySelector<HTMLTextAreaElement>('textarea');
    if (!input) return;
    const previous = ['aria-controls', 'aria-activedescendant', 'aria-autocomplete'].map(name => [name, input.getAttribute(name)] as const);
    input.setAttribute('aria-controls', listId); input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-activedescendant', `${listId}-${highlighted}`);
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); choose(visible[highlighted].id); }
      else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation();
        const next = (highlighted + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
        setCursor({ text, index: next });
      } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setDismissed(text); setOpen(false); }
    };
    input.addEventListener('keydown', keydown, true);
    document.getElementById(`${listId}-${highlighted}`)?.scrollIntoView({ block: 'nearest' });
    return () => { input.removeEventListener('keydown', keydown, true); for (const [name, value] of previous) { if (value === null) input.removeAttribute(name); else input.setAttribute(name, value); } };
  }, [suggesting, text, highlighted, listId, disabled, entries, mode, projectId]);
  if (!skills.length) return null;
  return <div ref={container} className={`composer-skill-picker ${showButton ? '' : 'is-slash-only'}`}><Popover open={!disabled && (open || suggesting)} onOpenChange={value => { setOpen(value); setDismissed(value ? null : text); }}>{showButton ? <PopoverTrigger asChild><Button type="button" variant="ghost" size="sm" className="work-skill-button" disabled={disabled} aria-label="Choose a skill"><BookOpen />Use skill</Button></PopoverTrigger> : <PopoverAnchor asChild><span className="composer-skill-anchor" aria-hidden="true" /></PopoverAnchor>}<PopoverContent align="start" side="top" className="composer-skill-menu" onOpenAutoFocus={event => { if (suggesting) event.preventDefault(); }} onCloseAutoFocus={event => event.preventDefault()}><div id={listId} className="composer-skill-options" role={suggesting ? 'listbox' : undefined} aria-label={suggesting ? 'Skill suggestions' : undefined}>{visible.map((skill, index) => <button type="button" id={`${listId}-${index}`} key={skill.id} role={suggesting ? 'option' : undefined} aria-selected={suggesting ? highlighted === index : undefined} aria-pressed={!suggesting ? active?.id === skill.id : undefined} data-highlighted={suggesting && highlighted === index || undefined} tabIndex={suggesting ? -1 : undefined} disabled={disabled} onMouseDown={event => { if (suggesting) event.preventDefault(); }} onMouseEnter={() => { if (suggesting) setCursor({ text, index }); }} onClick={() => choose(skill.id)}><strong>{skill.name}</strong><small>{skill.description}</small></button>)}</div>{suggesting && <div className="composer-skill-shortcut"><kbd>↑</kbd><kbd>↓</kbd> to browse <kbd>Tab</kbd> to select</div>}</PopoverContent></Popover></div>;
}

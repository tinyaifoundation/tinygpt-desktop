import { Children, isValidElement, useRef, useState, type ComponentProps, type ChangeEvent, type ReactNode } from 'react';
import { Check, ChevronDown } from '../../icons';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuRadioGroup, DropdownMenuRadioItem } from './dropdown-menu';
export function SettingsSelect({ children, value, onChange, className, ...props }: Pick<ComponentProps<'select'>, 'children' | 'value' | 'onChange' | 'className' | 'id' | 'disabled' | 'aria-label'>) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [container, setContainer] = useState<Element | undefined>();
  const options = Children.toArray(children).filter(isValidElement).map(child => { const item = child.props as { value?: string; children: ReactNode; disabled?: boolean }; return { value: item.value ?? String(item.children), label: item.children, disabled: item.disabled }; });
  // A dialog and a menu must share the same focus boundary, even when their
  // Radix versions have independent focus-scope stacks.
  // Keep an in-dialog menu inside that dialog's bounds so it flips upward
  // instead of expanding the dialog's scrollable area.
  return <DropdownMenu onOpenChange={open => { if (open) setContainer(trigger.current?.closest('[role="dialog"]') ?? undefined); }}><DropdownMenuTrigger asChild><button ref={trigger} type="button" {...props} className={`settings-dropdown ${className ?? ''}`}>{options.find(option => option.value === String(value))?.label ?? String(value ?? '')}<ChevronDown /></button></DropdownMenuTrigger><DropdownMenuContent portalContainer={container} collisionBoundary={container} collisionPadding={8} className="settings-options" align="end"><DropdownMenuRadioGroup value={String(value)} onValueChange={next => onChange?.({ target: { value: next }, currentTarget: { value: next } } as ChangeEvent<HTMLSelectElement>)}>{options.map(option => <DropdownMenuRadioItem key={option.value} value={option.value} disabled={option.disabled}><span>{option.label}</span>{String(value) === option.value && <Check />}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>;
}

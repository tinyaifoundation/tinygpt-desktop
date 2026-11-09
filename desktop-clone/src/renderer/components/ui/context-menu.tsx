import * as Menu from '@radix-ui/react-context-menu';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export const ContextMenu = Menu.Root;
export const ContextMenuTrigger = Menu.Trigger;
export function ContextMenuContent({ className, ...props }: ComponentProps<typeof Menu.Content>) {
  return <Menu.Portal><Menu.Content {...props} className={cn('menu-surface workspace-file-context-menu', className)} /></Menu.Portal>;
}
export function ContextMenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
  return <Menu.Item {...props} className={cn('flex cursor-default items-center rounded-lg px-3 py-2 text-sm outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50', className)} />;
}
export function ContextMenuSeparator() { return <Menu.Separator className="workspace-context-separator" />; }

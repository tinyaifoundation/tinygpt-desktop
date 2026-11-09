import * as Menu from '@radix-ui/react-dropdown-menu';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuRadioGroup = Menu.RadioGroup;
export const DropdownMenuSub = Menu.Sub;
export const DropdownMenuSeparator = Menu.Separator;
export const DropdownMenuLabel = Menu.Label;
export function DropdownMenuRadioItem({ className, ...props }: ComponentProps<typeof Menu.RadioItem>) { return <Menu.RadioItem className={cn('menu-choice', className)} {...props} />; }
export function DropdownMenuSubTrigger({ className, ...props }: ComponentProps<typeof Menu.SubTrigger>) { return <Menu.SubTrigger className={cn('menu-choice', className)} {...props} />; }
export function DropdownMenuSubContent({ className, ...props }: ComponentProps<typeof Menu.SubContent>) { return <Menu.Portal><Menu.SubContent className={cn('menu-surface', className)} {...props} /></Menu.Portal>; }
export function DropdownMenuContent({ className, sideOffset = 6, portalContainer, ...props }: ComponentProps<typeof Menu.Content> & { portalContainer?: ComponentProps<typeof Menu.Portal>['container'] }) {
  return <Menu.Portal container={portalContainer}><Menu.Content sideOffset={sideOffset} className={cn('menu-surface min-w-44', className)} {...props} /></Menu.Portal>;
}
export function DropdownMenuItem({ className, ...props }: ComponentProps<typeof Menu.Item>) {
  return <Menu.Item className={cn('flex cursor-default items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-4', className)} {...props} />;
}

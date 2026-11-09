import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ComponentProps, ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function TooltipProvider(props: ComponentProps<typeof TooltipPrimitive.Provider>) { return <TooltipPrimitive.Provider delayDuration={350} {...props} />; }
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;
export function TooltipContent({ className, sideOffset = 6, children, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) {
  return <TooltipPrimitive.Portal><TooltipPrimitive.Content data-slot="tooltip-content" sideOffset={sideOffset} className={cn('z-[200] rounded-md bg-foreground px-2.5 py-1.5 text-xs text-background shadow-sm', className)} {...props}>{children}<TooltipPrimitive.Arrow data-slot="tooltip-arrow" className="fill-foreground" /></TooltipPrimitive.Content></TooltipPrimitive.Portal>;
}
export function ControlTooltip({ label, children }: { label: string; children: ReactNode }) { return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>; }

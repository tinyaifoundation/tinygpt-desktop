import * as ScrollAreaPrimitive from '@radix-ui/react-scroll-area';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export function ScrollArea({ className, children, viewportClassName, viewportTabIndex = 0, ...props }: ComponentProps<typeof ScrollAreaPrimitive.Root> & { viewportClassName?: string; viewportTabIndex?: number }) {
  return <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn('relative', className)} {...props}>
    <ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" tabIndex={viewportTabIndex} className={cn('size-full rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring/50', viewportClassName)}>{children}</ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>;
}

export function ScrollBar({ className, orientation = 'vertical', ...props }: ComponentProps<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>) {
  return <ScrollAreaPrimitive.ScrollAreaScrollbar data-slot="scroll-area-scrollbar" orientation={orientation} className={cn('flex touch-none select-none p-px transition-colors', orientation === 'vertical' ? 'h-full w-2.5 border-l border-l-transparent' : 'h-2.5 flex-col border-t border-t-transparent', className)} {...props}>
    <ScrollAreaPrimitive.ScrollAreaThumb data-slot="scroll-area-thumb" className="relative flex-1 rounded-full bg-border" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>;
}

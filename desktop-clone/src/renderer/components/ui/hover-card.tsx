import * as Primitive from '@radix-ui/react-hover-card';
import type { ComponentProps } from 'react';
import { cn } from '../../lib/utils';

export const HoverCard = Primitive.Root;
export const HoverCardTrigger = Primitive.Trigger;
export function HoverCardContent({ className, sideOffset = 8, ...props }: ComponentProps<typeof Primitive.Content>) {
  return <Primitive.Portal><Primitive.Content data-slot="hover-card-content" sideOffset={sideOffset} className={cn('z-50 w-64 rounded-2xl border bg-background p-3.5 text-foreground shadow-lg outline-none', className)} {...props} /></Primitive.Portal>;
}

import type { ReactNode } from 'react';
import { ArrowLeft } from '../icons';
import { Button } from './ui/button';
import { ControlTooltip } from './ui/tooltip';

export function CatalogTopbar({ children, close }: { children: ReactNode; close?: () => void }) {
  return <div className="catalog-topbar">
    {close && <ControlTooltip label="Back to chat"><Button variant="ghost" size="icon" aria-label="Back to chat" onClick={close}><ArrowLeft /></Button></ControlTooltip>}
    {children}
  </div>;
}

import { lazy, Suspense } from 'react';
import { TooltipProvider } from './components/ui/tooltip';
import { MobileCompanion } from './components/MobileCompanion';
const MobileChat=lazy(()=>import('./MobileChat'));
export function MobileApp(){return <TooltipProvider><div className="desktop-shell mobile-shell" data-maximized="true" data-platform="mobile"><MobileCompanion chat={(desktop,manage,notifications,initialConversationId,activityChanged)=><Suspense fallback={<div className="mobile-connect-page" role="status">Opening TinyGPT…</div>}><MobileChat key={desktop} desktop={desktop} manage={manage} notifications={notifications} initialConversationId={initialConversationId} activityChanged={activityChanged}/></Suspense>}/></div></TooltipProvider>;}

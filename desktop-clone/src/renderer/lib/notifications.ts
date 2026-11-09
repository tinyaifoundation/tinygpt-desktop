import { useCallback, useEffect, useState } from 'react';
import type { DesktopBridge } from '../../shared/contracts';
import type { NotificationAction, NotificationSnapshot } from '../../shared/notifications';

export function useNotifications(bridge: DesktopBridge | undefined) {
  const [snapshot, setSnapshot] = useState<NotificationSnapshot | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!bridge) return; let alive = true;
    const unsubscribe = bridge.onNotificationsUpdate(value => { if (alive) setSnapshot(value); });
    void bridge.notifications().then(result => { if (alive) { if (result.ok) setSnapshot(result.value); else setError(result.error); } });
    return () => { alive = false; unsubscribe(); };
  }, [bridge]);
  const action = useCallback(async (value: NotificationAction) => {
    if (!bridge) return; setError('');
    try { const result = await bridge.notificationAction(value); if (result.ok) setSnapshot(result.value); else setError(result.error); }
    catch { setError('Activity could not be updated. Try again.'); }
  }, [bridge]);
  return { snapshot, setSnapshot, action, error };
}

export function useNotificationView(bridge: DesktopBridge | undefined, conversationId: string | null, enabled: boolean, sequence: number) {
  useEffect(() => {
    if (!bridge || !enabled) return;
    let previous = ''; let active = true;
    const report = () => {
      const pane = document.querySelector('.thread-message-column, .conversation-greeting');
      const visible = !!conversationId && document.visibilityState === 'visible' && document.hasFocus() && !!pane?.getClientRects().length;
      const value = { conversationId, visible }; const key = JSON.stringify(value); if (key === previous) return; previous = key;
      void bridge.notificationView(value).catch(() => { if (active) previous = ''; });
    };
    report(); window.addEventListener('focus', report); window.addEventListener('blur', report); document.addEventListener('visibilitychange', report);
    const observer = new MutationObserver(report); const pane = document.querySelector('.conversation-pane');
    if (pane) observer.observe(pane, { subtree: true, attributes: true, attributeFilter: ['style', 'hidden'] });
    return () => { active = false; observer.disconnect(); window.removeEventListener('focus', report); window.removeEventListener('blur', report); document.removeEventListener('visibilitychange', report); };
  }, [bridge, conversationId, enabled, sequence]);
}

import type { BrowserWindow, Rectangle } from 'electron';

/** Reopening must show a hidden window as well as restoring a minimized one. */
export function revealWindow(target: Pick<BrowserWindow, 'isDestroyed' | 'isMinimized' | 'isVisible' | 'restore' | 'getBounds' | 'setBounds' | 'show' | 'focus'>, workAreas: Rectangle[]) {
  if (target.isDestroyed()) return;
  if (target.isMinimized()) target.restore();
  const bounds = target.getBounds();
  const visible = workAreas.some(area => Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x) >= Math.min(64, bounds.width, area.width)
    && Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y) >= Math.min(64, bounds.height, area.height));
  if (!visible && workAreas.length) {
    const area = workAreas[0], width = Math.min(bounds.width, area.width), height = Math.min(bounds.height, area.height);
    target.setBounds({ x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height });
  }
  target.show();
  // Windows can apply STARTUPINFO's hidden launch state to the first show.
  if (!target.isVisible()) target.show();
  target.focus();
}

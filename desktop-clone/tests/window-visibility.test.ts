import { expect, it, vi } from 'vitest';
import { revealWindow } from '../src/main/window-visibility';

const area = { x: 0, y: 0, width: 1920, height: 1080 };
function fixture(bounds = { x: 100, y: 100, width: 1200, height: 820 }, minimized = false) {
  return { isDestroyed: () => false, isMinimized: () => minimized, isVisible: vi.fn(() => true), restore: vi.fn(), getBounds: () => bounds, setBounds: vi.fn(), show: vi.fn(), focus: vi.fn() };
}
it('shows an existing hidden window and restores a minimized window before focusing', () => {
  const hidden = fixture(); revealWindow(hidden, [area]);
  expect(hidden.show).toHaveBeenCalledOnce(); expect(hidden.focus).toHaveBeenCalledOnce(); expect(hidden.setBounds).not.toHaveBeenCalled();
  const minimized = fixture(undefined, true); revealWindow(minimized, [area]);
  expect(minimized.restore.mock.invocationCallOrder[0]).toBeLessThan(minimized.show.mock.invocationCallOrder[0]);
});
it('repeats show when Windows preserves a hidden process launch state', () => {
  const hidden = fixture(); hidden.isVisible.mockReturnValueOnce(false);
  revealWindow(hidden, [area]);
  expect(hidden.show).toHaveBeenCalledTimes(2);
  expect(hidden.focus.mock.invocationCallOrder[0]).toBeGreaterThan(hidden.show.mock.invocationCallOrder[1]);
});
it('recovers an offscreen window while preserving placement on an attached display', () => {
  const offscreen = fixture({ x: -10000, y: -10000, width: 1200, height: 820 }); revealWindow(offscreen, [area]);
  expect(offscreen.setBounds).toHaveBeenCalledWith({ x: 360, y: 130, width: 1200, height: 820 });
  const second = fixture({ x: -1800, y: 100, width: 1200, height: 820 }); revealWindow(second, [area, { ...area, x: -1920 }]);
  expect(second.setBounds).not.toHaveBeenCalled();
});

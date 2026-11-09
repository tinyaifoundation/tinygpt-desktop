import koffi from 'koffi';
import { ComputerFailure } from './computer-driver';

export type ActivateWindow = (pid: number, windowId: number, signal: AbortSignal) => Promise<{ restored: boolean; foreground: boolean }>;
let api: { valid: (window: number) => boolean; pid: (window: number, pid: number[]) => number; iconic: (window: number) => boolean; show: (window: number, command: number) => boolean; foreground: (window: number) => boolean; current: () => number } | undefined;
/** Narrow host adapter: restore/focus only the approved, process-checked HWND.
 * No shell, executable launch, coordinates, keystrokes or arbitrary messages. */
export const activateComputerWindow: ActivateWindow = async (pid, windowId, signal) => {
  if (process.platform !== 'win32') throw new ComputerFailure('COMPUTER_ACTIVATION_UNSUPPORTED', 'Window activation is not available on this platform.');
  if (!api) {
    const user = koffi.load('user32.dll');
    api = { valid: user.func('bool IsWindow(uintptr_t hwnd)'), pid: user.func('uint32_t GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)'), iconic: user.func('bool IsIconic(uintptr_t hwnd)'), show: user.func('bool ShowWindowAsync(uintptr_t hwnd, int command)'), foreground: user.func('bool SetForegroundWindow(uintptr_t hwnd)'), current: user.func('uintptr_t GetForegroundWindow()') };
  }
  const check = () => { signal.throwIfAborted(); const owner = [0]; if (!api!.valid(windowId) || !api!.pid(windowId, owner) || owner[0] !== pid) throw new ComputerFailure('COMPUTER_WINDOW_STALE', 'The window closed or changed identity. List windows again.'); };
  check(); if (api.iconic(windowId)) api.show(windowId, 9);
  const deadline = Date.now() + 1500;
  while (api.iconic(windowId) && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 50)); check(); }
  check(); const restored = !api.iconic(windowId);
  if (restored) api.foreground(windowId);
  check(); return { restored, foreground: Number(api.current()) === windowId };
};

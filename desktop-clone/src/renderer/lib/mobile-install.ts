const desktopId = /^[a-f0-9]{64}$/;
export function installDesktop(url: string): string | undefined {
  const value = new URL(url).searchParams.get('setup'); return value && desktopId.test(value) ? value : undefined;
}
export function installLink(origin: string, desktop?: string): string {
  const url = new URL('/', origin); if (desktop && desktopId.test(desktop)) url.searchParams.set('setup', desktop); return url.href;
}
export function isInstalledCompanion() {
  return matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone;
}

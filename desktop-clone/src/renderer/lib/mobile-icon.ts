export const mobileIcons = [{ id: 'ios-default', name: 'Original' }, { id: 'dark', name: 'Dark' }, { id: 'tinted-light', name: 'Tinted' }, { id: 'clear-light', name: 'Clear light' }, { id: 'clear-dark', name: 'Clear dark' }] as const;
export type MobileIcon = typeof mobileIcons[number]['id'];
export function currentMobileIcon(): MobileIcon { try { const value = new URL(location.href).searchParams.get('icon') ?? localStorage.getItem('tinygpt-mobile-icon'); return mobileIcons.find(icon => icon.id === value)?.id ?? 'ios-default'; } catch { return 'ios-default'; } }
export function applyMobileIcon(icon: MobileIcon) {
  localStorage.setItem('tinygpt-mobile-icon', icon);
  document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.setAttribute('href', `/icons/app-${icon}.png`);
  document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.setAttribute('href', `/manifest.webmanifest?icon=${icon}`);
  document.querySelectorAll<HTMLImageElement>('[data-mobile-brand]').forEach(image => { image.src = `/icons/app-${icon}.png`; });
}

import type { RemoteAppearance } from '../../shared/remote';

export type MobileTheme = 'light' | 'dark';
const themeKey = 'tinygpt-remote-theme';
export function readMobileTheme(): MobileTheme | undefined {
  try { const value = localStorage.getItem(themeKey); return value === 'light' || value === 'dark' ? value : undefined; } catch { return undefined; }
}
export function applyMobileAppearance(appearance?: RemoteAppearance, selected = readMobileTheme()) {
  const theme = selected ?? appearance?.theme ?? 'light', root = document.documentElement;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;
  if (root.style.colorScheme !== theme) root.style.colorScheme = theme;
  const palette = appearance?.palettes?.[theme];
  const variables = { ...appearance?.variables, ...palette };
  // Older desktops publish only their active palette. Keep their fonts, but use
  // the shared default colors when the phone chooses the other theme.
  if (!appearance || theme !== appearance.theme && !palette) {
    variables['--background'] = theme === 'dark' ? '#171717' : '#ffffff';
    variables['--foreground'] = theme === 'dark' ? '#ededef' : '#1a1c1f';
  }
  for (const [key,value] of Object.entries(variables)) if (root.style.getPropertyValue(key) !== value) root.style.setProperty(key,value);
  const meta = document.querySelector('meta[name="theme-color"]'), color = variables['--background'] ?? (theme === 'dark' ? '#171717' : '#ffffff');
  if (meta?.getAttribute('content') !== color) meta?.setAttribute('content',color);
}
export function saveMobileTheme(theme: MobileTheme) {
  try { localStorage.setItem(themeKey, theme); } catch { /* Keep the choice for this session. */ }
}

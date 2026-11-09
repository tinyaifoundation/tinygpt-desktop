export type InstallEnvironment = { platform: 'ios' | 'android' | 'desktop'; browser: 'safari' | 'chrome' | 'brave' | 'firefox' | 'edge' | 'other'; safariHandoff: boolean };
export function installEnvironment(userAgent: string,platform = '',touchPoints = 0,brave = false,hint = ''): InstallEnvironment {
  const ios = /iPhone|iPad|iPod/i.test(userAgent) || platform === 'MacIntel' && touchPoints > 1;
  const os = ios ? 'ios' : /Android/i.test(userAgent + ' ' + hint) ? 'android' : 'desktop';
  const browser = brave || /\bBrave(?:\/|\b)/i.test(userAgent) ? 'brave' : /Edg(?:iOS|A|\/)/i.test(userAgent) ? 'edge' : /FxiOS|Firefox/i.test(userAgent) ? 'firefox' : /CriOS|Chrome/i.test(userAgent) ? 'chrome' : /Version\/.*Safari/i.test(userAgent) ? 'safari' : 'other';
  const embedded = /FBAN|FBAV|Instagram|MicroMessenger|TikTok|GSA\//i.test(userAgent);
  return { platform: os,browser,safariHandoff: ios && (embedded || !['safari','chrome'].includes(browser)) };
}
export function currentInstallEnvironment(brave = false) {
  return installEnvironment(navigator.userAgent,navigator.platform,navigator.maxTouchPoints,brave,(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform);
}

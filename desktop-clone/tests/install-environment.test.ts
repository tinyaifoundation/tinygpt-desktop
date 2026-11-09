import { describe,expect,it } from 'vitest';
import { installEnvironment } from '../src/renderer/lib/install-environment';
const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 Version/26.0 Mobile/15E148 Safari/604.1';
describe('installation environment',() => {
  it('shows Safari steps for iPhone and desktop-mode iPad without a platform picker',() => {
    expect(installEnvironment(safari)).toMatchObject({ platform:'ios',browser:'safari',safariHandoff:false });
    expect(installEnvironment('Mozilla/5.0 (Macintosh) Version/26.0 Safari/605.1.15','MacIntel',5)).toMatchObject({platform:'ios',safariHandoff:false});
  });
  it('recognizes the documented iOS Brave marker and its browser API',() => {
    expect(installEnvironment(safari + ' Brave/1')).toMatchObject({platform:'ios',browser:'brave',safariHandoff:true});
    expect(installEnvironment(safari,'iPhone',5,true).safariHandoff).toBe(true);
  });
  it('keeps supported iOS Chrome on the direct install path',() => {
    expect(installEnvironment(safari.replace('Version/26.0','CriOS/140.0'))).toMatchObject({browser:'chrome',safariHandoff:false});
  });
  it('guides an embedded iPhone browser to Safari',() => {
    expect(installEnvironment(safari + ' Instagram 412').safariHandoff).toBe(true);
    expect(installEnvironment(safari + ' [FBAN/FBIOS]').safariHandoff).toBe(true);
  });
  it('selects Android steps for Android browsers and desktop-mode client hints',() => {
    expect(installEnvironment('Mozilla/5.0 Android 16 Chrome/140.0')).toMatchObject({platform:'android',safariHandoff:false});
    expect(installEnvironment('Mozilla/5.0 Chrome/140.0','Linux',5,true,'Android')).toMatchObject({platform:'android',browser:'brave',safariHandoff:false});
  });
  it('does not mistake a touch-enabled desktop for an iPhone',() => {
    expect(installEnvironment('Mozilla/5.0 Windows NT Chrome/140.0','Win32',10).platform).toBe('desktop');
  });
});

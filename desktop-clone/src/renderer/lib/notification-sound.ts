import type { DesktopBridge } from '../../shared/contracts';

/** One sound player per app window. Main sends to just one owner, including when minimized. */
export function installNotificationSound(bridge: DesktopBridge | undefined): void {
  if (!bridge) return;
  let playing: HTMLAudioElement | null = null; let stop: ReturnType<typeof setTimeout> | undefined;
  bridge.onNotificationSound(sound => {
    playing?.pause(); clearTimeout(stop);
    if (!/^data:audio\/(wav|mpeg);base64,/.test(sound.url) || !Number.isFinite(sound.volume)) { void bridge.notificationSoundResult({ id: sound.id, played: false }); return; }
    const audio = new Audio(sound.url); playing = audio; audio.volume = Math.max(0, Math.min(1, sound.volume));
    void audio.play().then(() => { void bridge.notificationSoundResult({ id: sound.id, played: true }); stop = setTimeout(() => { audio.pause(); if (playing === audio) playing = null; }, 5000); }, () => { void bridge.notificationSoundResult({ id: sound.id, played: false }); if (playing === audio) playing = null; });
  });
}

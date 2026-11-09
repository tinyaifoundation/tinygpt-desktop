// Adapted from assistant-ui Elements' ComposerVoice (MIT, AgentbaseAI Inc.).
// See public/licenses/assistant-ui-LICENSE.txt. Real microphone samples replace
// the upstream decorative sine-wave bars; the input remains above this lane.
import { useEffect, useRef, type ComponentProps } from 'react';
import { cn } from '../lib/utils';

export type VoiceSample = { level: number; at: number };

export function ComposerVoice({ recording, seconds, samples, status, className, ...props }: Omit<ComponentProps<'div'>, 'children'> & {
  recording: boolean; seconds: number; samples: VoiceSample[]; status: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef(samples); latest.current = samples;
  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context) return;
    let width = 0, height = 0, frame = 0;
    const reducedMotion = () => document.documentElement.dataset.motion === 'reduce';
    const resize = () => {
      const bounds = element.getBoundingClientRect();
      width = bounds.width; height = bounds.height;
      const ratio = window.devicePixelRatio || 1;
      element.width = Math.round(width * ratio); element.height = Math.round(height * ratio);
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    const paint = () => {
      context.clearRect(0, 0, width, height);
      context.fillStyle = getComputedStyle(element).color;
      const now = recording ? performance.now() : latest.current[0]?.at ?? performance.now();
      // Each 80 ms microphone frame enters on the left and travels to the right.
      // The history is bounded, and silence produces short, quiet bars.
      for (const sample of latest.current) {
        const age = Math.max(0, now - sample.at);
        const x = (reducedMotion() ? Math.floor(age / 80) * 80 : age) / 80 * 4;
        if (x > width) break;
        const barHeight = 2 + sample.level * (height - 4);
        context.globalAlpha = Math.min(1, (width - x) / 20) * (0.3 + sample.level * 0.45);
        context.beginPath(); context.roundRect(x, (height - barHeight) / 2, 2, barHeight, 1); context.fill();
      }
      context.globalAlpha = 1;
      frame = requestAnimationFrame(paint);
    };
    const observer = new ResizeObserver(resize); observer.observe(element);
    resize(); paint();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [recording]);
  const elapsed = Math.floor(seconds);
  return <div data-slot="composer-voice" data-recording={recording || undefined} className={cn('composer-voice', className)} {...props}>
    <span className="composer-voice-dot" data-recording={recording || undefined} aria-hidden="true" />
    <canvas ref={canvas} className="composer-voice-wave" aria-hidden="true" />
    <span className="composer-voice-time" aria-hidden="true">{recording ? `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` : status}</span>
    <span className="sr-only" role="status" aria-live="polite">{status}</span>
  </div>;
}

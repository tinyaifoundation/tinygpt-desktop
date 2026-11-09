import { useEffect, useState } from 'react';
import { BlobAvatar } from 'blob-avatar';
import { defaultBotDesign, type BotDesign } from '../lib/bot';
import { botAvatarPresentation, type BotAvatarAction } from '../lib/bot-avatar';

/** Shared avatar for the sidebar, designer, and personal conversation. */
export function RobotAvatar({ size = 20, interactive = false, action = 'idle', activity, playbackKey = 0, className, design = defaultBotDesign }: {
  size?: number; interactive?: boolean; action?: BotAvatarAction; activity?: 'working' | 'reviewing' | 'writing'; playbackKey?: number; className?: string; design?: BotDesign;
}) {
  const [paused,setPaused] = useState(false);
  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setPaused(document.hidden || document.documentElement.dataset.motion === 'reduce' || motion.matches);
    sync();
    motion.addEventListener('change',sync);
    document.addEventListener('visibilitychange',sync);
    window.addEventListener('tinygpt-motion',sync);
    return () => {
      motion.removeEventListener('change',sync);
      document.removeEventListener('visibilitychange',sync);
      window.removeEventListener('tinygpt-motion',sync);
    };
  },[]);
  const presentation = botAvatarPresentation(action,design.expression);
  const sleeping = action === 'snooze' || action === 'sleep';
  return <BlobAvatar key={playbackKey} size={size} shape={design.shape} color={design.color}
    expression={presentation.expression} animation={presentation.animation} gaze={interactive && !paused && !sleeping} reaction={interactive && !paused && !sleeping} paused={paused}
    className={['robot-avatar',interactive ? 'is-interactive' : 'is-icon',className].filter(Boolean).join(' ')}
    aria-hidden="true" data-robot-avatar="" data-avatar-engine="blob-avatar" data-action={action} data-activity={activity}
    data-shape={design.shape} data-color={design.color} data-expression={presentation.expression} data-animation={presentation.animation} data-paused={paused} />;
}

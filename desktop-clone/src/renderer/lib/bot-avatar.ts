import type { Anim, Expression } from 'blob-avatar';

export type BotAvatarAction = Anim | 'bored' | 'input' | 'send' | 'waiting' | 'waiting-wrap' | 'inspect' | 'success' | 'failure' | 'warning' | 'blocked' | 'error' | 'surprise' | 'random' | 'wake';

/** Map assistant activity to the public blob-avatar API. */
export function botAvatarPresentation(action: BotAvatarAction, resting: Expression): { expression: Expression; animation: string } {
  const states: Partial<Record<BotAvatarAction, { expression: Expression; animation: string }>> = {
    idle: { expression: resting, animation: 'idle.6,wink.1.6,idle.8' },
    bored: { expression: 'curious', animation: 'idle.8' },
    input: { expression: 'attentive', animation: 'thinking.2.6' },
    send: { expression: 'happy', animation: 'nod.1.4' },
    waiting: { expression: 'focused', animation: 'loading.2,thinking.2.6' },
    'waiting-wrap': { expression: 'attentive', animation: 'orbit.3.4' },
    inspect: { expression: 'focused', animation: 'thinking.2.6' },
    success: { expression: 'proud', animation: 'check.1.8' },
    failure: { expression: 'sad', animation: 'shake.1.4' },
    warning: { expression: 'worried', animation: 'alert.2.4' },
    blocked: { expression: 'worried', animation: 'question.2' },
    error: { expression: 'confused', animation: 'dizzy.2.2' },
    surprise: { expression: 'surprised', animation: 'exclaim.2' },
    random: { expression: 'happy', animation: 'wink.1.6,jump.1.6,spin.1.6,love.2' },
    sleep: { expression: 'sleepy', animation: 'sleep.2.4' },
    snooze: { expression: 'sleepy', animation: 'snooze.4' },
    wake: { expression: 'excited', animation: 'wide.1.8' },
  };
  return states[action] ?? { expression: resting, animation: action };
}

export const botAnimations: { action: Anim; label: string }[] = [
  {action:'idle',label:'Idle'},{action:'thinking',label:'Thinking'},{action:'wink',label:'Wink'},
  {action:'wide',label:'Wide eyes'},{action:'alert',label:'Alert'},{action:'notification',label:'Notification'},
  {action:'exclaim',label:'Surprise'},{action:'sleep',label:'Sleep'},{action:'egg',label:'Egg'},
  {action:'hexagon',label:'Hexagon'},{action:'play',label:'Play'},{action:'orbit',label:'Orbit'},
  {action:'burst',label:'Burst'},{action:'comet',label:'Comet'},{action:'nod',label:'Nod'},
  {action:'shake',label:'Shake'},{action:'jump',label:'Jump'},{action:'spin',label:'Spin'},
  {action:'love',label:'Love'},{action:'party',label:'Party'},{action:'dizzy',label:'Dizzy'},
  {action:'shiver',label:'Shiver'},{action:'melt',label:'Melt'},{action:'snooze',label:'Snooze'},
  {action:'rain',label:'Rain'},{action:'loading',label:'Loading'},{action:'check',label:'Success'},
  {action:'question',label:'Question'},
];

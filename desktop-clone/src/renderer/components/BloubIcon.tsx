import { useEffect, useId, useState } from 'react';
import { BotEngine, type BotFrame } from '../vendor/bloub/engine';
import { RAYON } from '../vendor/bloub/repere';
import { SHAPE_BY_ID } from '../vendor/bloub/skins';
import { EXPRESSION_BY_ID } from '../vendor/bloub/expressions';

function idleEngine() {
  return new BotEngine(RAYON, 'idle', SHAPE_BY_ID.get('nuage')!.radii, EXPRESSION_BY_ID.get('neutre')!);
}

/** React host for Bloub's original cloud silhouette, gaze drift, and blinking. */
export function BloubIcon({ className }: { className?: string }) {
  const maskId = useId();
  const [frame, setFrame] = useState<BotFrame>(() => idleEngine().sample(0));
  const [expression, setExpression] = useState('neutre');

  useEffect(() => {
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const engine = idleEngine();
    let raf = 0;
    let last = 0;
    let clock = 0;
    let currentExpression = 'neutre';
    function tick(now: number) {
      raf = requestAnimationFrame(tick);
      if (last && now - last < 1000 / 30) return;
      clock += last ? Math.min((now - last) / 1000, 0.064) : 0;
      last = now;
      const nextExpression = Math.floor(clock / 4) % 2 === 0 ? 'neutre' : 'attentif';
      if (nextExpression !== currentExpression) {
        engine.setExpression(EXPRESSION_BY_ID.get(nextExpression)!, clock);
        currentExpression = nextExpression;
        setExpression(nextExpression);
      }
      setFrame(engine.sample(clock));
    }
    function sync() {
      cancelAnimationFrame(raf);
      last = 0;
      if (document.documentElement.dataset.motion === 'reduce' || (document.documentElement.dataset.motion !== 'full' && motion.matches)) {
        setFrame(idleEngine().sample(0));
        setExpression('neutre');
      }
      else if (!document.hidden) {
        setExpression(currentExpression);
        raf = requestAnimationFrame(tick);
      }
    }
    sync();
    motion.addEventListener('change', sync);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('tinygpt-motion', sync);
    return () => {
      cancelAnimationFrame(raf);
      motion.removeEventListener('change', sync);
      document.removeEventListener('visibilitychange', sync);
      window.removeEventListener('tinygpt-motion', sync);
    };
  }, []);

  return <svg data-bloub data-expression={expression} className={className} width="16" height="16" viewBox="-112 -112 224 224" aria-hidden="true" focusable="false">
    <defs><mask id={maskId} maskUnits="userSpaceOnUse" x="-112" y="-112" width="224" height="224">
      <path d={frame.bodyPath} fill="white" />
      {frame.eyes.map((eye, index) => <path key={index} d={eye.d} transform={eye.matrix} opacity={eye.alpha} fill="black" />)}
    </mask></defs>
    <path d={frame.bodyPath} fill="#3b93f0" opacity={frame.bodyAlpha} mask={`url(#${maskId})`} />
  </svg>;
}

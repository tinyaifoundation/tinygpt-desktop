import companion from '../assets/onboarding/companion-gradient.png';
import free from '../assets/onboarding/free-gradient.png';
import memories from '../assets/onboarding/memories-gradient.png';
import work from '../assets/onboarding/work-gradient.png';

const artwork = [companion, free, memories, work];

export function OnboardingShowcase({ step }: { step: number }) {
  return <section className={`welcome-showcase welcome-showcase-${step}`} aria-label="TinyGPT feature preview">
    <img className="welcome-showcase-artwork" key={step} src={artwork[step]} alt="" draggable={false} />
    <div className="welcome-showcase-brand">TinyGPT</div>
  </section>;
}

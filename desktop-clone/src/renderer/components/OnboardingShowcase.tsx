import { ArrowUp, Check, Code2, FileText, Mic, Monitor, ShieldCheck } from '../icons';
import { RobotAvatar } from './RobotAvatar';
import { defaultBotDesign, type BotDesign } from '../lib/bot';

// Decorative sample UI, separate from the live setup controls beside it.
function CompanionPreview() {
  return <><div className="welcome-preview-prompt">Help me think through an idea.</div><div className="welcome-preview-card">
    <span className="welcome-preview-eyebrow">TinyGPT</span><h2>Let’s find a place to start.</h2><p>A little context can open up a lot of possibilities.</p>
    <div className="welcome-preview-options"><span>Explore an idea<ArrowUp /></span><span>Make a plan<ArrowUp /></span><span>Create something<ArrowUp /></span></div>
  </div></>;
}
function LocalPreview() {
  return <><div className="welcome-preview-prompt">A little help, whenever I need it.</div><div className="welcome-preview-card welcome-preview-local">
    <span className="welcome-preview-symbol"><Monitor /></span><h2>Right here.<br />On your device.</h2><div className="welcome-preview-model"><span>TinyGPT<small>Included local model</small></span><span className="welcome-preview-pill">Free forever</span></div><div className="welcome-preview-caption"><Check />No account or subscription</div>
  </div></>;
}
function MemoriesPreview() {
  return <><div className="welcome-preview-prompt">Remember that I like concise answers.</div><div className="welcome-preview-card welcome-preview-memories">
    <span className="welcome-preview-eyebrow">Personalization</span><div className="welcome-preview-person"><span>A</span><div><h2>Alex</h2><p>Your space. Your context.</p></div></div>
    <div className="welcome-preview-memory"><span>Saved memory</span><p>Prefers clear, concise answers.</p><Check /></div><div className="welcome-preview-caption"><ShieldCheck />Stored on this device</div>
  </div></>;
}
function WorkPreview() {
  return <><div className="welcome-preview-prompt">Help me make this list searchable.</div><div className="welcome-preview-card welcome-preview-work">
    <span className="welcome-preview-eyebrow"><Code2 />Work</span><h2>From idea to something real.</h2><div className="welcome-preview-code"><code><span>const</span> matches = items.filter(<br />{'  '}item =&gt; item.name<br />{'    '}.toLowerCase()<br />{'    '}.includes(query)<br />);</code></div><div className="welcome-preview-tools"><span><FileText />Documents</span><span><Code2 />Code</span><span><Mic />Voice</span></div>
  </div></>;
}
function BotPreview({ bot }: { bot: BotDesign }) {
  return <div className="welcome-preview-card welcome-preview-bot"><span className="welcome-preview-eyebrow">Your personal sidekick</span><RobotAvatar size={210} design={bot} action="idle" /><h2>{bot.name}</h2><p>Ready when you are.</p></div>;
}
const previews = [CompanionPreview, LocalPreview, MemoriesPreview, undefined, WorkPreview];

export function OnboardingShowcase({ step, bot = defaultBotDesign }: { step: number; bot?: BotDesign }) {
  const Preview = previews[step] ?? CompanionPreview;
  return <section className={`welcome-showcase welcome-showcase-${step}`} aria-label="TinyGPT feature preview">
    <div className="welcome-showcase-artwork" key={step} aria-hidden="true">{step === 3 ? <BotPreview bot={bot} /> : <Preview />}</div>
    <div className="welcome-showcase-brand">TinyGPT</div>
  </section>;
}

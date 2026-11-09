import { KeyRound, Monitor } from '../icons';
import type { Settings } from '../../shared/config';
import openrouterIcon from '../assets/inference/openrouter.svg';
import openaiIcon from '../assets/inference/openai.svg';
import anthropicIcon from '../assets/inference/anthropic.svg';
import xaiIcon from '../assets/inference/xai.svg';

export function InferenceProviderIcon({ provider }: { provider: Settings['byok']['provider'] | 'local' | 'byok' | 'chatgpt' }) {
  if (provider === 'local') return <Monitor aria-hidden="true" />;
  if (provider === 'byok' || provider === 'custom') return <KeyRound aria-hidden="true" />;
  const icon = { openrouter: openrouterIcon, openai: openaiIcon, chatgpt: openaiIcon, anthropic: anthropicIcon, xai: xaiIcon }[provider];
  return <span className="inference-brand-icon" aria-hidden="true" style={{ maskImage: `url("${icon}")` }} />;
}

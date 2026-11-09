import { speechVoiceDisplay } from '../../shared/voice';

export function SpeechVoiceLabel({ voice }: { voice: string }) {
  const { name, country } = speechVoiceDisplay(voice);
  return <span className="inline-flex items-center gap-2">{country && <svg role="img" aria-label={country === 'US' ? 'United States' : 'United Kingdom'} viewBox="0 0 30 20" width="21" height="14" style={{ width: 21, height: 14 }} className="shrink-0 overflow-hidden rounded-[2px]">
    {country === 'US' ? <><rect width="30" height="20" fill="#fff" />{Array.from({ length: 7 }, (_, i) => <rect key={i} y={i * 40 / 13} width="30" height={20 / 13} fill="#B31942" />)}<rect width="12" height={140 / 13} fill="#0A3161" />{Array.from({ length: 9 }, (_, row) => Array.from({ length: row % 2 ? 5 : 6 }, (_, col) => <circle key={`${row}/${col}`} cx={1 + col * 2 + (row % 2)} cy={1 + row * 1.08} r=".35" fill="#fff" />))}</> : <><rect width="30" height="20" fill="#012169" /><path d="M0 0 30 20M30 0 0 20" stroke="#fff" strokeWidth="4" /><path d="M0 0 30 20M30 0 0 20" stroke="#C8102E" strokeWidth="1.5" /><path d="M15 0V20M0 10H30" stroke="#fff" strokeWidth="7" /><path d="M15 0V20M0 10H30" stroke="#C8102E" strokeWidth="4" /></>}
  </svg>}<span>{name}</span></span>;
}

import { useState } from 'react';
import { mobileIcons, currentMobileIcon, applyMobileIcon } from '../lib/mobile-icon';
export function MobileIconPicker({ installed = false }: { installed?: boolean }) {
  const [selected, setSelected] = useState(currentMobileIcon);
  return <div className="mobile-icon-setting"><div className="mobile-icon-grid" role="group" aria-label="Home Screen icon">{mobileIcons.map(icon => <button type="button" key={icon.id} aria-label={`${icon.name} icon`} aria-pressed={selected === icon.id} onClick={() => { setSelected(icon.id); applyMobileIcon(icon.id); const url = new URL(location.href); url.searchParams.set('icon', icon.id); history.replaceState(null, '', url); }}><img src={`/icons/app-${icon.id}.png`} alt="" /><span>{icon.name}</span></button>)}</div><p>{installed ? 'iPhone icons are set when you add the app. Open the installation page to add this color; you may need to reconnect.' : 'Choose your icon, then add TinyGPT to your Home Screen.'}</p>{installed && <a href={`/?icon=${selected}`} target="_blank" rel="noopener noreferrer">Open installation page</a>}</div>;
}

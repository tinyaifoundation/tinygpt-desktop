import { useEffect, useState, type CSSProperties } from 'react';
import type { DesktopBridge } from '../../shared/contracts';
import type { ConfigurationMonitorSnapshot, GraphicsReading } from '../../shared/configuration-monitor';
import { ChevronDown } from '../icons';
import { SettingsSelect } from './ui/settings-select';

type Sample = { time: number; value: number | null };
const windowMs = 120_000;
export function memoryLabel(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  if (bytes === 0) return '0 MB';
  return bytes < 2 ** 30 ? `${Math.max(1, Math.round(bytes / 2 ** 20))} MB` : `${(bytes / 2 ** 30).toFixed(1)} GB`;
}
function Trend({ samples, maximum, label, color }: { samples: Sample[]; maximum: number; label: string; color: string }) {
  const now = samples.at(-1)?.time ?? Date.now();
  const points = samples.filter(sample => sample.time >= now - windowMs);
  const segments: string[] = []; let previous = 0;
  for (const sample of points) {
    if (sample.value === null) { previous = 0; continue; }
    const x = Math.max(0, Math.min(240, (sample.time - now + windowMs) / windowMs * 240));
    const y = 48 - Math.max(0, Math.min(1, sample.value / Math.max(1, maximum))) * 44;
    const command = `${x.toFixed(1)},${y.toFixed(1)}`;
    if (!previous || sample.time - previous > 12_000) segments.push(`M${command}`); else segments[segments.length - 1] += ` L${command}`;
    previous = sample.time;
  }
  const last = points.at(-1);
  return <svg className="device-trend" viewBox="0 0 240 52" preserveAspectRatio="none" role="img" aria-label={label} style={{ color }}><path className="device-trend-grid" d="M0,4H240 M0,26H240 M0,48H240" />{segments.map((path, index) => <path key={index} className="device-trend-line" d={path} />)}{last?.value !== null && last?.value !== undefined && <circle cx="240" cy={48 - Math.max(0, Math.min(1, last.value / Math.max(1, maximum))) * 44} r="2.5" fill="currentColor" />}</svg>;
}
function Metric({ title, value, detail, samples, maximum, color }: { title: string; value: string; detail: string; samples: Sample[]; maximum: number; color: string }) {
  return <div className="device-metric" style={{ '--metric-color': color } as CSSProperties}><div className="device-metric-label"><i />{title}</div><strong>{value}</strong><span className="device-metric-detail">{detail}</span><Trend samples={samples} maximum={maximum} label={`${title} over the last two minutes`} color={color} /><div className="device-trend-axis"><span>2 min ago</span><span>Now</span></div></div>;
}

export function ConfigurationMonitor({ bridge, preferredDevice }: { bridge: DesktopBridge; preferredDevice?: string }) {
  const [history, setHistory] = useState<ConfigurationMonitorSnapshot[]>([]);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(document.visibilityState === 'hidden');
  useEffect(() => {
    let active = true, inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      if (!active || inFlight || document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const result = await bridge.configurationMonitor();
        if (!active) return;
        if (!result.ok) throw new Error(result.error);
        const snapshot = result.value;
        setHistory(previous => [...previous.filter(sample => sample.sampledAt > snapshot.sampledAt - windowMs && sample.sampledAt !== snapshot.sampledAt), snapshot].slice(-45));
        setError('');
      } catch { if (active) setError('Live readings are temporarily unavailable.'); }
      finally { inFlight = false; if (active && !document.hidden) timer = setTimeout(() => void refresh(), 3000); }
    };
    const visibility = () => { setPaused(document.visibilityState === 'hidden'); clearTimeout(timer); if (document.visibilityState !== 'hidden') void refresh(); };
    void refresh(); document.addEventListener('visibilitychange', visibility);
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [bridge]);
  const current = history.at(-1);
  const device = current?.graphics.find(device => device.id === selected) ?? current?.graphics.find(device => device.id === preferredDevice) ?? current?.graphics[0];
  const unified = current?.unified;
  const system = current?.systemMemory;
  const memory = unified ? system : device;
  const used = memory?.usedBytes, total = memory?.totalBytes;
  const samples = (read: (snapshot: ConfigurationMonitorSnapshot, device: GraphicsReading | undefined) => number | null): Sample[] => history.map(snapshot => ({ time: snapshot.sampledAt, value: read(snapshot, snapshot.graphics.find(item => item.id === device?.id)) }));
  const memorySamples = samples((sample, gpu) => sample.unified ? sample.systemMemory.usedBytes : gpu?.usedBytes ?? null);
  const tight = unified ? system?.pressure === 'elevated' || system?.pressure === 'high' : total && used !== null && used !== undefined && used / total > .9;
  const live = current && !error && !paused;
  return <section className="configuration-device-monitor" aria-label="Live device monitor">
    <div className="device-monitor-card">
      <div className="device-monitor-toolbar"><span>{device?.name ?? (current?.platform === 'darwin' ? 'Apple graphics' : 'This computer')}</span>{(current?.graphics.length ?? 0) > 1 && <SettingsSelect aria-label="Graphics card to monitor" value={device?.id} onChange={event => setSelected(event.target.value)}>{current!.graphics.map(device => <option value={device.id} key={device.id}>{device.name}</option>)}</SettingsSelect>}<span className={`device-monitor-live ${live ? 'is-live' : ''}`}><i />{paused ? 'Paused' : error ? 'Reconnecting' : current ? 'Live' : 'Connecting'}</span></div>
      <div className={`device-metrics ${unified ? 'is-unified' : ''}`}>
        <Metric title={unified ? 'Shared memory' : 'Graphics memory'} value={used !== null && used !== undefined ? memoryLabel(used) : '—'} detail={total && used !== null && used !== undefined ? `${memoryLabel(Math.max(0, total - used))} available of ${memoryLabel(total)}` : current ? 'Not reported by this device' : 'Checking memory…'} samples={memorySamples} maximum={total || Math.max(1, ...memorySamples.map(sample => sample.value ?? 0))} color="#6a8df5" />
        <Metric title="GPU activity" value={device?.activity !== null && device?.activity !== undefined ? `${Math.round(device.activity)}%` : '—'} detail={device?.activity !== null && device?.activity !== undefined ? 'Across this graphics card' : current ? 'Not reported by this device' : 'Checking activity…'} samples={samples((_sample, gpu) => gpu?.activity ?? null)} maximum={100} color="#9b7be4" />
        <Metric title="GPU temperature" value={device?.temperature !== null && device?.temperature !== undefined ? `${Math.round(device.temperature)}°C` : '—'} detail={device?.temperature !== null && device?.temperature !== undefined ? 'Current graphics temperature' : current ? 'Not reported by this device' : 'Checking temperature…'} samples={samples((_sample, gpu) => gpu?.temperature ?? null)} maximum={125} color="#d89a57" />
        {!unified && <Metric title="System memory" value={memoryLabel(system?.usedBytes)} detail={system ? `${memoryLabel(system.totalBytes - system.usedBytes)} available of ${memoryLabel(system.totalBytes)}` : 'Checking memory…'} samples={samples(sample => sample.systemMemory.usedBytes)} maximum={system?.totalBytes || 1} color="#50ad95" />}
      </div>
      <div className="device-memory-summary"><div className="device-memory-bar" role="meter" aria-label={unified ? 'Shared memory used' : 'Graphics memory used'} aria-valuemin={0} aria-valuemax={100} aria-valuenow={total && used !== null && used !== undefined ? Math.round(used / total * 100) : undefined}><span style={{ width: total && used !== null && used !== undefined ? `${Math.min(100, used / total * 100)}%` : '0%' }} /></div><div><span>{unified ? 'Shared by apps, macOS, and graphics' : 'Used by all apps and the system'}</span><span>{total && used !== null && used !== undefined ? `${Math.round(used / total * 100)}% used` : 'Reading unavailable'}</span></div></div>
      <details className="device-components"><summary className="device-components-heading"><h3>TinyGPT components</h3><span>Memory breakdown<ChevronDown aria-hidden="true" /></span></summary><p className="device-components-caption" title="Process allocations can share memory and may overlap. They should not be added to the device total.">{unified ? 'App memory · shared pool' : 'Process allocations · all graphics cards'}</p><table><thead><tr><th scope="col">Component</th>{!unified && <th scope="col">Graphics</th>}<th scope="col">{unified ? 'App memory' : 'System'}</th></tr></thead><tbody>{current?.components.map(component => <tr key={component.id}><th scope="row"><span>{component.name}</span><small>{component.state}</small></th>{!unified && <td>{memoryLabel(component.graphicsBytes)}</td>}<td>{memoryLabel(component.memoryBytes)}</td></tr>) ?? <tr><td colSpan={3} className="device-components-loading">Checking TinyGPT’s memory use…</td></tr>}</tbody></table></details>
    </div>
    {tight && <p className="device-monitor-message">{unified ? 'macOS is under memory pressure. Closing unused apps can help.' : 'Graphics memory is nearly full. Closing another model app can make room.'}</p>}
    {error && <p className="device-monitor-message" role="status">{error} The last readings are shown until the connection returns.</p>}
  </section>;
}

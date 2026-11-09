import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from '../icons';
import type { AppSnapshot, DesktopBridge } from '../../shared/contracts';
import type { ImageCatalog, ImageSelection } from '../../shared/image-generation';
import { sameImageModel } from '../../shared/image-generation';
import { SettingRow } from './AppearanceSettings';
import { ImageModelPicker } from './ImageModelPicker';
import { SettingsButton as Button } from './ui/settings-button';
import { ControlTooltip } from './ui/tooltip';

export function ImageVideoSettings({ snapshot, bridge, update }: { snapshot: AppSnapshot; bridge: DesktopBridge; update: (value: AppSnapshot) => void }) {
  const [catalog, setCatalog] = useState<ImageCatalog>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const load = useCallback(async (refresh = false) => {
    setLoading(true); setError('');
    try {
      const result = await bridge.imageModels(refresh);
      if (!mounted.current) return;
      if (!result.ok) throw new Error(result.error);
      setCatalog(result.value);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Image models could not be loaded.');
    } finally { if (mounted.current) setLoading(false); }
  }, [bridge]);
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; }; }, [load]);
  async function change(selection?: ImageSelection) {
    setSaving(true); setError(''); setNotice('');
    try {
      const imageGeneration = selection ? { connectionId: selection.connectionId, model: selection.model } : undefined;
      const result = await bridge.saveSettings({ ...snapshot.settings, imageGeneration });
      if (!result.ok) throw new Error(result.error);
      update(result.value);
      if (mounted.current) setNotice(selection ? 'Image model saved.' : 'TinyGPT will ask you to choose a model when you next generate an image.');
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Image settings could not be saved.');
    } finally { if (mounted.current) setSaving(false); }
  }
  const selection = snapshot.settings.imageGeneration;
  const selected = catalog?.models.find(model => sameImageModel(selection, model));
  const busy = loading || saving;
  return <div>
    <section className="settings-content-group"><div className="flex items-center justify-between gap-3"><h2>Image generation</h2><ControlTooltip label="Refresh image models"><Button variant="muted" size="icon" aria-label="Refresh image models" disabled={busy} onClick={() => void load(true)}><RefreshCw className={loading ? 'animate-spin' : ''} /></Button></ControlTooltip></div>
      <div className="settings-card">
        <SettingRow title="Image model" description="Choose a model from your connected providers for image generation and editing. This is separate from your conversation model.">
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-2"><ImageModelPicker models={catalog?.models ?? []} value={selection} change={model => void change(model)} disabled={busy || !catalog?.models.length} />{selection && <Button variant="muted" disabled={busy} onClick={() => void change()}>Clear selection</Button>}</div>
        </SettingRow>
        <SettingRow title="When no model is selected" description="The image tool asks you to choose an available model before generating an image."><span className="settings-value">Prompt to choose</span></SettingRow>
        {selected && <SettingRow title="Supported features" description="Available controls depend on the selected model."><span className="settings-value">{['Generation', selected.editing && 'Editing', selected.transparency && 'Transparency'].filter(Boolean).join(' · ')}</span></SettingRow>}
      </div>
      {loading && <p role="status" className="mt-4 text-sm text-muted-foreground">Loading image models…</p>}
      {!loading && catalog && !catalog.models.length && <p className="mt-4 text-sm text-muted-foreground">No image generation models are available. Add a supported provider in Configuration, then refresh the model list.</p>}
      {!loading && selection && catalog && !selected && <p className="mt-4 text-sm text-muted-foreground">Your saved image model is currently unavailable. Choose another model or clear the selection to be asked next time.</p>}
      {catalog?.issues.map((issue, index) => <p key={index} className="mt-4 text-sm text-muted-foreground">{issue}</p>)}
    </section>
    <section className="settings-content-group"><h2>Video generation</h2><div className="settings-card settings-feature-status"><p>Video model configuration will be available when video generation is connected.</p><span>Coming soon</span></div></section>
    {notice && <p role="status" className="settings-notice">{notice}</p>}
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
  </div>;
}

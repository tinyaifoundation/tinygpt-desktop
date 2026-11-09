import { computerAppName } from '../../shared/computer';
import { ScrollArea } from './ui/scroll-area';

const string = (value: unknown) => typeof value === 'string' ? value : '';
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** Show the result of desktop work without exposing model/driver references. */
export function ComputerToolResult({ result }: { result: string }) {
  let data: Record<string, unknown>;
  try { data = object(JSON.parse(result)); } catch { data = { error: result }; }
  const windows = Array.isArray(data.windows) ? data.windows.map(object) : undefined;
  const snapshot = object(data.snapshot ?? (data.windowId ? data : undefined));
  const controls = Array.isArray(snapshot.elements) ? snapshot.elements.map(object).filter(control => typeof control.value === 'string' && control.protected !== true) : [];
  const rawError = string(data.error);
  const error = rawError.includes('tool_invocation_failed') ? 'The editor could not accept the text directly. Check its contents and paste the draft manually.' : rawError;
  return <ScrollArea className="mt-2 rounded-xl bg-muted text-muted-foreground" viewportClassName="max-h-72">
    <div data-slot="computer-tool-result" className="space-y-2 p-3 text-[13px] leading-6">
      {error && <p>{error}</p>}
      {snapshot.truncated === true && <p>Partial window view.{typeof object(snapshot.coverage).returnedControls === 'number' ? ` Showing ${object(snapshot.coverage).returnedControls} of ${object(snapshot.coverage).matchingControls} matching controls.` : ''} {object(snapshot.coverage).sourceComplete === false ? 'The app did not expose its entire accessibility tree.' : 'The assistant can narrow the search or read more.'}</p>}
      {typeof data.manualDraft === 'string' && <div><p className="font-medium text-foreground">Draft to paste</p><p className="whitespace-pre-wrap break-words">{data.manualDraft}</p></div>}
      {windows && (windows.length ? <ul className="space-y-2">{windows.map((window, index) => <li key={index}><p className="font-medium text-foreground">{computerAppName(string(window.app), string(window.title))}</p>{window.title !== window.app && <p>{string(window.title)}</p>}</li>)}</ul> : <p>No matching windows are open.</p>)}
      {data.verified === true && <p>{data.actionDispatched ? 'The text was updated and checked.' : 'The field already contains the requested text.'}</p>}
      {data.actionDispatched === true && data.verified !== true && <p>The input was sent to the app. Check the window below for the result.</p>}
      {!!snapshot.app && <p className="font-medium text-foreground">{computerAppName(string(snapshot.app), string(snapshot.title))}{snapshot.title && snapshot.title !== snapshot.app ? ` · ${string(snapshot.title)}` : ''}</p>}
      {!!snapshot.text && <div className="whitespace-pre-wrap break-words">{string(snapshot.text)}</div>}
      {controls.map((control, index) => <div key={index}><p className="font-medium text-foreground">{string(control.label) || 'Text field'}{control.valueTruncated === true ? ' (excerpt)' : ''}</p><p className="whitespace-pre-wrap break-words">{string(control.value)}</p></div>)}
      {!error && !windows && !snapshot.app && !data.actionDispatched && data.verified !== true && <p>This desktop step finished.</p>}
    </div>
  </ScrollArea>;
}

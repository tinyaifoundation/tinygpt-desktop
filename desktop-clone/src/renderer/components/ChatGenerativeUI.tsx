import { Component, createContext, useContext, useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { AuiConfig, Tools, defineToolkit, type ToolCallMessagePartComponent } from '@assistant-ui/react';
import { defineRegistry, JSONUIProvider, Renderer } from '@json-render/react';
import { chatUICatalog, restoreSavedChatUI } from '../../shared/generative-ui';
import { ConversationActions } from './ConversationMessages';
import { Button } from './ui/button';
import { MarkdownBody } from './AnswerMarkdown';
import { MermaidDiagram } from './elements/mermaid-diagram';
import { OutputSection, OutputTable, OutputChart, OutputChecklist } from './ChatOutputComponents';

const PreviewContext = createContext(false);
function FollowUp({ label, message }: { label: string; message: string }) {
  const actions = useContext(ConversationActions);
  const preview = useContext(PreviewContext);
  return <Button className="chat-ui-follow-up" variant="outline" size="sm" disabled={preview || actions.retryDisabled} onClick={() => actions.setDraft(message)}>{label}</Button>;
}
function Checklist(props: Parameters<typeof OutputChecklist>[0]) { return <OutputChecklist {...props} disabled={useContext(PreviewContext)} />; }
export const { registry: chatUIRegistry } = defineRegistry(chatUICatalog, {
  components: {
    Card: ({ props, children }) => <OutputSection title={props.title} className="jr-card">{props.description && <p className="jr-caption">{props.description}</p>}{children}</OutputSection>,
    Stack: ({ props, children }) => <div className="jr-stack" data-direction={props.direction ?? 'vertical'} data-gap={props.gap ?? 'medium'}>{children}</div>,
    Heading: ({ props }) => <h3 className="jr-title">{props.text}</h3>,
    Text: ({ props }) => <div className="jr-text"><MarkdownBody value={props.value} /></div>,
    MetricGrid: ({ props }) => <OutputSection title={props.title}><dl className="jr-metrics">{props.metrics.map((metric, index) => <div className="jr-metric" key={index}><dt>{metric.label}</dt><dd>{metric.value}</dd>{metric.delta && <span className="jr-metric-delta" data-trend={metric.trend} data-good={metric.trend === 'flat' || !metric.trend ? undefined : (metric.trend === 'up') === (metric.upIsGood ?? true)}>{metric.trend === 'up' ? '↑ ' : metric.trend === 'down' ? '↓ ' : ''}{metric.delta}</span>}</div>)}</dl></OutputSection>,
    Comparison: ({ props }) => <OutputSection title={props.title} summary={props.summary} className="jr-comparison"><OutputTable {...props} /></OutputSection>,
    Table: ({ props }) => <OutputSection title={props.title} summary={props.summary}><OutputTable {...props} /></OutputSection>,
    ChartPanel: ({ props }) => <OutputChart {...props} />,
    Checklist: ({ props }) => <Checklist {...props} disabled={false} />,
    Timeline: ({ props }) => <OutputSection title={props.title}><ol className="jr-timeline">{props.items.map((item, index) => <li key={index}>{item.date && <span className="jr-caption">{item.date}</span>}<strong>{item.title}</strong>{item.description && <MarkdownBody value={item.description} />}</li>)}</ol></OutputSection>,
    Callout: ({ props }) => <aside className="jr-callout" data-tone={props.tone ?? 'info'}>{props.title && <h3 className="jr-title">{props.title}</h3>}<MarkdownBody value={props.body} /></aside>,
    Diagram: ({ props }) => <OutputSection title={props.title}><MermaidDiagram code={props.code} /></OutputSection>,
    FollowUpGroup: ({ props }) => <div className="jr-follow-ups" aria-label="Suggested next questions">{props.suggestions.map((suggestion, index) => <FollowUp key={index} {...suggestion} />)}</div>,
  },
});
class InterfaceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p role="status">This interface could not be displayed.</p> : this.props.children; }
}
const PresentUI: ToolCallMessagePartComponent = props => {
  const { args, result, status } = props;
  if ('remotePresentation' in args) return <RemotePresentUI {...props} />;
  const preview = status.type === 'running' && result === undefined;
  if (preview && !('root' in args)) return <p role="status" className="text-sm text-muted-foreground shimmer">Preparing the visual…</p>;
  if (status.type === 'incomplete') return <p role="status" className="text-sm text-muted-foreground">This interface did not finish.</p>;
  if (result && typeof result === 'object' && 'error' in result) return <p role="status" className="text-sm text-muted-foreground">This interface could not be displayed.</p>;
  let restored;
  try { restored = restoreSavedChatUI(args); } catch { return <p role="status" className="text-sm text-muted-foreground">This interface could not be displayed.</p>; }
  return <PreviewContext.Provider value={preview}><InterfaceBoundary key={preview ? 'preview' : 'saved'}><div aria-busy={preview || undefined} className="chat-generative-ui" data-renderer="json-render"><JSONUIProvider registry={chatUIRegistry}><Renderer spec={restored.ui} registry={chatUIRegistry} loading={preview} /></JSONUIProvider>{restored.partial && <p className="jr-caption">Some sections of this saved interface could not be restored.</p>}</div></InterfaceBoundary></PreviewContext.Provider>;
};

const RemotePresentUI: ToolCallMessagePartComponent = props => {
  const actions = useContext(ConversationActions);
  const ref = props.args.remotePresentation as { conversationId?: string; toolId?: string; version?: string; available?: boolean };
  const [loaded, setLoaded] = useState<{ ui: ComponentProps<ToolCallMessagePartComponent>['args']; partial: boolean }>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let alive = true; const controller = new AbortController(); setError(false);
    if (!ref.available || !ref.conversationId || !ref.toolId || !actions.loadPresentation) return;
    void actions.loadPresentation(ref.conversationId, ref.toolId, controller.signal).then(value => {
      if (alive) setLoaded({ ui: restoreSavedChatUI(value.ui).ui as unknown as ComponentProps<ToolCallMessagePartComponent>['args'], partial: value.partial });
    }).catch(() => { if (alive) setError(true); });
    return () => { alive = false; controller.abort(); };
  }, [ref.conversationId, ref.toolId, ref.version, ref.available, actions.loadPresentation]);
  if (error) return <p role="status" className="text-sm text-muted-foreground">This interface could not be loaded. Reopen the chat to try again.</p>;
  if (!loaded) return <p role="status" className="text-sm text-muted-foreground shimmer">Preparing the visual…</p>;
  return <><PresentUI {...props} args={loaded.ui} />{loaded.partial && <p className="jr-caption">Some sections of this saved interface could not be restored.</p>}</>;
};
// Assistant UI still hosts the conversation; Vercel json-render owns visuals.
export const chatUIConfig = AuiConfig({ tools: Tools({ toolkit: defineToolkit({ present: { type: 'backend', display: 'standalone', render: PresentUI } }) }) });

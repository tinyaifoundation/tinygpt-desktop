import { BookOpen, PlugZap, Blocks } from '../icons';
import type { ConnectorKind, SuggestedConnector, PluginView } from '../../shared/plugins';
import { connectorIdentity } from '../../shared/connector-catalog';
import gmail from '../assets/connectors/gmail.png';
import gdrive from '../assets/connectors/gdrive.png';
import gcalendar from '../assets/connectors/gcalendar.png';
import notion from '../assets/connectors/notion.png';
import github from '../assets/connectors/github.svg';
import slack from '../assets/connectors/slack.png';
import higgsfield from '../assets/connectors/higgsfield.png';
import linear from '../assets/connectors/linear.png';

const logos: Record<ConnectorKind | SuggestedConnector, string> = { gmail, google: gmail, gdrive, gcalendar, notion, github, slack, higgsfield, linear };

export function ConnectorIcon({ kind }: { kind?: ConnectorKind | SuggestedConnector }) {
  return kind ? <img className="connector-brand-icon" data-connector={kind} src={logos[kind]} alt="" aria-hidden="true" draggable={false} /> : <Blocks />;
}

export function PluginIcon({ entry }: { entry: PluginView }) {
  const kind = connectorIdentity(entry.manifest) ?? entry.manifest.connector;
  return kind ? <ConnectorIcon kind={kind} /> : entry.manifest.kind === 'skill' ? <BookOpen /> : entry.manifest.server ? <PlugZap /> : <Blocks />;
}

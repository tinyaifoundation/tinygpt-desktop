import { restoreSavedChatUI, type ChatUINode } from '../shared/generative-ui';
import type { ToolActivity } from '../shared/tools';

const cell = (value: unknown) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
const table = (columns: string[], rows: unknown[][]) => [
  `| ${columns.map(cell).join(' | ')} |`, `| ${columns.map(() => '---').join(' | ')} |`,
  ...rows.map(row => `| ${row.map(cell).join(' | ')} |`),
].join('\n');

/** A portable answer representation; no executable UI or raw JSON in exports. */
export function chatUIToMarkdown(value: unknown): string {
  const { ui } = restoreSavedChatUI(value);
  function tree(id: string): ChatUINode {
    const element = ui.elements[id];
    return { $type: element.type, ...element.props, children: element.children?.map(tree) };
  }
  function render(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(render).filter(Boolean).join('\n\n');
    if (typeof value !== 'object') return String(value);
    const node = value as ChatUINode;
    const children = render(node.children);
    const title = node.title ? `### ${String(node.title).replace(/\r?\n/g, ' ')}\n\n` : '';
    switch (node.$type) {
      case 'Text': case 'Caption': case 'Markdown': return [node.value, children].filter(Boolean).join('\n\n');
      case 'Heading': case 'Header': return `### ${node.text}${children ? `\n\n${children}` : ''}`;
      case 'Fact': return `**${node.label}:** ${node.value}${node.delta ? ` (${node.delta})` : ''}`;
      case 'Badge': return String(node.value);
      case 'Divider': return '---';
      case 'Spacer': return '';
      case 'ListViewItem': return `- ${children.replace(/\n/g, '\n  ')}`;
      case 'ListView': return (Array.isArray(node.children) ? node.children : [node.children]).map(render).join('\n');
      case 'MetricGrid': return title + (node.metrics as unknown[]).map(metric => render({ $type: 'Fact', ...metric as object })).join('\n\n');
      case 'Table': case 'Comparison': {
        const columns = node.columns as { label: string; format?: { kind: string; currency?: string; decimals?: number } }[];
        const rows = (node.rows as unknown[][]).map(row => row.map((value, index) => {
          const format = columns[index]?.format;
          if (typeof value !== 'number' || !format || format.kind === 'date') return value;
          try { return new Intl.NumberFormat(undefined, { style: format.kind === 'currency' ? 'currency' : format.kind === 'percent' ? 'percent' : 'decimal', currency: format.currency, ...(format.decimals === undefined ? {} : { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals }) }).format(value); } catch { return value; }
        }));
        return title + table(columns.map(column => column.label), rows) + (node.summary ? `\n\n${node.summary}` : '');
      }
      case 'Chart': case 'ChartPanel': {
        const series = node.series as { label?: string; data: { label?: string; value: number }[] }[] | undefined;
        const groups = series ?? [{ label: node.unit ? `Value (${node.unit})` : 'Value', data: node.data as { label?: string; value: number }[] }];
        return title + table(['Point', ...groups.map((group, index) => (group.label ?? `Series ${index + 1}`) + (series && node.unit ? ` (${node.unit})` : ''))], groups[0]!.data.map((point, index) => [point.label ?? index + 1, ...groups.map(group => group.data[index]?.value)])) + (node.summary ? `\n\n${node.summary}` : '');
      }
      case 'Checklist': return title + (node.items as { text: string; checked?: boolean; detail?: string }[]).map(item => '- [' + (item.checked ? 'x' : ' ') + '] ' + item.text + (item.detail ? ' — ' + item.detail : '')).join('\n');
      case 'Timeline': return title + (node.items as { title: string; date?: string; description?: string }[]).map((item, index) => (index + 1) + '. ' + (item.date ? item.date + ': ' : '') + item.title + (item.description ? ' — ' + item.description : '')).join('\n');
      case 'Callout': return title + String(node.body);
      case 'Diagram': return title + '\x60\x60\x60mermaid\n' + String(node.code) + '\n\x60\x60\x60';
      case 'FollowUp': return `Suggested next question: ${node.message}`;
      case 'FollowUpGroup': return (node.suggestions as unknown[]).map(suggestion => render({ $type: 'FollowUp', ...suggestion as object })).join('\n\n');
      default: return title + [node.description, children].filter(Boolean).join('\n\n');
    }
  }
  return render(tree(ui.root)).trim();
}

export function presentationText(tool: ToolActivity): string {
  if (tool.name !== 'present' || tool.status !== 'success') return '';
  try { return chatUIToMarkdown(JSON.parse(tool.result ?? '').ui); } catch { return ''; }
}
export function answerMarkdown(text: string, tools: readonly ToolActivity[]): string {
  return [text, ...tools.map(presentationText)].filter(value => value.trim()).join('\n\n');
}

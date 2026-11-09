import { useState, type ReactNode } from 'react';
import { z } from 'zod';
import { chatUIComponents, chartShape, columnSchema } from '../../shared/chat-ui-catalog';
import { MarkdownBody } from './AnswerMarkdown';

export function OutputSection({ title, summary, children, className = '' }: { title?: string; summary?: string; children: ReactNode; className?: string }) {
  return <section className={`jr-section ${className}`}>{title && <h3 className="jr-title">{title}</h3>}{children}{summary && <div className="jr-summary"><MarkdownBody value={summary} /></div>}</section>;
}
export function formatOutputCell(value: unknown, column: z.infer<typeof columnSchema>): string {
  const format = column.format;
  if (typeof value !== 'number' || !format || format.kind === 'date') return String(value ?? '');
  return new Intl.NumberFormat(undefined, { style: format.kind === 'currency' ? 'currency' : format.kind === 'percent' ? 'percent' : 'decimal', currency: format.currency, ...(format.decimals === undefined ? {} : { minimumFractionDigits: format.decimals, maximumFractionDigits: format.decimals }) }).format(value);
}
export function OutputTable({ columns, rows, sortable }: z.infer<typeof chatUIComponents.Table.props>) {
  const [sort, setSort] = useState<{ column: number; descending: boolean }>();
  const ordered = sort ? [...rows].sort((a, b) => {
    const x = a[sort.column], y = b[sort.column];
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true })) * (sort.descending ? -1 : 1);
  }) : rows;
  return <div className="jr-table-scroll" tabIndex={0} role="region" aria-label="Data table"><table className="jr-table"><thead><tr>{columns.map((column, index) => <th key={index} data-align={column.align} aria-sort={sort?.column === index ? sort.descending ? 'descending' : 'ascending' : undefined}>{sortable ? <button type="button" onClick={() => setSort({ column: index, descending: sort?.column === index && !sort.descending })}>{column.label}{sort?.column === index ? sort.descending ? ' ↓' : ' ↑' : ''}</button> : column.label}</th>)}</tr></thead><tbody>{ordered.map((row, index) => <tr key={index}>{row.map((value, index) => <td key={index} data-align={columns[index]?.align}>{formatOutputCell(value, columns[index])}</td>)}</tr>)}</tbody></table></div>;
}
type ChartProps = z.infer<z.ZodObject<typeof chartShape>> & { title: string; unit?: string; summary?: string };
const colors = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', '#0891b2', '#a855f7', '#db2777'];
export function OutputChart(props: ChartProps) {
  const groups = props.series ?? [{ label: props.unit ?? 'Value', data: props.data! }];
  const count = groups[0].data.length;
  const stacked = props.stacked && ['bar', 'area'].includes(props.variant);
  const bands = groups.map(group => group.data.map(point => ({ start: 0, end: point.value })));
  if (stacked) for (let point = 0; point < count; point++) {
    let positive = 0, negative = 0;
    for (let series = 0; series < groups.length; series++) {
      const value = groups[series].data[point].value;
      bands[series][point] = { start: value >= 0 ? positive : negative, end: (value >= 0 ? positive : negative) + value };
      if (value >= 0) positive += value; else negative += value;
    }
  }
  const values = bands.flatMap(group => group.flatMap(point => [point.start, point.end]));
  const low = Math.min(0, ...values), high = Math.max(0, ...values) || (low === 0 ? 1 : 0);
  const range = high - low || 1;
  const x = (index: number) => 58 + (props.variant === 'bar' ? (index + 0.5) / count : index / Math.max(1, count - 1)) * 560;
  const y = (value: number) => 18 + (high - value) / range * 180;
  const compact = (value: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumSignificantDigits: 3 }).format(value);
  return <OutputSection title={props.title} summary={props.summary} className="jr-chart-panel">
    {props.unit && <p className="jr-caption">{props.unit}</p>}
    <div className="jr-chart-scroll"><svg className="jr-chart" viewBox="0 0 640 232" role="img" aria-label={`${props.title}${props.unit ? ` (${props.unit})` : ''}`}>
      <title>{props.title}</title>
      {[0, 0.5, 1].map(fraction => { const value = low + range * fraction; return <g key={fraction}><line x1="58" x2="618" y1={y(value)} y2={y(value)} className="jr-chart-grid" /><text x="50" y={y(value) + 4} textAnchor="end">{compact(value)}</text></g>; })}
      <line x1="58" x2="618" y1={y(0)} y2={y(0)} className="jr-chart-zero" />
      {groups.map((group, series) => <g key={series} style={{ color: colors[series % colors.length] }}>
        {props.variant === 'bar' ? group.data.map((point, index) => {
          const width = 560 / count * 0.76 / (stacked ? 1 : groups.length);
          const left = x(index) - 560 / count * 0.38 + (stacked ? 0 : series * width);
          return <rect key={index} x={left} y={Math.min(y(bands[series][index].start), y(bands[series][index].end))} width={Math.max(0.5, width - 1)} height={Math.abs(y(bands[series][index].end) - y(bands[series][index].start))} rx="2" fill="currentColor"><title>{`${group.label ?? 'Value'} · ${point.label}: ${point.value}`}</title></rect>;
        }) : <>
          {props.variant === 'area' && <polygon fill="currentColor" opacity="0.14" points={[...bands[series].map((point, index) => `${x(index)},${y(point.end)}`), ...bands[series].map((point, index) => `${x(index)},${y(point.start)}`).reverse()].join(' ')} />}
          <polyline fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" points={bands[series].map((point, index) => `${x(index)},${y(point.end)}`).join(' ')} />
          {group.data.map((point, index) => <circle key={index} cx={x(index)} cy={y(bands[series][index].end)} r="3" fill="currentColor"><title>{`${group.label ?? 'Value'} · ${point.label ?? index + 1}: ${point.value}`}</title></circle>)}
        </>}
      </g>)}
      {groups[0].data.map((point, index) => index % Math.max(1, Math.ceil(count / 6)) === 0 || index === count - 1 ? <text key={index} x={x(index)} y="220" textAnchor="middle">{(point.label ?? String(index + 1)).slice(0, 16)}</text> : null)}
    </svg></div>
    {groups.length > 1 && <div className="jr-chart-legend">{groups.map((group, index) => <span key={index}><i style={{ background: colors[index % colors.length] }} />{group.label}</span>)}</div>}
    <details className="jr-chart-data"><summary>View chart data</summary><OutputTable columns={[{ label: 'Point' }, ...groups.map((group, index) => ({ label: group.label ?? `Series ${index + 1}`, align: 'end' as const }))]} rows={groups[0].data.map((point, index) => [point.label ?? String(index + 1), ...groups.map(group => group.data[index].value)])} /></details>
  </OutputSection>;
}
export function OutputChecklist({ title, items, disabled }: z.infer<typeof chatUIComponents.Checklist.props> & { disabled: boolean }) {
  const [checked, setChecked] = useState<Record<number, boolean>>({});
  return <OutputSection title={title}><ul className="jr-checklist">{items.map((item, index) => <li key={index}><label><input type="checkbox" disabled={disabled} checked={checked[index] ?? item.checked ?? false} onChange={event => setChecked(previous => ({ ...previous, [index]: event.target.checked }))} /><span><span className="jr-checklist-text">{item.text}</span>{item.detail && <span className="jr-caption">{item.detail}</span>}</span></label></li>)}</ul></OutputSection>;
}

import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { z } from 'zod';

const short = z.string().min(1).max(300);
const prose = z.string().max(80000);
const summary = z.string().max(4000).optional();
export const metricSchema = z.object({ label: short, value: z.string().max(300), delta: z.string().max(100).optional(), trend: z.enum(['up', 'down', 'flat']).optional(), upIsGood: z.boolean().optional() }).strict();
export const columnSchema = z.object({ label: short, align: z.enum(['start', 'end']).optional(), format: z.object({ kind: z.enum(['number', 'currency', 'percent', 'date']), currency: z.string().regex(/^[A-Z]{3}$/).optional(), decimals: z.number().int().min(0).max(20).optional() }).strict().optional() }).strict();
const tableShape = { columns: z.array(columnSchema).min(1).max(12), rows: z.array(z.array(z.union([z.string().max(4000), z.number().finite(), z.boolean(), z.null()]))).min(1).max(100), sortable: z.boolean().optional() };
const point = z.object({ label: z.string().max(120).optional(), value: z.number().finite().min(-1e100).max(1e100) }).strict();
export const chartShape = { variant: z.enum(['bar', 'line', 'area', 'sparkline']), data: z.array(point).max(60).optional(), series: z.array(z.object({ label: short.optional(), color: z.string().max(40).optional(), data: z.array(point).max(60) }).strict()).max(8).optional(), stacked: z.boolean().optional(), showAxis: z.boolean().optional(), showLegend: z.boolean().optional(), color: z.string().max(40).optional() };
const suggestion = z.object({ label: z.string().min(1).max(100), message: z.string().min(1).max(4000) }).strict();

// Semantic components keep layout decisions in the application. This catalog
// supplies the provider schema, host validation and typed React registry.
export const chatUIComponents = {
  Card: { props: z.object({ title: short.optional(), description: summary }).strict(), slots: ['default'], description: 'Group related content under an optional title. Avoid redundant nested cards.' },
  Stack: { props: z.object({ direction: z.enum(['vertical', 'horizontal']).optional(), gap: z.enum(['small', 'medium', 'large']).optional() }).strict(), slots: ['default'], description: 'Arrange child elements. Horizontal stacks wrap automatically on narrow screens.' },
  Heading: { props: z.object({ text: short }).strict(), slots: [], description: 'A short section heading.' },
  Text: { props: z.object({ value: prose }).strict(), slots: [], description: 'Markdown prose with source links, code and Mermaid fences.' },
  MetricGrid: { props: z.object({ title: short.optional(), metrics: z.array(metricSchema).min(1).max(8) }).strict(), slots: [], description: 'Show related key figures, with labels, values and optional change indicators.' },
  Comparison: { props: z.object({ title: short, ...tableShape, summary }).strict(), slots: [], description: 'Compare options using shared criteria. Include a concise recommendation in summary.' },
  Table: { props: z.object({ title: short.optional(), ...tableShape, summary }).strict(), slots: [], description: 'A sortable data table. Every row must match the columns. Percent formatting uses fractions.' },
  ChartPanel: { props: z.object({ title: short, ...chartShape, unit: z.string().max(80).optional(), summary }).strict(), slots: [], description: 'Visualize numerical data. Use labeled bar charts for categories, line/area for trends. Include units and interpretation.' },
  Checklist: { props: z.object({ title: short, items: z.array(z.object({ text: z.string().min(1).max(2000), checked: z.boolean().optional(), detail: z.string().max(4000).optional() }).strict()).min(1).max(50) }).strict(), slots: [], description: 'An actionable plan or checklist. Users can check items locally; this performs no external actions.' },
  Timeline: { props: z.object({ title: short, items: z.array(z.object({ title: short, date: z.string().max(120).optional(), description: z.string().max(4000).optional() }).strict()).min(1).max(30) }).strict(), slots: [], description: 'Show ordered milestones, an itinerary or a schedule. Dates can be plain language.' },
  Callout: { props: z.object({ title: short.optional(), body: prose, tone: z.enum(['info', 'success', 'warning']).optional() }).strict(), slots: [], description: 'Highlight a useful insight, decision or caveat.' },
  Diagram: { props: z.object({ title: short.optional(), code: z.string().min(1).max(15000) }).strict(), slots: [], description: 'Explain a process or relationships using Mermaid diagram syntax.' },
  FollowUpGroup: { props: z.object({ suggestions: z.array(suggestion).min(1).max(3) }).strict(), slots: [], description: 'Specific useful next questions. Clicking fills the composer without sending.' },
};
export const chatUICatalog = defineCatalog(schema, { components: chatUIComponents, actions: {} });

// Read compatibility for saved Assistant UI trees; never advertised to models.
const layout = { gap: z.number().min(0).max(8).optional(), align: z.enum(['start', 'center', 'end']).optional() };
const typography = { size: z.enum(['sm', 'md', 'lg', 'xl', '2xl', '3xl']).optional(), weight: z.enum(['normal', 'medium', 'semibold', 'bold']).optional(), color: z.enum(['emphasis', 'secondary', 'alpha-70', 'white', 'white-70', 'white-50']).optional() };
export const legacyComponents = {
  ...Object.fromEntries(Object.entries(chatUIComponents).map(([name, component]) => [name, { properties: component.props }])),
  Text: { properties: z.object({ value: prose, ...typography }) }, Markdown: { properties: z.object({ value: prose }) }, Caption: { properties: z.object({ value: prose }) },
  Header: { properties: z.object({ text: short, size: typography.size }) }, Card: { properties: z.object({ title: short.optional(), padding: z.number().min(0).max(8).optional() }) },
  Fact: { properties: metricSchema }, Table: { properties: z.object(tableShape) }, Chart: { properties: z.object(chartShape) },
  Col: { properties: z.object(layout) }, Row: { properties: z.object({ ...layout, justify: z.enum(['start', 'center', 'end', 'between']).optional() }) },
  Badge: { properties: z.object({ value: short, variant: z.string().max(40).optional() }) }, Spacer: { properties: z.object({}) }, Divider: { properties: z.object({ flush: z.boolean().optional() }) },
  ListView: { properties: z.object({}) }, ListViewItem: { properties: z.object({}) }, FollowUp: { properties: suggestion },
};

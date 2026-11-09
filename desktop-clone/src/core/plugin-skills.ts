import { parseDocument } from 'yaml';
import { skillSchema, type PluginSkill } from '../shared/plugins';

export function parseSkill(source: string, references: Record<string, string> = {}): PluginSkill {
  if (source.length > 128000) throw new Error('Skill files must be 128,000 characters or fewer.');
  const match = /^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]+)$/.exec(source);
  if (!match) throw new Error('SKILL.md needs name and description in YAML frontmatter.');
  const doc = parseDocument(match[1]);
  if (doc.errors.length) throw new Error('Skill metadata could not be read.');
  const metadata = doc.toJS({ maxAliasCount: 0 }) as Record<string, unknown>;
  const paths = Object.keys(references);
  if (paths.length > 8 || Object.values(references).reduce((total, text) => total + Buffer.byteLength(text), 0) > 100000) throw new Error('Skill references exceed the supported package size.');
  for (const path of paths) if (!/^[a-zA-Z0-9_./ -]+$/.test(path) || path.startsWith('/') || path.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Skill references must stay inside the skill package.');
  return skillSchema.parse({ name: metadata.name, description: metadata.description, instructions: match[2].trim(), references, ...(typeof metadata.license === 'string' ? { license: metadata.license } : {}), ...(typeof metadata.compatibility === 'string' ? { compatibility: metadata.compatibility } : {}) });
}

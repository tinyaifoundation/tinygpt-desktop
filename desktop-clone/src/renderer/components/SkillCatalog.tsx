import { useState } from 'react';
import { BookOpen, Check, ExternalLink, LoaderCircle, Plus, Star } from '../icons';
import type { CatalogSkill, PluginView } from '../../shared/plugins';
import { SettingsButton as Button } from './ui/settings-button';
import { SettingsSelect } from './ui/settings-select';

const avatars = import.meta.glob('../assets/skill-makers/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
export function SkillMakerAvatar({ maker }: { maker: { id: string; name: string } }) {
  const [failed, setFailed] = useState(false), src = avatars[`../assets/skill-makers/${maker.id}.png`];
  return src && !failed ? <img className="skill-maker-avatar" src={src} alt={`${maker.name} logo`} onError={() => setFailed(true)} /> : <span className="skill-maker-avatar skill-maker-fallback" aria-label={maker.name}>{maker.name.slice(0, 1)}</span>;
}
const number = (value: number) => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
export function SkillCatalog({ items, entries, query, pending, install, inspect, openSource }: { items: CatalogSkill[]; entries: PluginView[]; query: string; pending: string; install: (item: CatalogSkill) => void; inspect: (item: CatalogSkill) => void; openSource: (url: string) => void }) {
  const [category, setCategory] = useState('all'), [maker, setMaker] = useState('all'), [order, setOrder] = useState('featured');
  const categories = [...new Set(items.map(item => item.category))], makers = [...new Map(items.map(item => [item.maker.id, item.maker])).values()];
  const matches = items.filter(item => (category === 'all' || category === item.category) && (maker === 'all' || maker === item.maker.id) && `${item.title} ${item.skill.name} ${item.skill.description} ${item.tags.join(' ')} ${item.maker.name} ${item.source.repository}`.toLowerCase().includes(query.toLowerCase().trim())).sort((a, b) => order === 'stars' ? b.popularity.repositoryStars - a.popularity.repositoryStars || a.rank - b.rank : order === 'name' ? a.title.localeCompare(b.title) : a.rank - b.rank);
  function card(item: CatalogSkill, featured = false) {
    const entry = entries.find(value => value.manifest.id === item.id), busy = pending === item.id;
    return <article className={`skill-card upstream-skill-card ${featured ? 'is-featured' : ''}`} key={item.id} data-skill-id={item.id} onClick={event => { if (!pending && !(event.target as HTMLElement).closest('button, a')) inspect(item); }}>
      <div className="upstream-skill-heading"><SkillMakerAvatar maker={item.maker} /><button type="button" className="skill-card-title" disabled={!!pending} onClick={() => inspect(item)}>{item.title}</button><button type="button" className="skill-source-action" aria-label={`View ${item.title} on GitHub`} title="View original SKILL.md on GitHub" onClick={() => openSource(item.source.url)}><ExternalLink /></button></div>
      <p className="upstream-skill-description">{item.skill.description}</p>
      <div className="skill-catalog-tags"><span>{item.category}</span>{item.tags.map(tag => <span key={tag}>{tag}</span>)}{item.modes.length === 1 && <span>Code</span>}</div>
      <div className="skill-catalog-maker"><button type="button" onClick={() => openSource(item.maker.url)}>{item.maker.name}</button><span title={`${item.popularity.repositoryStars.toLocaleString()} GitHub repository stars, checked ${new Date(item.popularity.checkedAt).toLocaleDateString()}`} aria-label={`${item.popularity.repositoryStars} repository stars`}><Star />{number(item.popularity.repositoryStars)}</span></div>
      <button type="button" className="skill-catalog-repository" title={item.source.repository} onClick={() => openSource(`https://github.com/${item.source.repository}`)}>{item.source.repository}</button>
      <div className="skill-catalog-footer"><span>{item.source.license}{item.invocation === 'manual' ? ' · Only when chosen' : ''}</span><Button variant={entry ? 'muted' : 'pill'} aria-label={`${entry ? 'Inspect' : 'Add'} ${item.title}`} disabled={!!pending} onClick={() => entry ? inspect(item) : install(item)}>{busy ? <LoaderCircle className="animate-spin" /> : entry ? <Check /> : <Plus />}{busy ? 'Adding…' : entry ? 'Added' : 'Add'}</Button></div>
    </article>;
  }
  return <>
    {!query && category === 'all' && maker === 'all' && order === 'featured' && <section className="catalog-section"><div className="catalog-section-heading"><h2>Popular picks</h2><span>Useful workflows</span></div><div className="upstream-skills-grid featured-skills-grid">{items.filter(item => item.rank <= 6).map(item => card(item, true))}</div></section>}
    <div className="skill-catalog-browse-heading"><h2>All skills <span>{matches.length}</span></h2><div className="skill-catalog-filters"><SettingsSelect aria-label="Filter skills by maker" value={maker} onChange={event => setMaker(event.target.value)}><option value="all">All makers</option>{makers.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</SettingsSelect><SettingsSelect aria-label="Sort skills" value={order} onChange={event => setOrder(event.target.value)}><option value="featured">Featured</option><option value="stars">Repository stars</option><option value="name">Name</option></SettingsSelect></div></div>
    <div className="skill-category-tabs" role="tablist" aria-label="Skill categories">{['all', ...categories].map(value => <button type="button" key={value} role="tab" aria-selected={category === value} className={category === value ? 'is-selected' : ''} onClick={() => setCategory(value)}>{value === 'all' ? 'All' : value}</button>)}</div>
    <div className="upstream-skills-grid">{matches.map(item => card(item))}</div>{!matches.length && <p className="plugin-library-empty"><BookOpen />No matching skills. Try another maker, category, or search.</p>}
  </>;
}

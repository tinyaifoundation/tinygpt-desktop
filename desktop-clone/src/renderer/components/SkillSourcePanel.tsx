import type { PluginSkill } from '../../shared/plugins';
import type { DesktopBridge } from '../../shared/contracts';
import { SkillMakerAvatar } from './SkillCatalog';

export function SkillSourcePanel({ skill, bridge }: { skill: PluginSkill; bridge: DesktopBridge }) {
  const origin = skill.upstream; if (!origin) return null;
  const open = (url: string) => { void bridge.openBrowserLink(url); };
  return <section className="skill-upstream-provenance"><header><SkillMakerAvatar maker={origin.maker} /><strong>{origin.maker.name}</strong></header><p>{origin.source.repository} · {origin.source.license}</p><p>{origin.modified ? 'Customized from the upstream skill' : 'Original upstream instructions'} · Pinned {origin.source.commit.slice(0, 8)} · {origin.source.files.length} package files</p><div className="skill-source-links"><button type="button" onClick={() => open(origin.source.url)}>View original skill</button><button type="button" onClick={() => open(origin.source.licenseUrl)}>License</button><button type="button" onClick={() => open(`https://github.com/${origin.source.repository}/tree/${origin.source.commit}/${origin.source.directory}`)}>Package files</button></div><details><summary>Included resources</summary><ul>{origin.source.files.map(file => <li key={file.path}>{file.path}</li>)}</ul></details><p>Adding downloads the original package. Scripts and dependencies follow the normal approvals when used.</p></section>;
}

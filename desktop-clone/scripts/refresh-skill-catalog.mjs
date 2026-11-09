// Review/update tool for TinyGPT's allowlisted upstream catalog. Downloads public
// source for inspection; never executes upstream code or installs dependencies.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parseDocument } from 'yaml';

const repositories = JSON.parse(await readFile('artifacts/upstream-skill-repositories.json', 'utf8'));
const trees = JSON.parse(await readFile('artifacts/upstream-skill-trees.json', 'utf8'));
const checkedAt = new Date().toISOString();
const makers = { anthropics: 'Anthropic', 'vercel-labs': 'Vercel', obra: 'Jesse Vincent', coreyhaines31: 'Corey Haines', supabase: 'Supabase', mattpocock: 'Matt Pocock', expo: 'Expo', openai: 'OpenAI', huggingface: 'Hugging Face' };
// Paths were verified against each repository's pinned tree. Rank is editorial
// ordering, not an invented quality score or per-skill GitHub star count.
const picks = [
  ['anthropics/skills','skills/frontend-design','Frontend Design','Design',['frontend','ui'],['code'],[],1],
  ['vercel-labs/agent-skills','skills/react-best-practices','React Best Practices','Development',['react','nextjs'],['code'],['React or Next.js project'],2],
  ['coreyhaines31/marketingskills','skills/copywriting','Copywriting','Writing',['marketing','copy'],null,[],3],
  ['obra/superpowers','skills/systematic-debugging','Systematic Debugging','Development',['debugging','testing'],['code'],['Project folder'],4],
  ['mattpocock/skills','skills/productivity/grilling','Grilling','Productivity',['planning','questions'],null,[],5],
  ['supabase/agent-skills','skills/supabase-postgres-best-practices','Postgres Best Practices','Data',['postgres','sql'],null,['SQL, query plans, or a PostgreSQL project'],6],
  ['anthropics/skills','skills/internal-comms','Internal Communications','Writing',['updates','communication'],null,[],7],
  ['anthropics/skills','skills/brand-guidelines','Anthropic Brand Guidelines','Design',['branding','typography'],null,['Applies Anthropic’s own brand'],8],
  ['anthropics/skills','skills/theme-factory','Theme Factory','Design',['themes','presentations'],['code'],['Project folder'],9],
  ['anthropics/skills','skills/webapp-testing','Web App Testing','Development',['playwright','qa'],['code'],['Python and Playwright'],10],
  ['anthropics/skills','skills/mcp-builder','MCP Builder','Development',['mcp','integrations'],['code'],['Python or Node.js'],11],
  ['anthropics/skills','skills/skill-creator','Skill Creator','Productivity',['skills','evaluation'],['code'],['Python; Claude CLI for upstream evaluation scripts'],12],
  ['vercel-labs/agent-skills','skills/web-design-guidelines','Web Design Guidelines','Design',['accessibility','web'],['code'],['Web project'],13],
  ['vercel-labs/agent-skills','skills/composition-patterns','React Composition Patterns','Development',['react','components'],['code'],['React project'],14],
  ['vercel-labs/agent-skills','skills/react-native-skills','React Native Best Practices','Development',['mobile','react-native'],['code'],['React Native project'],15],
  ['vercel-labs/agent-skills','skills/writing-guidelines','Writing Guidelines','Writing',['editing','technical-writing'],null,[],16],
  ['obra/superpowers','skills/verification-before-completion','Verification Before Completion','Development',['verification','quality'],['code'],['Project folder'],17],
  ['obra/superpowers','skills/test-driven-development','Test Driven Development','Development',['testing','tdd'],['code'],['Project folder and test runner'],18],
  ['obra/superpowers','skills/brainstorming','Brainstorming','Productivity',['planning','design'],['code'],['Project folder; Writing Plans for the upstream handoff'],19],
  ['obra/superpowers','skills/writing-plans','Writing Plans','Productivity',['planning','implementation'],['code'],['Project folder'],20],
  ['obra/superpowers','skills/receiving-code-review','Receiving Code Review','Development',['review','feedback'],['code'],['Project folder and review feedback'],21],
  ['coreyhaines31/marketingskills','skills/copy-editing','Copy Editing','Writing',['editing','marketing'],null,[],22],
  ['coreyhaines31/marketingskills','skills/seo-audit','SEO Audit','Research',['seo','web'],null,['Website or supplied site evidence'],23],
  ['coreyhaines31/marketingskills','skills/content-strategy','Content Strategy','Writing',['content','marketing'],null,[],24],
  ['coreyhaines31/marketingskills','skills/marketing-ideas','Marketing Ideas','Research',['growth','marketing'],null,[],25],
  ['coreyhaines31/marketingskills','skills/marketing-psychology','Marketing Psychology','Writing',['psychology','marketing'],null,[],26],
  ['coreyhaines31/marketingskills','skills/product-marketing','Product Marketing','Writing',['positioning','context'],null,[],27],
  ['coreyhaines31/marketingskills','skills/launch','Launch Strategy','Productivity',['launch','marketing'],null,[],28],
  ['coreyhaines31/marketingskills','skills/emails','Email Marketing','Writing',['email','copy'],null,[],29],
  ['coreyhaines31/marketingskills','skills/pricing','Pricing Strategy','Research',['pricing','marketing'],null,[],30],
  ['coreyhaines31/marketingskills','skills/customer-research','Customer Research','Research',['customers','research'],null,[],31],
  ['mattpocock/skills','skills/productivity/teach','Teach','Productivity',['learning','explanations'],null,[],32],
  ['mattpocock/skills','skills/engineering/code-review','Code Review','Development',['review','quality'],['code'],['Project folder'],33],
  ['mattpocock/skills','skills/productivity/writing-for-agents','Writing for Agents','Writing',['documentation','agents'],null,[],34],
  ['openai/skills','skills/.curated/pdf','PDF','Productivity',['pdf','documents'],['code'],['Python, reportlab, pdfplumber, pypdf; Poppler for rendering'],35],
  ['openai/skills','skills/.curated/security-best-practices','Security Best Practices','Development',['security','review'],['code'],['Project folder'],36],
  ['openai/skills','skills/.curated/security-threat-model','Security Threat Modeling','Development',['security','architecture'],['code'],['Project folder'],37],
  ['expo/skills','plugins/expo/skills/expo-ui','Expo UI','Development',['expo','mobile'],['code'],['Expo project'],38],
  ['expo/skills','plugins/expo/skills/expo-router','Expo Router','Development',['expo','navigation'],['code'],['Expo project'],39],
  ['huggingface/skills','skills/huggingface-papers','Hugging Face Papers','Research',['papers','ml'],null,[],40],
];
const blobHash = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
async function get(repository, commit, file) {
  const response = await fetch(`https://raw.githubusercontent.com/${repository}/${commit}/${file.path.split('/').map(encodeURIComponent).join('/')}`, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw Error(`${repository}/${file.path}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer()); if (bytes.length !== file.size || blobHash(bytes) !== file.sha) throw Error(`Upstream integrity mismatch: ${file.path}`); return bytes;
}
await mkdir('artifacts/skill-research', { recursive: true }); const catalog = [];
for (const [repository, path, title, category, tags, modes, requirements, rank] of picks) {
  const repo = repositories.find(item => item.repository === repository), tree = trees.find(item => item.repository === repository);
  const skillFile = tree.files.find(file => file.path === `${path}/SKILL.md`); if (!skillFile) throw Error(`Missing real skill: ${repository}/${path}`);
  const bytes = await get(repository, tree.commit, skillFile), raw = bytes.toString('utf8');
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]+)$/.exec(raw); if (!match) throw Error(`Invalid skill: ${path}`);
  const doc = parseDocument(match[1]); if (doc.errors.length) throw Error(`Invalid YAML: ${path}`); const metadata = doc.toJS({ maxAliasCount: 0 });
  if (!metadata.name || !metadata.description || match[2].trim().length > 64000 || metadata.description.length > 4000) throw Error(`Unsupported metadata/size: ${path}`);
  const licenseFile = tree.files.find(file => file.path.startsWith(path + '/') && /^LICENSE(?:\.txt|\.md)?$/i.test(file.path.slice(path.length + 1))) ?? tree.files.find(file => /^LICENSE(?:\.txt|\.md)?$/i.test(file.path)) ?? tree.files.find(file => file.path === 'README.md');
  if (!licenseFile) throw Error(`No license evidence: ${repository}/${path}`);
  const licenseBytes = await get(repository, tree.commit, licenseFile), licenseText = licenseBytes.toString('utf8');
  const license = /Apache License[\s\S]{0,150}Version 2\.0/i.test(licenseText) ? 'Apache-2.0' : /MIT License|## License\s+MIT|Permission is hereby granted, free of charge/i.test(licenseText) ? 'MIT' : undefined;
  if (!license) throw Error(`License requires review: ${repository}/${path}`);
  const files = tree.files.filter(file => file.path.startsWith(path + '/')).map(file => ({ path: file.path.slice(path.length + 1), repositoryPath: file.path, sha: file.sha, size: file.size, kind: /\.(png|jpe?g|gif|webp|pdf|ttf|otf|woff2?|zip)$/i.test(file.path) ? 'asset' : 'text', mode: file.mode }));
  if (!licenseFile.path.startsWith(path + '/')) files.push({ path: licenseFile.path === 'README.md' ? 'UPSTREAM-README.md' : 'UPSTREAM-LICENSE.txt', repositoryPath: licenseFile.path, sha: licenseFile.sha, size: licenseFile.size, kind: 'text', mode: licenseFile.mode });
  if (files.length > 256 || files.some(file => !['100644','100755'].includes(file.mode) || file.size > 1024*1024) || files.reduce((sum,file)=>sum+file.size,0) > 4*1024*1024) throw Error(`Package requires separate support: ${repository}/${path}`);
  const owner = repository.split('/')[0], id = `github-${owner}-${metadata.name}`.toLowerCase(); if (id.length > 61) throw Error(`Package ID too long: ${id}`);
  const url = `https://github.com/${repository}/blob/${tree.commit}/${path}/SKILL.md`;
  const item = { id, title, category, tags, rank, version: /^\d+\.\d+\.\d+$/.test(String(metadata.metadata?.version ?? '')) ? String(metadata.metadata.version) : '1.0.0', modes: modes ?? ['chat','code','bot'], invocation: metadata['disable-model-invocation'] === true ? 'manual' : 'automatic', skill: { name: metadata.name, description: metadata.description, requirements, ...(typeof metadata.compatibility === 'string' ? { compatibility: metadata.compatibility } : {}) }, maker: { id: owner, name: makers[owner], url: `https://github.com/${owner}`, avatarUrl: repo.avatarUrl }, popularity: { repositoryStars: repo.stars, checkedAt }, source: { repository, commit: tree.commit, directory: path, url, license, licenseUrl: `https://github.com/${repository}/blob/${tree.commit}/${licenseFile.path}`, checkedAt, pushedAt: repo.updatedAt, files: files.map(({mode,...file}) => file) } };
  catalog.push(item);
  await writeFile(join('artifacts/skill-research', `${id}.md`), raw);
  await writeFile(join('artifacts/skill-research', `${id}.license.txt`), licenseBytes);
  console.log(`${title} · ${makers[owner]} · ${files.length} files · ${license}`);
}
await writeFile('src/shared/skill-catalog.json', JSON.stringify(catalog, null, 2) + '\n');
await mkdir('src/renderer/assets/skill-makers', { recursive: true });
for (const owner of [...new Set(catalog.map(item=>item.maker.id))]) {
  const url = new URL(catalog.find(item=>item.maker.id===owner).maker.avatarUrl); url.searchParams.set('s','96');
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw Error(`Avatar failed: ${owner}`);
  const bytes = Buffer.from(await response.arrayBuffer()); if(bytes.length>256000) throw Error(`Avatar too large: ${owner}`); await writeFile(`src/renderer/assets/skill-makers/${owner}.png`,bytes);
}
console.log(`Verified ${catalog.length} real upstream skills from ${new Set(catalog.map(item=>item.maker.id)).size} makers.`);

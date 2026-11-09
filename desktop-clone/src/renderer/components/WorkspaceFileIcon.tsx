import { Braces, File, FileCode2, FileImage, FileText, FileType2, GitBranch, Package, Settings, Container } from '../icons';

export function WorkspaceFileIcon({ name }: { name: string }) {
  const extension = name.split('.').at(-1)?.toLowerCase();
  const [Icon, color] = /^(package(?:-lock)?\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(name) ? [Package, 'var(--code-keyword)'] : name.startsWith('.git') ? [GitBranch, 'var(--code-number)'] : /^(Dockerfile|\.dockerignore)$/.test(name) ? [Container, 'var(--code-function)'] : /^(json|yaml|yml)$/.test(extension ?? '') ? [Braces, 'var(--code-number)'] : /^(png|jpg|jpeg|webp|svg|gif|avif)$/.test(extension ?? '') ? [FileImage, 'var(--code-function)'] : /^(md|mdx|txt)$/.test(extension ?? '') ? [FileText, 'var(--muted-foreground)'] : /^(ts|tsx|js|jsx|css|html|py|rs|go|java|c|cpp|sh|ps1)$/.test(extension ?? '') ? [FileCode2, 'var(--code-function)'] : /^(toml|ini|cfg)$/.test(extension ?? '') ? [Settings, 'var(--muted-foreground)'] : /^(woff2?|ttf|otf)$/.test(extension ?? '') ? [FileType2, 'var(--code-type)'] : [File, 'var(--muted-foreground)'];
  return <Icon className="workspace-file-icon" style={{ color }} aria-hidden="true" />;
}

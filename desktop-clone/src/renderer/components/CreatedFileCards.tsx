import { FileImage, FileSpreadsheet, FileText } from '../icons';
import { createdFiles, type CreatedFile } from '../../core/created-files';
import type { ToolActivity } from '../../shared/tools';

export function CreatedFileCards({ tools, open }: { tools: ToolActivity[]; open: (file: CreatedFile) => void }) {
  const files = createdFiles(tools);
  if (!files.length) return null;
  return <div data-slot="created-files" className="created-file-cards">{files.map(file => {
    const Icon = ['Excel', 'CSV'].includes(file.type) ? FileSpreadsheet : file.type === 'Image' ? FileImage : FileText;
    return <button key={file.path} type="button" className="created-file-card" aria-label={`Open ${file.name} in workspace`} onClick={() => open(file)}>
      <Icon aria-hidden="true" strokeWidth={1.25} className={file.type === 'Excel' ? 'text-emerald-500' : undefined} />
      <span><strong>{file.name}</strong><small>{file.type}</small></span>
    </button>;
  })}</div>;
}

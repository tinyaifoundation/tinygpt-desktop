export type OutputCategory = 'pages' | 'sites' | 'images' | 'files';
export interface LibraryOutput {
  excluded?: boolean;
  origin?: 'created' | 'upload' | 'project' | 'source';
  processing?: import('./source-files').FileProcessing;
  id: string;
  sourceId?: string;
  path: string;
  name: string;
  type: string;
  category: OutputCategory;
  conversationId: string;
  conversationTitle: string;
  projectId?: string;
  generated?: boolean;
  projectName?: string;
  updatedAt: number;
}

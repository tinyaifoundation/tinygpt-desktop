export type FileProcessing = { status: 'preparing' | 'ready' | 'partial' | 'failed'; notice?: string; sha256: string };
export type ExtractedDocument = { text: string; status: 'ready' | 'partial'; notice?: string };

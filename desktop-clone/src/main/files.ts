import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { lstat, open, readdir, realpath, stat, mkdir } from 'node:fs/promises';
import type { SourceLibrary } from './sources';
import type { SourceSummary } from '../shared/tools';
import { acquireFileWrites } from './file-write-locks';

export const textExtensions = new Set(['.txt', '.md', '.mdx', '.csv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.py', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.cs', '.sql', '.sh', '.ps1', '.log', '.ini', '.cfg']);
const maxBytes = 15 * 1024 * 1024;
const protectedNames = /^(\.env(?:\..*)?|\.npmrc|\.pypirc|credentials(?:\..*)?|id_(rsa|ed25519|dsa)|.*\.(pem|pfx|key|p12))$/i;
export function insideRoot(root: string, path: string): boolean {
  const difference = relative(root, path);
  return difference === '' || (!isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${sep}`));
}
export async function scopedPath(root: string | null, requested: string, write = false): Promise<string> {
  if (!root) throw new Error('Select a Project folder before using file tools.');
  if (isAbsolute(requested) || /^[A-Za-z]:/.test(requested) || requested.includes(':') || requested.includes('\0')) throw new Error('Use a relative path inside the Project folder.');
  const canonicalRoot = await realpath(root);
  const equalPath = (a: string, b: string) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!equalPath(canonicalRoot, resolve(root))) throw new Error('The Project folder changed. Select it again.');
  const path = resolve(canonicalRoot, requested);
  if (!insideRoot(canonicalRoot, path)) throw new Error('That path is outside the Project folder.');
  if (requested.split(/[\\/]/).some(part => protectedNames.test(part) || ['.git', '.ssh', '.aws', '.codex', '.agents'].includes(part.toLowerCase()))) throw new Error('Sensitive configuration files are not available to file tools. Attach a file explicitly if you want to share it.');
  let canonical: string;
  try { canonical = await realpath(path); }
  catch (error) {
    if (!write || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    canonical = resolve(await realpath(dirname(path)), basename(path));
  }
  if (!insideRoot(canonicalRoot, canonical)) throw new Error('A link points outside the Project folder.');
  if (relative(canonicalRoot, canonical).split(/[\\/]/).some(part => protectedNames.test(part) || ['.git', '.ssh', '.aws', '.codex', '.agents'].includes(part.toLowerCase()))) throw new Error('Sensitive configuration files are not available to file tools. Attach a file explicitly if you want to share it.');
  return canonical;
}
export async function readLimited(path: string): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('Choose a regular file.');
    if (metadata.size > maxBytes) throw new Error('Files must be 15 MB or smaller.');
    const bytes = Buffer.alloc(Math.min(metadata.size + 1, maxBytes + 1));
    let length = 0;
    while (length < bytes.length) { const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null); if (!bytesRead) break; length += bytesRead; }
    if (length > maxBytes) throw new Error('Files must be 15 MB or smaller.');
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
export async function extractFile(path: string, bytes: Buffer, signal?: AbortSignal): Promise<string> {
  if (backgroundExtractor) return backgroundExtractor(path, bytes, signal);
  return extractFileLocally(path, bytes, signal);
}
type FileExtractor = (path: string, bytes: Buffer, signal?: AbortSignal) => Promise<string>;
let backgroundExtractor: FileExtractor | undefined;
export function installFileExtractor(extractor: FileExtractor): void { backgroundExtractor = extractor; }
async function extractFileLocally(path: string, bytes: Buffer, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (extname(path).toLowerCase() === '.pdf') {
    const specifier = 'pdfjs-dist/legacy/build/pdf.mjs';
    const pdfjs = await import(/* @vite-ignore */ specifier) as typeof import('pdfjs-dist');
    // Electron utility processes are not detected as ordinary Node by PDF.js.
    // Resolve the shipped worker explicitly, including when inside app.asar.
    const resolveModule = createRequire(typeof __filename === 'string' ? __filename : resolve('package.json'));
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(resolveModule.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useWorkerFetch: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        (async () => {
          const document = await task.promise;
          if (document.numPages > 200) throw new Error('PDFs must have 200 pages or fewer.');
          let text = '';
          for (let page = 1; page <= document.numPages && text.length < 500000; page++) {
            const content = await (await document.getPage(page)).getTextContent();
            text += `\n\nPage ${page}\n${content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('')}`;
          }
          if (!text.replace(/Page \d+/g, '').trim()) throw new Error('This PDF has no readable text. Scanned PDFs need OCR, which is not available yet.');
          return text.slice(0, 500000);
        })(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The PDF could not be read within 30 seconds.')), 30000); }),
        new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Cancelled.')); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); }),
      ]);
    } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); await task.destroy(); }
  }
  if (!textExtensions.has(extname(path).toLowerCase())) throw new Error('Choose a text/code file, PDF, PNG, JPEG, or WebP image.');
  if (bytes.subarray(0, 8192).includes(0)) throw new Error('This file is not supported UTF-8 text.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.length > 500000) throw new Error('Text files must contain 500,000 characters or fewer.');
  return text;
}
export class ProjectFiles {
  constructor(private sources: SourceLibrary) {}
  async createDirectory(root: string | null, requested: string, signal: AbortSignal): Promise<{ path: string }> {
    // Validate the entire target before creating anything, then check each
    // ancestor as it is created. No recursive mkdir through unchecked links.
    if (requested.split(/[\\/]/).some(part => part === '..')) throw new Error('That path is outside the Project folder.');
    const parts = requested.split(/[\\/]/).filter(part => part && part !== '.');
    // Validate root, absolute/drive syntax and sensitive path components first.
    for (const part of parts) { if (protectedNames.test(part) || ['.git','.ssh','.aws','.codex','.agents'].includes(part.toLowerCase())) throw new Error('Sensitive configuration files are not available to file tools. Attach a file explicitly if you want to share it.'); }
    if (isAbsolute(requested) || requested.includes(':') || requested.includes('\0')) throw new Error('Use a relative path inside the Project folder.');
    await scopedPath(root,'.');
    for (let index = 0; index < parts.length; index++) {
      signal.throwIfAborted(); const path = await scopedPath(root,parts.slice(0,index+1).join('/'),true);
      try { await mkdir(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await stat(path)).isDirectory()) throw error; }
    }
    return { path: requested };
  }
  async list(root: string | null, requested: string, signal: AbortSignal): Promise<{ path: string; entries: { name: string; directory: boolean }[]; truncated: boolean }> {
    const path = await scopedPath(root, requested); signal.throwIfAborted();
    const entries = await readdir(path, { withFileTypes: true });
    return { path: requested, entries: entries.filter(item => !protectedNames.test(item.name) && !['.git', '.ssh', '.aws', '.codex', '.agents', 'node_modules'].includes(item.name.toLowerCase())).slice(0, 200).map(item => ({ name: item.name, directory: item.isDirectory() })), truncated: entries.length > 200 };
  }
  async read(conversationId: string, root: string | null, requested: string, signal: AbortSignal, limit = 24000): Promise<{ source: SourceSummary; text: string; citation: string; sha256: string; truncated: boolean }> {
    const path = await scopedPath(root, requested); const bytes = await readLimited(path); signal.throwIfAborted();
    const text = await extractFile(path, bytes, signal); signal.throwIfAborted();
    // Recheck symlink/junction scope after extraction before returning/indexing.
    if (await scopedPath(root, requested) !== path) throw new Error('The file changed while it was being read. Try again.');
    const source = this.sources.add(conversationId, { kind: 'project-file', title: requested, url: `project-file:${requested}`, text, size: bytes.length });
    return { source, text: text.slice(0, limit), citation: `[${source.title}](tinygpt-source:${source.id})`, sha256: createHash('sha256').update(bytes).digest('hex'), truncated: text.length > limit };
  }
  async write(root: string | null, requested: string, content: string, signal: AbortSignal, expected?: string | null): Promise<{ path: string; bytes: number }> {
    const path = await scopedPath(root, requested, true);
    const release = acquireFileWrites([path]);
    try {
    if (!textExtensions.has(extname(path).toLowerCase())) throw new Error('File tools write supported text/code formats only.');
    let exists = false;
    try { const info = await lstat(path); exists = true; if (!info.isFile() || info.isSymbolicLink()) throw new Error('Choose a regular file.'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (expected !== undefined && (expected === null && exists || expected !== null && !exists)) throw new Error('The file changed on disk. Read it again before editing or undoing.');
    signal.throwIfAborted();
    const handle = await open(path, exists ? 'r+' : 'wx');
    try {
      const opened = await handle.stat(); const current = await stat(path);
      if (await scopedPath(root, requested, true) !== path || !opened.isFile() || opened.ino !== current.ino || opened.dev !== current.dev) throw new Error('The file changed before writing. Try again.');
      if (expected !== undefined && expected !== null) {
        if (opened.size > maxBytes) throw new Error('Files must be 15 MB or smaller.');
        const bytes = Buffer.alloc(opened.size); await handle.read(bytes,0,bytes.length,0);
        if (bytes.toString('utf8') !== expected) throw new Error('The file changed on disk. Read it again before editing or undoing.');
      }
      signal.throwIfAborted(); const bytes = Buffer.from(content);
      await handle.writeFile(bytes); await handle.truncate(bytes.length); await handle.sync();
      return { path: requested, bytes: bytes.length };
    } finally { await handle.close(); }
    } finally { release(); }
  }
  /** Copy a verified package asset into a fresh file only. This grants no run
   * permission and cannot replace an existing Project file. */
  async writeNewPackageFile(root: string, requested: string, bytes: Uint8Array, signal: AbortSignal): Promise<{ path: string; bytes: number }> {
    if (bytes.length > 1024 * 1024) throw Error('Skill package files must be 1 MB or smaller.');
    const path = await scopedPath(root, requested, true), release = acquireFileWrites([path]);
    try { signal.throwIfAborted(); const handle = await open(path, 'wx');
      try { const opened = await handle.stat(), current = await stat(path); if (await scopedPath(root, requested, true) !== path || opened.ino !== current.ino || opened.dev !== current.dev) throw Error('The file changed before copying.'); signal.throwIfAborted(); await handle.writeFile(bytes); await handle.sync(); return { path: requested, bytes: bytes.length }; } finally { await handle.close(); }
    } finally { release(); }
  }
}

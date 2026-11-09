import { mkdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { HistoryStore } from './history';
import { ProjectFiles, scopedPath } from './files';

export function fileDestination(history: HistoryStore, conversationId: string, generated = false) {
  const chat = history.conversation(conversationId);
  const project = chat.projectId ? history.project(chat.projectId) : null;
  if (!generated && project?.rootPath) return { root: project.rootPath, projectId: project.id, generated: false };
  if (!/^[a-f0-9-]{36}$/i.test(conversationId)) throw new Error('Conversation not found.');
  return { root: join(history.generatedFilesRoot, conversationId), projectId: null, generated: true };
}

export async function prepareFileDestination(history: HistoryStore, conversationId: string, signal: AbortSignal, generated = false) {
  const destination = fileDestination(history, conversationId, generated);
  signal.throwIfAborted();
  if (destination.generated) {
    await mkdir(history.generatedFilesRoot, { recursive: true });
    const actual = await realpath(history.generatedFilesRoot);
    const equal = process.platform === 'win32' ? actual.toLowerCase() === resolve(history.generatedFilesRoot).toLowerCase() : actual === resolve(history.generatedFilesRoot);
    if (!equal) throw new Error('The generated files folder changed. Try again.');
    await new ProjectFiles(history.sources).createDirectory(history.generatedFilesRoot, conversationId, signal);
    await scopedPath(destination.root, '.');
  }
  return destination;
}

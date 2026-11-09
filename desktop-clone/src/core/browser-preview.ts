import type { LibrarySnapshot } from '../shared/chat';
export type BrowserPreviewTask = NonNullable<LibrarySnapshot['browserTasks']>[number];
export function browserPreviewOrder(tasks: BrowserPreviewTask[], selectedId: string) {
  const unique = tasks.filter((task, index) => tasks.findIndex(other => other.tabId === task.tabId) === index);
  const index = unique.findIndex(task => task.tabId === selectedId);
  return index < 0 ? unique.slice().reverse() : [...unique.slice(index), ...unique.slice(0, index)];
}
export function nextBrowserPreview(tasks: BrowserPreviewTask[], selectedId: string, step: number) {
  const index = tasks.findIndex(task => task.tabId === selectedId);
  return tasks.length ? tasks[((index < 0 ? tasks.length - 1 : index) + step + tasks.length) % tasks.length].tabId : '';
}

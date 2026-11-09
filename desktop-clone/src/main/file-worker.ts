import { extractDocument } from './document-extraction';
import { constants, setPriority } from 'node:os';
const port = process.parentPort!;
let queue = Promise.resolve(); const controllers = new Map<number, AbortController>();
try { setPriority(process.pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
port.on('message', event => {
  const input = event.data as { id: number; cancel?: boolean; name: string; bytes: Uint8Array };
  if (input.cancel) { controllers.get(input.id)?.abort(); return; }
  const controller = new AbortController(); controllers.set(input.id, controller);
  queue = queue.then(async () => {
    try {
      controller.signal.throwIfAborted();
      if (input.bytes.byteLength > 15 * 1024 * 1024) throw new Error('Files must be 15 MB or smaller.');
      const document = await extractDocument(input.name, Buffer.from(input.bytes), controller.signal);
      port.postMessage({ id: input.id, text: document.text, document });
    } catch (error) { port.postMessage({ id: input.id, error: error instanceof Error ? error.message : 'This document could not be read.' }); }
    finally { controllers.delete(input.id); }
  });
});
port.postMessage({ ready: true });

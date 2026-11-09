import koffi from 'koffi';

let query: ((pid: number) => string | undefined) | undefined;
/** Read-only process identity, never a model-supplied executable or command. */
export function computerExecutable(pid: number): string | undefined {
  if (process.platform !== 'win32' || !Number.isSafeInteger(pid) || pid < 4) return;
  if (!query) {
    const kernel = koffi.load('kernel32.dll');
    const open = kernel.func('void *OpenProcess(uint32_t access, bool inherit, uint32_t pid)');
    const close = kernel.func('bool CloseHandle(void *handle)');
    const image = kernel.func('bool QueryFullProcessImageNameW(void *handle, uint32_t flags, void *name, _Inout_ uint32_t *size)');
    query = processId => {
      const handle = open(0x1000, false, processId);
      if (!handle) return;
      try {
        const bytes = Buffer.alloc(65536); const size = [32768];
        return image(handle, 0, bytes, size) ? bytes.toString('utf16le', 0, size[0] * 2) : undefined;
      } finally { close(handle); }
    };
  }
  return query(pid);
}

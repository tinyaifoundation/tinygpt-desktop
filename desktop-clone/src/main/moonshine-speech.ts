import { utilityProcess, type UtilityProcess } from "electron";
import { join } from "node:path";
export class Speech {
  private worker?: UtilityProcess;
  private ready?: Promise<void>;
  private starts = new Map<
    string,
    {
      resolve: () => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private root: string,
    private event: (e: any) => void,
  ) {}
  warm() {
    if (this.ready) return this.ready;
    const worker = (this.worker = utilityProcess.fork(
      join(__dirname, "moonshine-worker.js"),
      [],
      { serviceName: "Speech to text", stdio: "pipe" },
    ));
    worker.stdout?.on("data", () => {});
    worker.stderr?.on("data", () => {});
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Error("Speech model took too long to load."));
        if (this.worker === worker) this.close();
      }, 90000);
      worker.on("message", (e) => {
        if (e.type === "ready") {
          clearTimeout(timer);
          resolve();
        } else if (e.type === "started") {
          const start = this.starts.get(e.id);
          if (start) {
            clearTimeout(start.timer);
            start.resolve();
            this.starts.delete(e.id);
          }
        } else if (e.type === "error") {
          clearTimeout(timer);
          reject(Error(e.message));
          const start = this.starts.get(e.id);
          if (start) {
            clearTimeout(start.timer);
            start.reject(Error(e.message));
            this.starts.delete(e.id);
          }
          this.event(e);
        } else this.event(e);
      });
      worker.once("spawn", () =>
        worker.postMessage({ type: "init", root: this.root }),
      );
      worker.once("exit", () => {
        clearTimeout(timer);
        reject(Error("Speech engine stopped."));
        if (this.worker === worker) {
          this.worker = undefined;
          this.ready = undefined;
          for (const start of this.starts.values()) {
            clearTimeout(start.timer);
            start.reject(Error("Speech engine stopped."));
          }
          this.starts.clear();
          this.event({
            type: "error",
            message: "Speech engine stopped. Enable voice again.",
          });
        }
      });
    });
    this.ready.catch(() => {
      if (this.worker === worker) this.close();
    });
    return this.ready;
  }
  async start(id: string) {
    await this.warm();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.starts.delete(id);
        reject(Error("Speech session did not start."));
      }, 15000);
      this.starts.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ type: "start", id });
    });
  }
  audio(id: string, values: Float32Array, rate: number) {
    this.worker?.postMessage({ type: "audio", id, values, rate });
  }
  stop(id: string) {
    this.worker?.postMessage({ type: "stop", id });
  }
  cancel() {
    for (const start of this.starts.values()) {
      clearTimeout(start.timer);
      start.reject(new DOMException("Canceled", "AbortError"));
    }
    this.starts.clear();
    this.worker?.postMessage({ type: "cancel" });
  }
  close() {
    this.cancel();
    const worker = this.worker;
    this.worker = undefined;
    this.ready = undefined;
    worker?.kill();
  }
}

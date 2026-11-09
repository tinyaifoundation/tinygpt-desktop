import { Moonshine } from "./moonshine";
const port = process.parentPort!;
let engine: Moonshine | undefined,
  id = "";
port.on("message", ({ data: e }: any) => {
  try {
    if (e.type === "init") {
      engine = new Moonshine(e.root);
      port.postMessage({ type: "ready" });
    } else if (e.type === "start") {
      engine!.begin();
      id = e.id;
      port.postMessage({ type: "started", id });
    } else if (e.type === "audio" && e.id === id) {
      const text = engine!.audio(new Float32Array(e.values), e.rate);
      if (text !== undefined) port.postMessage({ type: "text", id, text });
    } else if (e.type === "stop" && e.id === id) {
      const text = engine!.finish();
      port.postMessage({ type: "final", id, text });
      id = "";
    } else if (e.type === "cancel") {
      engine?.cancel();
      id = "";
    }
  } catch (error) {
    port.postMessage({
      type: "error",
      id,
      message: "Speech to text could not process audio. Check the local voice runtime.",
    });
    engine?.cancel();
    id = "";
  }
});

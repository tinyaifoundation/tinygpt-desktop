import koffi from "koffi";
import { join } from "node:path";

export class Moonshine {
  private lib;
  private handle: number;
  private stream = -1;
  private elapsed = 0;
  private lastUpdate = 0;
  private passSeconds = 0.5;
  private create;
  private free;
  private start;
  private stop;
  private add;
  private transcribe;
  private error;
  private dispose;
  private Line;
  private Transcript;
  constructor(root: string) {
    if (process.platform === "win32")
      koffi.load(join(root, "moonshine", "onnxruntime.dll"));
    this.lib = koffi.load(
      join(
        root,
        "moonshine",
        process.platform === "win32" ? "moonshine.dll" : "libmoonshine.dylib",
      ),
    );
    this.Line = koffi.struct("VoiceTranscriptLine", {
      text: "str",
      audio_data: "void *",
      audio_data_count: "size_t",
      start_time: "float",
      duration: "float",
      id: "uint64_t",
      is_complete: "int8_t",
      is_updated: "int8_t",
      is_new: "int8_t",
      has_text_changed: "int8_t",
      have_speakers_changed: "int8_t",
      speaker_spans: "void *",
      speaker_span_count: "uint64_t",
      last_transcription_latency_ms: "uint32_t",
      words: "void *",
      word_count: "uint64_t",
    });
    this.Transcript = koffi.struct("VoiceTranscript", {
      lines: koffi.pointer(this.Line),
      line_count: "uint64_t",
    });
    if (koffi.sizeof(this.Line) !== 88 || koffi.sizeof(this.Transcript) !== 16)
      throw Error("Moonshine ABI mismatch.");
    this.error = this.lib.func(
      "const char *moonshine_error_to_string(int32_t error)",
    );
    const load = this.lib.func(
      "int32_t moonshine_load_transcriber_from_files(const char *path, uint32_t arch, void *options, uint64_t count, int32_t version)",
    );
    this.handle = load(join(root, "moonshine-model"), 5, null, 0, 30000);
    this.check(this.handle);
    this.dispose = this.lib.func(
      "void moonshine_free_transcriber(int32_t handle)",
    );
    this.create = this.lib.func(
      "int32_t moonshine_create_stream(int32_t handle, uint32_t flags)",
    );
    this.free = this.lib.func(
      "int32_t moonshine_free_stream(int32_t handle, int32_t stream)",
    );
    this.start = this.lib.func(
      "int32_t moonshine_start_stream(int32_t handle, int32_t stream)",
    );
    this.stop = this.lib.func(
      "int32_t moonshine_stop_stream(int32_t handle, int32_t stream)",
    );
    this.add = this.lib.func(
      "int32_t moonshine_transcribe_add_audio_to_stream(int32_t handle, int32_t stream, const float *samples, uint64_t count, int32_t rate, uint32_t flags)",
    );
    this.transcribe = this.lib.func(
      "int32_t moonshine_transcribe_stream(int32_t handle, int32_t stream, uint32_t flags, _Out_ void **result)",
    );
  }
  private check(code: number) {
    if (code < 0) throw Error(this.error(code) || "Moonshine failed.");
  }
  begin() {
    this.cancel();
    this.stream = this.create(this.handle, 0);
    this.check(this.stream);
    this.check(this.start(this.handle, this.stream));
    this.elapsed = this.lastUpdate = 0;
    this.passSeconds = 0.5;
  }
  audio(values: Float32Array, rate: number) {
    if (this.stream < 0) throw Error("No speech session.");
    this.check(
      this.add(this.handle, this.stream, values, values.length, rate, 0),
    );
    this.elapsed += values.length / rate;
    if (this.elapsed - this.lastUpdate >= Math.max(0.5, this.passSeconds)) {
      const start = Date.now(),
        text = this.read();
      this.passSeconds = Math.min(3, (Date.now() - start) / 1000);
      this.lastUpdate = this.elapsed;
      return text;
    }
  }
  private read() {
    const out = [null];
    this.check(this.transcribe(this.handle, this.stream, 0, out));
    if (!out[0]) return "";
    const data = koffi.decode(out[0], this.Transcript);
    const count = Number(data.line_count);
    if (count > 10000) throw Error("Invalid speech response.");
    if (!count) return "";
    const lines = koffi.decode(data.lines, this.Line, count) as {
      text: string;
    }[];
    return lines
      .map((l) => l.text || "")
      .join(" ")
      .trim();
  }
  finish() {
    if (this.stream < 0) return "";
    this.check(this.stop(this.handle, this.stream));
    try {
      return this.read();
    } finally {
      this.cancel();
    }
  }
  cancel() {
    if (this.stream >= 0) {
      this.free(this.handle, this.stream);
      this.stream = -1;
    }
  }
  close() {
    this.cancel();
    this.dispose(this.handle);
  }
}

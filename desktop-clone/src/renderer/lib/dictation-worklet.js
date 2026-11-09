// Capture mono PCM16 in 80 ms frames. Desktop IPC or the paired remote bridge
// forwards the samples to the native recognizer on the computer.
class DictationCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(Math.round(sampleRate * 0.08));
    this.offset = 0;
    this.energy = 0;
    this.stopped = false;
    this.port.onmessage = event => {
      if (event.data === 'stop') {
        this.stopped = true;
        if (this.offset) this.flush();
        this.port.postMessage({ stopped: true });
      }
    };
  }
  flush() {
    const pcm = this.frame.slice(0, this.offset);
    this.port.postMessage({ pcm: pcm.buffer, level: Math.min(1, Math.sqrt(this.energy / this.offset) * 8) }, [pcm.buffer]);
    this.offset = 0; this.energy = 0;
  }
  process(inputs) {
    if (this.stopped) return false;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] / channels.length;
      sample = Math.max(-1, Math.min(1, sample));
      this.frame[this.offset++] = Math.round(sample * (sample < 0 ? 32768 : 32767));
      this.energy += sample * sample;
      if (this.offset === this.frame.length) this.flush();
    }
    return true;
  }
}
registerProcessor('tinygpt-dictation', DictationCapture);

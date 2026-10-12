// VerseFlow recorder: passes the raw input samples (both channels) with the
// audio-clock frame of their first sample, in batches of ~4096 frames.
class VfRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.buf = [];
    this.len = 0;
    this.first = 0;
    this.port.onmessage = (e) => {
      if (e.data === "start") {
        this.on = true;
        this.buf = [];
        this.len = 0;
      } else if (e.data === "stop") {
        this.flush();
        this.on = false;
        this.port.postMessage({ done: true });
      }
    };
  }
  flush() {
    if (!this.len) return;
    const nch = this.buf[0].length;
    const out = [];
    for (let c = 0; c < nch; c++) {
      const a = new Float32Array(this.len);
      let o = 0;
      for (const block of this.buf) {
        a.set(block[c], o);
        o += block[c].length;
      }
      out.push(a);
    }
    this.port.postMessage({ frame: this.first, channels: out }, out.map((a) => a.buffer));
    this.buf = [];
    this.len = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (this.on && input && input.length) {
      if (!this.len) this.first = currentFrame;
      this.buf.push(input.map((ch) => ch.slice(0)));
      this.len += input[0].length;
      if (this.len >= 4096) this.flush();
    }
    return true;
  }
}
registerProcessor("vf-recorder", VfRecorder);

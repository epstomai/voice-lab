// audio.js — 麦克风采集与 Web Audio 管线
//
// 管线：MediaStreamSource ─┬─► specAnalyser (fftSize 大，取频谱 dB)
//                          └─► timeAnalyser (fftSize 小，取时域做基频检测)
//
// 关闭浏览器自带的回声消除/降噪/自动增益，以免污染谐波结构。

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.specAnalyser = null;
    this.timeAnalyser = null;
    this.freqDb = null;   // Float32Array，频谱（dB）
    this.timeBuf = null;  // Float32Array，时域采样
    this.running = false;
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }
  get fftSize() {
    return this.specAnalyser ? this.specAnalyser.fftSize : 8192;
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });

    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.source = this.ctx.createMediaStreamSource(this.stream);

    this.specAnalyser = this.ctx.createAnalyser();
    this.specAnalyser.fftSize = 8192;              // 频率分辨率 ≈ sampleRate/8192
    this.specAnalyser.smoothingTimeConstant = 0;   // 自行平滑，这里取原始值
    this.specAnalyser.minDecibels = -110;
    this.specAnalyser.maxDecibels = -10;

    this.timeAnalyser = this.ctx.createAnalyser();
    this.timeAnalyser.fftSize = 2048;              // 时域窗，约 40ms@48k

    this.source.connect(this.specAnalyser);
    this.source.connect(this.timeAnalyser);

    this.freqDb = new Float32Array(this.specAnalyser.frequencyBinCount);
    this.timeBuf = new Float32Array(this.timeAnalyser.fftSize);
    this.running = true;
  }

  /** 拉取当前帧的频谱与时域数据（原地写入复用的缓冲区）。 */
  poll() {
    if (!this.running) return null;
    this.specAnalyser.getFloatFrequencyData(this.freqDb);
    this.timeAnalyser.getFloatTimeDomainData(this.timeBuf);
    return { freqDb: this.freqDb, timeBuf: this.timeBuf };
  }

  async stop() {
    this.running = false;
    if (this.source) this.source.disconnect();
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.ctx) await this.ctx.close();
    this.ctx = this.source = this.specAnalyser = this.timeAnalyser = null;
    this.stream = null;
  }
}

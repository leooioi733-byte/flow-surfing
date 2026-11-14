class OceanAudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private surfFilter: BiquadFilterNode | null = null;
  private surfGain: GainNode | null = null;
  private wakeFilter: BiquadFilterNode | null = null;
  private wakeGain: GainNode | null = null;
  private breezeFilter: BiquadFilterNode | null = null;
  private breezeGain: GainNode | null = null;
  private rainFilter: BiquadFilterNode | null = null;
  private rainGain: GainNode | null = null;
  private lfoOsc: OscillatorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private isPlaying = false;
  private volume = 0.55;
  private nextGullTime = 0;
  private nextWaveSurgeTime = 0;

  private ensureContext() {
    if (this.ctx) return;
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const masterGain = ctx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(ctx.destination);

    // 4-second seamless pink/brown noise buffer for ocean roar, splashes & planing hiss
    const bufferSize = ctx.sampleRate * 4;
    const buffer = ctx.createBuffer(2, bufferSize, ctx.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const output = buffer.getChannelData(channel);
      let b0 = 0;
      let b1 = 0;
      let b2 = 0;
      let b3 = 0;
      let b4 = 0;
      let b5 = 0;
      let b6 = 0;
      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.045;
        b6 = white * 0.115926;
      }
    }
    this.noiseBuffer = buffer;

    const noiseSource = ctx.createBufferSource();
    noiseSource.buffer = buffer;
    noiseSource.loop = true;

    const surfFilter = ctx.createBiquadFilter();
    surfFilter.type = 'lowpass';
    surfFilter.frequency.value = 340;
    surfFilter.Q.value = 0.7;

    const surfGain = ctx.createGain();
    surfGain.gain.value = 0.38;

    // Secondary board-water wake channel (modulated dynamically during surfing)
    const wakeSource = ctx.createBufferSource();
    wakeSource.buffer = buffer;
    wakeSource.loop = true;

    const wakeFilter = ctx.createBiquadFilter();
    wakeFilter.type = 'bandpass';
    wakeFilter.frequency.value = 950;
    wakeFilter.Q.value = 0.8;

    const wakeGain = ctx.createGain();
    wakeGain.gain.value = 0.0;

    // Slow ocean wave swell LFO (~0.115 Hz = ~8.7s period)
    const lfoOsc = ctx.createOscillator();
    lfoOsc.type = 'sine';
    lfoOsc.frequency.value = 0.115;

    const lfoFreqGain = ctx.createGain();
    lfoFreqGain.gain.value = 260;

    const lfoAmpGain = ctx.createGain();
    lfoAmpGain.gain.value = 0.22;

    lfoOsc.connect(lfoFreqGain);
    lfoFreqGain.connect(surfFilter.frequency);

    lfoOsc.connect(lfoAmpGain);
    lfoAmpGain.connect(surfGain.gain);

    // Coastal palm-breeze & shoreline air layer
    const breezeSource = ctx.createBufferSource();
    breezeSource.buffer = buffer;
    breezeSource.loop = true;

    const breezeFilter = ctx.createBiquadFilter();
    breezeFilter.type = 'bandpass';
    breezeFilter.frequency.value = 1350;
    breezeFilter.Q.value = 0.55;

    const breezeGain = ctx.createGain();
    breezeGain.gain.value = 0.08;

    // Rain patter layer (bandpass-filtered broadband noise)
    const rainSource = ctx.createBufferSource();
    rainSource.buffer = buffer;
    rainSource.loop = true;

    const rainFilter = ctx.createBiquadFilter();
    rainFilter.type = 'bandpass';
    rainFilter.frequency.value = 2400;
    rainFilter.Q.value = 0.45;

    const rainGain = ctx.createGain();
    rainGain.gain.value = 0.0;

    noiseSource.connect(surfFilter);
    surfFilter.connect(surfGain);
    surfGain.connect(masterGain);

    wakeSource.connect(wakeFilter);
    wakeFilter.connect(wakeGain);
    wakeGain.connect(masterGain);

    breezeSource.connect(breezeFilter);
    breezeFilter.connect(breezeGain);
    breezeGain.connect(masterGain);

    rainSource.connect(rainFilter);
    rainFilter.connect(rainGain);
    rainGain.connect(masterGain);

    noiseSource.start();
    wakeSource.start();
    breezeSource.start(0, 1.3);
    rainSource.start(0, 2.7);
    lfoOsc.start();

    this.ctx = ctx;
    this.masterGain = masterGain;
    this.surfFilter = surfFilter;
    this.surfGain = surfGain;
    this.wakeFilter = wakeFilter;
    this.wakeGain = wakeGain;
    this.breezeFilter = breezeFilter;
    this.breezeGain = breezeGain;
    this.rainFilter = rainFilter;
    this.rainGain = rainGain;
    this.lfoOsc = lfoOsc;
    this.nextGullTime = ctx.currentTime + 2.2;
    this.nextWaveSurgeTime = ctx.currentTime + 3.5;
  }

  public setEnabled(enabled: boolean, volume = this.volume) {
    this.volume = volume;
    if (enabled) {
      this.ensureContext();
      if (!this.ctx || !this.masterGain) return;
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume();
      }
      this.masterGain.gain.setTargetAtTime(this.volume * 0.65, this.ctx.currentTime, 0.35);
      this.isPlaying = true;
    } else if (this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.25);
      this.isPlaying = false;
    }
  }

  public setVolume(volume: number) {
    this.volume = volume;
    if (this.isPlaying && this.ctx && this.masterGain) {
      this.masterGain.gain.setTargetAtTime(volume * 0.65, this.ctx.currentTime, 0.1);
    }
  }

  /**
   * Dynamically shapes ambient ocean & board planing audio + underwater muffling.
   */
  public updateSurfTelemetry(
    speed: number,
    carvingIntensity: number,
    inBarrel: boolean,
    underwaterFactor: number,
    isWaterActive: boolean,
    rainIntensity = 0
  ) {
    if (!this.isPlaying || !this.ctx || !this.surfFilter || !this.wakeFilter || !this.wakeGain) {
      return;
    }

    const now = this.ctx.currentTime;
    const sub = Math.max(0, Math.min(1, underwaterFactor));
    const rain = Math.max(0, Math.min(1, rainIntensity));

    // Muffle ambient ocean roar deeply when submerged underwater; heighten crispness inside barrel
    const targetCutoff =
      sub > 0.05
        ? 340 - sub * 230
        : inBarrel
          ? 640
          : 340 + Math.min(240, speed * 12);
    this.surfFilter.frequency.setTargetAtTime(targetCutoff, now, 0.08);

    // Coastal breeze & distant beach life fade gently underwater
    if (this.breezeGain && this.breezeFilter) {
      const targetBreeze = (1 - sub) * (isWaterActive ? 0.055 : 0.095) * (1 + rain * 0.45);
      this.breezeGain.gain.setTargetAtTime(targetBreeze, now, 0.25);
      this.breezeFilter.frequency.setTargetAtTime(isWaterActive ? 1150 : 1480, now, 0.3);
    }

    // Dynamic rainfall hiss & underwater muffle
    if (this.rainGain && this.rainFilter) {
      const targetRainGain = rain * (1 - sub * 0.85) * 0.24;
      const targetRainFreq = 2400 - sub * 1750;
      this.rainGain.gain.setTargetAtTime(targetRainGain, now, 0.22);
      this.rainFilter.frequency.setTargetAtTime(targetRainFreq, now, 0.14);
    }

    // Continuous board-on-water carving rush
    if (!isWaterActive || sub > 0.45) {
      this.wakeGain.gain.setTargetAtTime(0.0, now, 0.12);
    } else {
      const speedNorm = Math.max(0, Math.min(1, (speed - 2.5) / 14));
      const targetWakeGain = (speedNorm * 0.26 + carvingIntensity * 0.22 + (inBarrel ? 0.18 : 0)) * (1 - sub);
      const targetWakeFreq = 720 + speed * 58 + carvingIntensity * 420;
      this.wakeGain.gain.setTargetAtTime(targetWakeGain, now, 0.08);
      this.wakeFilter.frequency.setTargetAtTime(targetWakeFreq, now, 0.08);
    }

    // Periodic ambient coastal seagulls & breaking wave swells while above water
    if (sub < 0.2 && now >= this.nextGullTime) {
      this.nextGullTime = now + 5.5 + Math.random() * 6.5;
      this.playSeagullCall(isWaterActive ? 0.55 : 0.9);
    }
    if (sub < 0.35 && now >= this.nextWaveSurgeTime) {
      this.nextWaveSurgeTime = now + 6.5 + Math.random() * 4.5;
      this.playWaveBreakSurge(inBarrel ? 0.95 : 0.6);
    }
  }

  /**
   * Procedural coastal seagull cry with dual-harmonic downward pitch glide.
   */
  public playSeagullCall(distanceScale = 0.85) {
    if (!this.isPlaying || !this.ctx) return;
    const now = this.ctx.currentTime;
    const calls = Math.random() > 0.45 ? 2 : 1;

    for (let c = 0; c < calls; c++) {
      const t0 = now + c * 0.36;
      const baseFreq = 1650 + Math.random() * 380;

      const osc = this.ctx.createOscillator();
      const osc2 = this.ctx.createOscillator();
      osc.type = 'triangle';
      osc2.type = 'sine';

      osc.frequency.setValueAtTime(baseFreq * 0.88, t0);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.18, t0 + 0.07);
      osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.72, t0 + 0.27);

      osc2.frequency.setValueAtTime(baseFreq * 1.76, t0);
      osc2.frequency.exponentialRampToValueAtTime(baseFreq * 2.25, t0 + 0.07);
      osc2.frequency.exponentialRampToValueAtTime(baseFreq * 1.38, t0 + 0.27);

      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1850;
      bp.Q.value = 2.2;

      const gain = this.ctx.createGain();
      const peak = 0.028 * distanceScale * this.volume;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.linearRampToValueAtTime(peak, t0 + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);

      osc.connect(bp);
      osc2.connect(bp);
      bp.connect(gain);
      gain.connect(this.ctx.destination);

      osc.start(t0);
      osc2.start(t0);
      osc.stop(t0 + 0.3);
      osc2.stop(t0 + 0.3);
    }
  }

  /**
   * Subtle rolling deep whitewater swell surge.
   */
  public playWaveBreakSurge(intensity = 0.65) {
    if (!this.isPlaying || !this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(220, now);
    filter.frequency.linearRampToValueAtTime(680, now + 0.9);
    filter.frequency.exponentialRampToValueAtTime(190, now + 2.8);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.14 * intensity * this.volume, now + 0.75);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 2.9);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    src.start(now, Math.random() * 2.0);
    src.stop(now + 3.0);
  }

  /**
   * Soft distant leather volleyball pop synced with the beach match rally.
   */
  public playVolleyballHit(proximity = 0.6) {
    if (!this.isPlaying || !this.ctx || proximity <= 0.05) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(215 + Math.random() * 25, now);
    osc.frequency.exponentialRampToValueAtTime(92, now + 0.075);

    gain.gain.setValueAtTime(0.065 * proximity * this.volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.085);

    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  }

  /**
   * Plays a layered physical water impact / splash burst scaled by collision intensity (0..1).
   */
  public playWaterImpact(intensity: number) {
    if (!this.isPlaying || !this.ctx || !this.noiseBuffer) return;
    const amt = Math.max(0.15, Math.min(1.0, intensity));
    const now = this.ctx.currentTime;

    // 1. Sub-surface heavy thump for strong/medium wave slams
    if (amt > 0.32) {
      const thump = this.ctx.createOscillator();
      const thumpGain = this.ctx.createGain();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(92 + amt * 45, now);
      thump.frequency.exponentialRampToValueAtTime(34, now + 0.28);
      thumpGain.gain.setValueAtTime(0.24 * amt * this.volume, now);
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32);
      thump.connect(thumpGain);
      thumpGain.connect(this.ctx.destination);
      thump.start(now);
      thump.stop(now + 0.34);
    }

    // 2. Filtered broadband splash burst
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1400 - amt * 450, now);
    filter.frequency.exponentialRampToValueAtTime(280, now + 0.45 + amt * 0.35);
    filter.Q.value = 0.65;

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.45 * amt * this.volume, now + 0.025);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.5 + amt * 0.45);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    src.start(now, Math.random() * 2.0);
    src.stop(now + 0.55 + amt * 0.48);
  }

  /**
   * Plays a crisp water-break & breath-catching sound when resurfacing from a fall.
   */
  public playResurfaceSound() {
    if (!this.isPlaying || !this.ctx || !this.noiseBuffer) return;
    const now = this.ctx.currentTime;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(240, now);
    filter.frequency.exponentialRampToValueAtTime(1250, now + 0.32);

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.linearRampToValueAtTime(0.18 * this.volume, now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);

    src.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    src.start(now, Math.random() * 2.0);
    src.stop(now + 0.45);
  }

  public playSoftClick(pitch = 420) {
    if (!this.isPlaying || !this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(pitch, now);
    osc.frequency.exponentialRampToValueAtTime(pitch * 0.72, now + 0.08);
    gain.gain.setValueAtTime(0.06 * this.volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.085);
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 0.09);
  }

  public dispose() {
    if (this.lfoOsc) {
      try {
        this.lfoOsc.stop();
      } catch {
        // ignore if already stopped
      }
    }
    if (this.ctx) {
      void this.ctx.close();
      this.ctx = null;
    }
  }
}

export const oceanAudio = new OceanAudioEngine();

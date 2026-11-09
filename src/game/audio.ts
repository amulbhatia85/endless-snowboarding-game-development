import type { AudioFrameState, SoundEvent } from './engine';

/**
 * Afterglow audio manager.
 * Every sound is synthesised in real time with the Web Audio API — original,
 * licence-free, zero download, and reused buffers/nodes keep it lightweight.
 */

export interface AudioSettings {
  music: number;
  sfx: number;
  ambient: number;
  muted: boolean;
}

const SETTINGS_KEY = 'afterglow-audio-v1';
const DEFAULTS: AudioSettings = { music: 0.7, sfx: 0.8, ambient: 0.7, muted: false };

const mtof = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// Gentle D-major progression: Dmaj9 · Bm9 · Gmaj9 · A6sus
const CHORDS = [
  { bass: 38, pad: [62, 66, 69, 73, 76] },
  { bass: 35, pad: [59, 62, 66, 69, 73] },
  { bass: 31, pad: [59, 62, 66, 67, 71] },
  { bass: 33, pad: [57, 62, 64, 66, 69] },
];
const MELODY = [62, 64, 66, 69, 71, 74, 76, 78, 81, 83];
const COIN_SCALE = [86, 88, 90, 93, 95, 98, 100, 102];

type VoiceKind = 'woo' | 'whoa' | 'oof' | 'aah' | 'yeah';

interface Loop {
  src: AudioBufferSourceNode;
  filter: BiquadFilterNode;
  gain: GainNode;
}

export class AudioManager {
  settings: AudioSettings;
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private musicBus!: GainNode;
  private musicFade!: GainNode;
  private musicTone!: BiquadFilterNode;
  private sfxBus!: GainNode;
  private ambientBus!: GainNode;
  private reverbSend!: GainNode;
  private noise!: AudioBuffer;

  private glide!: Loop;
  private wind!: Loop;
  private storm!: Loop;
  private nightAir!: Loop;
  /** Phase 9B — leaf rustle for forest themes. */
  private leaves!: Loop;
  /** Phase 10B — leaf-litter crackle under the wheels (moonlit forest). */
  private crackle!: Loop;
  /**
   * Phase 10B — rare-challenge tension: two detuned saws a minor ninth
   * apart behind a dark lowpass, slowly breathing. Gain rests at 0.
   */
  private tension!: { gain: GainNode; oscA: OscillatorNode; oscB: OscillatorNode };

  private schedulerId = 0;
  private musicOn = false;
  private nextBar = 0;
  private bar = 0;
  private lastMelody = 4;
  private intensity = 0.6;
  private night = 0;
  private status: AudioFrameState['status'] = 'menu';
  /** Phase 10B — last observed theme/event, kept for interval-driven critters. */
  private theme: AudioFrameState['theme'] = 'countryside';
  private event: AudioFrameState['event'] = null;

  private lastUpdate = 0;
  private lastPlayed = new Map<string, number>();
  private coinStreak = 0;
  private lastCoin = 0;
  /** Phase 10B — global budget of live one-shot voices (perf requirement). */
  private voices = 0;
  private lastVocal = -100;
  private nextCritter = 0;
  private spinWhoosh: { gain: GainNode; filter: BiquadFilterNode } | null = null;

  constructor(private readonly android = false) {
    this.settings = { ...DEFAULTS };
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) this.settings = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      /* storage unavailable */
    }
  }

  get ready(): boolean {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Must be called from a user gesture (autoplay policy). Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor({ latencyHint: this.android ? 'playback' : 'interactive' });
      } catch {
        return;
      }
      this.build();
      this.startMusic(this.status === 'playing' ? 1 : 0.6, 3);
    }
    if (this.ctx.state === 'suspended' && !document.hidden) void this.ctx.resume();
  }

  suspend(): void {
    if (this.ctx && this.ctx.state === 'running') void this.ctx.suspend();
  }

  resumeContext(): void {
    if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Silences every game-owned source while a native full-screen ad is visible. */
  setAdSuspended(suspended: boolean): void {
    if (suspended) {
      this.stopSpinWhoosh();
      this.suspend();
    } else {
      this.resumeContext();
    }
  }

  studioIntro(): void {
    if (!this.ready || !this.throttle('studio-intro', 5)) return;
    const now = this.ctx!.currentTime;
    this.pianoSfx(mtof(38), now, 0.1, 4.5);
    [62, 69, 76].forEach((note, index) => this.bell(mtof(note), now + 0.12 + index * 0.14, 0.045, 2.4, 0.9));
    this.noiseHit({ t: now + 0.05, dur: 1.5, type: 'bandpass', f0: 500, f1: 2400, q: 0.7, gain: 0.035, attack: 0.45, wet: 1 });
  }

  reviveCue(): void {
    if (!this.ready) return;
    const now = this.ctx!.currentTime;
    [69, 76, 81, 86].forEach((note, index) => this.bell(mtof(note), now + index * 0.07, 0.055, 1.5, 0.8));
    this.startMusic(1, 1.2);
  }

  // ───────────────────────── graph ─────────────────────────
  private build(): void {
    const ctx = this.ctx!;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 12;
    comp.ratio.value = 3.5;
    comp.attack.value = 0.01;
    comp.release.value = 0.25;
    comp.connect(ctx.destination);

    this.master = ctx.createGain();
    this.master.gain.value = this.settings.muted ? 0 : 0.9;
    this.master.connect(comp);

    // Reverb – generated impulse, shared by music and effects
    const reverb = ctx.createConvolver();
    reverb.buffer = this.makeImpulse(this.android ? 0.55 : 3.2);
    const reverbOut = ctx.createGain();
    reverbOut.gain.value = 0.55;
    reverb.connect(reverbOut).connect(this.master);
    this.reverbSend = ctx.createGain();
    this.reverbSend.connect(reverb);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.settings.music;
    this.musicTone = ctx.createBiquadFilter();
    this.musicTone.type = 'lowpass';
    this.musicTone.frequency.value = 4200;
    this.musicFade = ctx.createGain();
    this.musicFade.gain.value = 0;
    this.musicTone.connect(this.musicFade).connect(this.musicBus).connect(this.master);

    this.sfxBus = ctx.createGain();
    this.sfxBus.gain.value = this.settings.sfx;
    this.sfxBus.connect(this.master);

    this.ambientBus = ctx.createGain();
    this.ambientBus.gain.value = this.settings.ambient;
    this.ambientBus.connect(this.master);

    // Shared 3 s noise buffer (pinkish) reused by every noise-based sound
    const len = ctx.sampleRate * 3;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    }

    this.glide = this.makeLoop('bandpass', 1400, 0.7, this.sfxBus);
    this.wind = this.makeLoop('lowpass', 420, 0.9, this.ambientBus);
    this.storm = this.makeLoop('bandpass', 700, 0.5, this.ambientBus);
    this.nightAir = this.makeLoop('lowpass', 260, 0.7, this.ambientBus);
    this.leaves = this.makeLoop('bandpass', 1650, 0.8, this.ambientBus);
    // Phase 10B — dry leaf litter under the wheels (bandpass centre 2.4 kHz).
    this.crackle = this.makeLoop('bandpass', 2400, 1.6, this.sfxBus);

    // Phase 10B — tension drone (rare-challenge events). D2 vs Eb2: a minor
    // ninth, filtered very dark and pulsed by a slow tremolo so it reads as
    // unease rather than a pitch. Rests silent until an event asks for it.
    {
      const tensionFilter = ctx.createBiquadFilter();
      tensionFilter.type = 'lowpass';
      tensionFilter.frequency.value = 260;
      tensionFilter.Q.value = 0.5;
      const tremolo = ctx.createGain();
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.35;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 0.35;
      lfo.connect(lfoGain).connect(tremolo.gain);
      tremolo.gain.value = 0.65;
      const tensionGain = ctx.createGain();
      tensionGain.gain.value = 0;
      // Routed through the music tone/fade chain so pause and crash ducking
      // apply to it exactly like the rest of the music.
      tensionFilter.connect(tremolo).connect(tensionGain).connect(this.musicTone);
      const oscA = ctx.createOscillator();
      oscA.type = 'sawtooth';
      oscA.frequency.value = 73.42; // D2
      const oscB = ctx.createOscillator();
      oscB.type = 'sawtooth';
      oscB.frequency.value = 77.78; // Eb2
      oscA.detune.value = -6;
      oscB.detune.value = 6;
      oscA.connect(tensionFilter);
      oscB.connect(tensionFilter);
      oscA.start();
      oscB.start();
      lfo.start();
      this.tension = { gain: tensionGain, oscA, oscB };
    }

    this.schedulerId = window.setInterval(() => this.schedule(), 90);
  }

  private makeImpulse(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const data = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2) * (i < 200 ? i / 200 : 1);
      }
    }
    return buf;
  }

  private makeLoop(type: BiquadFilterType, freq: number, q: number, dest: AudioNode): Loop {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(dest);
    src.start(0, Math.random() * 2.5);
    return { src, filter, gain };
  }

  // ───────────────────────── settings ─────────────────────────
  setVolume(bus: 'music' | 'sfx' | 'ambient', value: number): void {
    this.settings[bus] = clamp(value, 0, 1);
    this.save();
    if (!this.ctx) return;
    const node = bus === 'music' ? this.musicBus : bus === 'sfx' ? this.sfxBus : this.ambientBus;
    node.gain.setTargetAtTime(this.settings[bus], this.ctx.currentTime, 0.05);
  }

  setMuted(muted: boolean): void {
    this.settings.muted = muted;
    this.save();
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(muted ? 0 : 0.9, this.ctx.currentTime, 0.08);
  }

  private save(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings));
    } catch {
      /* ignore */
    }
  }

  // ───────────────────────── music ─────────────────────────
  private fadeMusic(target: number, seconds: number): void {
    if (!this.ctx) return;
    const g = this.musicFade.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(target, now + seconds);
  }

  private startMusic(intensity: number, fadeSeconds: number): void {
    if (!this.ctx) return;
    this.intensity = intensity;
    if (!this.musicOn) {
      this.musicOn = true;
      this.bar = 0;
      this.nextBar = this.ctx.currentTime + 0.15;
    }
    this.fadeMusic(1, fadeSeconds);
  }

  private stopMusic(fadeSeconds: number): void {
    this.fadeMusic(0, fadeSeconds);
    window.setTimeout(() => {
      if (this.ctx && this.musicFade.gain.value < 0.02) this.musicOn = false;
    }, fadeSeconds * 1000 + 100);
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    if (this.musicOn) {
      if (this.android && this.nextBar < ctx.currentTime - 0.2) {
        // A stalled WebView should resume with one fresh bar, not stack missed notes.
        this.nextBar = ctx.currentTime + 0.06;
      }
      while (this.nextBar < ctx.currentTime + 0.6) {
        const barLen = this.scheduleBar(this.nextBar);
        this.nextBar += barLen;
      }
    }
    this.critters(ctx.currentTime);
  }

  /** Schedules one bar of generative music and returns its duration. */
  private scheduleBar(t: number): number {
    const night = this.night;
    const bpm = lerp(74, 62, night);
    const beat = 60 / bpm;
    const barLen = beat * 4;
    const chord = CHORDS[Math.floor(this.bar / 2) % CHORDS.length];
    const firstOfChord = this.bar % 2 === 0;

    if (firstOfChord) {
      for (const n of (this.android ? chord.pad.slice(0, 3) : chord.pad)) this.padNote(mtof(n), t, barLen * 2 + 1.2, 0.022 * (0.7 + this.intensity * 0.3));
      this.piano(mtof(chord.bass + 12), t, 0.16, 4.5);
      if (!this.android && this.intensity > 0.8 && Math.floor(this.bar / 2) % 2 === 1) {
        this.strings(mtof(chord.pad[chord.pad.length - 1] + 12), t + beat * 0.5, barLen * 2, 0.018);
      }
      this.piano(mtof(chord.bass), t, 0.1, 5);
    }

    // Sparse, wandering pentatonic piano melody
    const density = lerp(0.62, 0.32, night) * (0.6 + this.intensity * 0.4);
    for (let b = 0; b < 4; b++) {
      if (Math.random() > density) continue;
      const step = Math.round((Math.random() - 0.5) * 3.2);
      this.lastMelody = clamp(this.lastMelody + step, night > 0.6 ? 0 : 2, night > 0.6 ? 7 : MELODY.length - 1);
      const when = t + b * beat + (Math.random() < 0.25 ? beat * 0.5 : 0);
      this.piano(mtof(MELODY[this.lastMelody]), when, 0.11 + Math.random() * 0.04, 3.2);
      if (Math.random() < 0.18) this.piano(mtof(MELODY[this.lastMelody] + 12), when + beat * 0.5, 0.05, 2.4);
    }

    this.bar += 1;
    return barLen;
  }

  private musicOut(dry: AudioNode, wet = 0.5): void {
    dry.connect(this.musicTone);
    if (wet > 0) {
      const s = this.ctx!.createGain();
      s.gain.value = wet;
      dry.connect(s).connect(this.reverbSend);
    }
  }

  private piano(freq: number, t: number, vel: number, decay: number): void {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(vel, t + 0.008);
    out.gain.exponentialRampToValueAtTime(vel * 0.35, t + 0.4);
    out.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(freq * 6, 5000), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(freq * 1.5, 300), t + decay);
    const partials: Array<[number, OscillatorType, number]> = [[1, 'sine', 1], [2, 'sine', 0.28], [3, 'triangle', 0.08]];
    for (const [mult, type, g] of partials) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq * mult;
      o.detune.value = (Math.random() - 0.5) * 4;
      const pg = ctx.createGain();
      pg.gain.value = g;
      o.connect(pg).connect(lp);
      o.start(t);
      o.stop(t + decay + 0.05);
    }
    lp.connect(out);
    this.musicOut(out, 0.6);
  }

  private padNote(freq: number, t: number, dur: number, vel: number): void {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 2.2);
    g.gain.setValueAtTime(vel, t + dur - 2);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = lerp(1100, 600, this.night);
    lp.Q.value = 0.4;
    for (const det of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = det;
      o.connect(lp);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
    lp.connect(g);
    this.musicOut(g, 0.7);
  }

  private strings(freq: number, t: number, dur: number, vel: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    const vib = ctx.createOscillator();
    vib.frequency.value = 5.2;
    const vibG = ctx.createGain();
    vibG.gain.value = freq * 0.004;
    vib.connect(vibG).connect(o.frequency);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + dur * 0.4);
    g.gain.linearRampToValueAtTime(0, t + dur);
    o.connect(lp).connect(g);
    this.musicOut(g, 0.8);
    o.start(t); vib.start(t);
    o.stop(t + dur + 0.05); vib.stop(t + dur + 0.05);
  }

  // ───────────────────────── continuous state ─────────────────────────
  update(s: AudioFrameState): void {
    this.status = s.status;
    // Phase 10B — theme and event are cached before any early return so the
    // interval-driven critters always see the freshest world state.
    this.theme = s.theme;
    this.event = s.event ?? null;
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (now - this.lastUpdate < (this.android ? 0.09 : 0.05)) return;
    this.lastUpdate = now;
    this.night = s.night;
    const tc = 0.12;
    const playing = s.status === 'playing';

    // Phase 10B — calm journeys soften the contact sound along with the music.
    const calm = this.event && this.event.id === 'calm-journey' ? this.event.intensity : 0;

    // Board on snow – brighter and louder with speed, silent in the air.
    // Phase 10B — the riding surface tints it: valley grass reads rounder
    // and a touch softer, mist muffles it, the forest floor is leafy rather
    // than icy.
    const surfaceTone = s.theme === 'countryside' ? 0.72 : s.theme === 'misty-mountains' ? 0.66 : s.theme === 'moonlit-forest' ? 0.85 : 1;
    const surfaceGain = s.theme === 'countryside' ? 0.85 : s.theme === 'misty-mountains' ? 0.9 : 1;
    const glideLevel = playing && s.moving && s.grounded
      ? (0.05 + s.speed * 0.11 + Math.max(0, s.slope) * 0.05) * surfaceGain * (1 - 0.25 * calm)
      : 0;
    this.glide.gain.gain.setTargetAtTime(glideLevel * (0.85 + Math.random() * 0.3), now, playing && !s.grounded ? 0.03 : tc);
    this.glide.filter.frequency.setTargetAtTime((900 + s.speed * 1900 + Math.random() * 250) * surfaceTone, now, tc);

    // Phase 10B — dry leaves crackling under the wheels, forest floor only,
    // never while airborne.
    const crackleLevel = playing && s.moving && s.grounded && s.theme === 'moonlit-forest' ? 0.012 + s.speed * 0.02 : 0;
    this.crackle.gain.gain.setTargetAtTime(crackleLevel, now, tc);

    // Wind – speed, air time, steep downhill and storms all push it up
    const airborne = playing && !s.grounded;
    // Phase 9B — the environment tints the wind loop: alpine air is colder
    // (higher filter), valley mist reads distant (lower level), the forest
    // adds a high leaf rustle that breathes with the gusts.
    const theme = s.theme ?? 'countryside';
    const windTone = theme === 'snowy-mountains' ? 1.35 : theme === 'misty-mountains' ? 0.72 : 1;
    const themeWind = theme === 'misty-mountains' ? -0.012 : theme === 'snowy-mountains' ? 0.014 : 0;
    // Phase 9D — special events shape the ambience gradually: storms and
    // forest gusts push the wind up, calm journeys and mist pull it back.
    const event = s.event ?? null;
    const eventWindGain = event
      ? (event.id === 'snowstorm' || event.id === 'forest-wind' ? 0.3 : event.id === 'calm-journey' || event.id === 'mist-surge' ? -0.25 : 0) * event.intensity
      : 0;
    const windLevel = playing
      ? 0.035 + s.speed * 0.07 + (airborne ? 0.07 : 0) + Math.max(0, s.slope) * 0.09 + s.storm * 0.08 + themeWind
      : 0.04 + s.storm * 0.06 + themeWind;
    this.wind.gain.gain.setTargetAtTime(Math.max(0.008, windLevel * (1 + eventWindGain * 2)), now, 0.35);
    this.wind.filter.frequency.setTargetAtTime((320 + s.speed * 520 + (airborne ? 500 : 0) + s.storm * 300) * windTone, now, 0.4);

    this.storm.gain.gain.setTargetAtTime(s.storm * 0.13, now, 0.8);
    this.storm.filter.frequency.setTargetAtTime(600 + Math.sin(now * 0.7) * 250, now, 0.5);
    this.nightAir.gain.gain.setTargetAtTime(s.night * 0.06, now, 1);

    // Phase 9B — quiet forest rustle for the wooded themes only.
    // Phase 10B — forest-wind events push the rustle up with their envelope.
    const eventRustle = event && event.id === 'forest-wind' ? 0.05 * event.intensity : 0;
    const rustle = (theme === 'moonlit-forest' ? 0.02 + s.wind * 0.032 : theme === 'misty-mountains' ? 0.008 + s.wind * 0.016 : 0) + eventRustle;
    this.leaves.gain.gain.setTargetAtTime(rustle, now, 0.9);
    this.leaves.filter.frequency.setTargetAtTime(1500 + s.wind * 900 + Math.sin(now * 0.5) * 180, now, 0.8);

    // Airy rotation whoosh while flipping
    if (s.spinning && !this.spinWhoosh) this.startSpinWhoosh();
    else if (!s.spinning && this.spinWhoosh) this.stopSpinWhoosh();

    this.musicTone.frequency.setTargetAtTime(lerp(4200, 1900, s.night) * (s.status === 'paused' ? 0.35 : 1)
      // Phase 9D — golden hour warms the ambient tone, calm journeys soften it.
      * (event ? (event.id === 'golden-hour' ? 1 + 0.07 * event.intensity : event.id === 'calm-journey' ? 1 - 0.05 * event.intensity : 1) : 1), now, 0.6);

    // Phase 10B — rare challenges introduce a very subtle musical tension:
    // the low drone breathes in with the event envelope and rests at zero
    // otherwise. Slow time constants keep the creep in/out gentle.
    const tension = playing && event && event.id === 'rare-challenge' ? 0.028 * event.intensity : 0;
    this.tension.gain.gain.setTargetAtTime(tension, now, 1.2);
  }

  private startSpinWhoosh(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.5;
    filter.frequency.value = 700;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 2.6; // ~matches rotation speed
    const lfoG = ctx.createGain();
    lfoG.gain.value = 450;
    lfo.connect(lfoG).connect(filter.frequency);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.09, ctx.currentTime, 0.08);
    src.connect(filter).connect(gain).connect(this.sfxBus);
    src.start(0, Math.random() * 2);
    lfo.start();
    this.spinWhoosh = { gain, filter };
    (gain as GainNode & { _stop?: () => void })._stop = () => {
      src.stop(ctx.currentTime + 0.4);
      lfo.stop(ctx.currentTime + 0.4);
    };
  }

  private stopSpinWhoosh(): void {
    if (!this.ctx || !this.spinWhoosh) return;
    const g = this.spinWhoosh.gain as GainNode & { _stop?: () => void };
    g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.08);
    g._stop?.();
    this.spinWhoosh = null;
  }

  /**
   * Sparse wildlife, themed by environment and time of day (Phase 10B):
   * Green Valley is lively by day; Misty Mountains and the forest are
   * sparser; Snowy Mountains stay quiet and spacious. Dusk stretches the
   * gaps. Night brings crickets to the valley and forest, an owl elsewhere.
   */
  private critters(now: number): void {
    if (this.status === 'paused') return;
    if (this.nextCritter === 0) {
      this.nextCritter = now + 6;
      return;
    }
    if (now < this.nextCritter) return;
    // Calm journeys let nature rest — fewer calls, softer world.
    const calm = this.event && this.event.id === 'calm-journey' ? this.event.intensity : 0;
    const dusk = this.night >= 0.35 && this.night <= 0.75;
    this.nextCritter = now + ((dusk ? 15 : 9) + Math.random() * 14) * (1 + calm * 1.6);
    if (calm > 0.5) return;
    const scale = 1 - calm * 0.5;
    if (this.night < 0.35) {
      const chance = this.theme === 'countryside' ? 1
        : this.theme === 'misty-mountains' ? 0.45
          : this.theme === 'moonlit-forest' ? 0.6
            : 0; // snowy mountains: quiet, spacious
      if (Math.random() < chance * scale) this.bird(now);
    } else if (this.night > 0.75) {
      if ((this.theme === 'countryside' || this.theme === 'moonlit-forest') && Math.random() < 0.75 * scale) this.cricket(now);
      else if (Math.random() < 0.5 * scale) this.owl(now);
    }
  }

  /** Phase 10B — a night cricket: tiny rapid chirp bursts, almost subliminal. */
  private cricket(t: number): void {
    const ctx = this.ctx!;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.4 - 0.7;
    const out = ctx.createGain();
    out.gain.value = 0.016;
    out.connect(pan).connect(this.ambientBus);
    const bursts = 3 + Math.floor(Math.random() * 3);
    const base = 4200 + Math.random() * 400;
    for (let i = 0; i < bursts; i++) {
      const burst = t + i * 0.34 + Math.random() * 0.05;
      for (let p = 0; p < 3; p++) {
        const s = burst + p * 0.055;
        const o = ctx.createOscillator();
        o.type = 'square';
        o.frequency.value = base;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = base;
        bp.Q.value = 9;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, s);
        g.gain.linearRampToValueAtTime(1, s + 0.012);
        g.gain.linearRampToValueAtTime(0, s + 0.042);
        o.connect(bp).connect(g).connect(out);
        o.start(s);
        o.stop(s + 0.05);
      }
    }
  }

  private bird(t: number): void {
    const ctx = this.ctx!;
    const chirps = 2 + Math.floor(Math.random() * 3);
    const base = 2600 + Math.random() * 1400;
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    const out = ctx.createGain();
    out.gain.value = 0.035;
    out.connect(pan).connect(this.ambientBus);
    const wet = ctx.createGain();
    wet.gain.value = 0.9;
    out.connect(wet).connect(this.reverbSend);
    for (let i = 0; i < chirps; i++) {
      const s = t + i * (0.11 + Math.random() * 0.06);
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(base * (1 + Math.random() * 0.1), s);
      o.frequency.exponentialRampToValueAtTime(base * 1.45, s + 0.04);
      o.frequency.exponentialRampToValueAtTime(base * 0.9, s + 0.08);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(1, s + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, s + 0.09);
      o.connect(g).connect(out);
      o.start(s);
      o.stop(s + 0.1);
    }
  }

  private owl(t: number): void {
    const ctx = this.ctx!;
    const out = ctx.createGain();
    out.gain.value = 0.05;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    out.connect(lp).connect(this.ambientBus);
    const wet = ctx.createGain();
    wet.gain.value = 1;
    out.connect(wet).connect(this.reverbSend);
    [0, 0.42, 0.62].forEach((off, i) => {
      const s = t + off;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(390, s);
      o.frequency.linearRampToValueAtTime(i === 0 ? 360 : 340, s + 0.3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, s);
      g.gain.linearRampToValueAtTime(1, s + 0.05);
      g.gain.exponentialRampToValueAtTime(0.001, s + (i === 0 ? 0.35 : 0.28));
      o.connect(g).connect(out);
      o.start(s);
      o.stop(s + 0.4);
    });
  }

  // ───────────────────────── one-shot helpers ─────────────────────────
  private throttle(key: string, gap: number): boolean {
    const now = this.ctx!.currentTime;
    const last = this.lastPlayed.get(key) ?? -10;
    if (now - last < gap) return false;
    this.lastPlayed.set(key, now);
    return true;
  }

  /**
   * Phase 10B — claims a slot in the live one-shot voice budget so dense
   * moments drop the quietest new sounds instead of stacking into clutter
   * (or into CPU spikes on weak devices). Slots release themselves.
   */
  private claim(seconds: number): boolean {
    if (this.voices >= 18) return false;
    this.voices += 1;
    window.setTimeout(() => { this.voices -= 1; }, (seconds + 0.1) * 1000);
    return true;
  }

  private noiseHit(o: {
    t?: number; dur: number; type: BiquadFilterType; f0: number; f1?: number; q?: number;
    gain: number; attack?: number; wet?: number; dest?: AudioNode;
  }): void {
    const ctx = this.ctx!;
    const t = o.t ?? ctx.currentTime;
    if (!this.claim(o.dur)) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = o.type;
    f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(o.f0, t);
    if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + o.dur);
    const g = ctx.createGain();
    const atk = o.attack ?? 0.005;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.gain, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f).connect(g).connect(o.dest ?? this.sfxBus);
    if (o.wet) {
      const w = ctx.createGain();
      w.gain.value = o.wet;
      g.connect(w).connect(this.reverbSend);
    }
    src.start(t, Math.random() * 2.4);
    src.stop(t + o.dur + 0.05);
  }

  private tone(o: {
    t?: number; freq: number; freqEnd?: number; type?: OscillatorType; dur: number;
    gain: number; attack?: number; wet?: number; dest?: AudioNode;
  }): void {
    const ctx = this.ctx!;
    const t = o.t ?? ctx.currentTime;
    if (!this.claim(o.dur)) return;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t + o.dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(o.gain, t + (o.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(g).connect(o.dest ?? this.sfxBus);
    if (o.wet) {
      const w = ctx.createGain();
      w.gain.value = o.wet;
      g.connect(w).connect(this.reverbSend);
    }
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  /** Glassy bell – used for coins and reward cues. */
  private bell(freq: number, t: number, gain: number, decay = 0.9, wet = 0.5): void {
    this.tone({ t, freq, dur: decay, gain, wet });
    this.tone({ t, freq: freq * 2.0, dur: decay * 0.5, gain: gain * 0.28, wet });
    this.tone({ t, freq: freq * 3.01, dur: decay * 0.25, gain: gain * 0.1 });
  }

  /** Small formant "voice" for the rider – soft, wordless, charming. */
  private vocal(kind: VoiceKind, delay = 0): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const shapes: Record<VoiceKind, { p: number[]; f1: number[]; f2: number[]; dur: number }> = {
      woo: { p: [300, 470, 420], f1: [320, 650, 700], f2: [800, 1100, 1150], dur: 0.45 },
      yeah: { p: [330, 400, 360], f1: [400, 720, 650], f2: [2000, 1700, 1300], dur: 0.38 },
      whoa: { p: [320, 380, 280], f1: [340, 720, 520], f2: [850, 1150, 900], dur: 0.5 },
      oof: { p: [240, 200, 170], f1: [480, 450, 400], f2: [900, 850, 800], dur: 0.2 },
      aah: { p: [360, 330, 230], f1: [720, 700, 620], f2: [1200, 1150, 1000], dur: 0.65 },
    };
    const s = shapes[kind];
    if (!this.claim(s.dur)) return;
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    const third = s.dur / 2;
    osc.frequency.setValueAtTime(s.p[0], t);
    osc.frequency.linearRampToValueAtTime(s.p[1], t + third * 0.8);
    osc.frequency.linearRampToValueAtTime(s.p[2], t + s.dur);
    const vib = ctx.createOscillator();
    vib.frequency.value = 6;
    const vibG = ctx.createGain();
    vibG.gain.value = 6;
    vib.connect(vibG).connect(osc.frequency);

    const out = ctx.createGain();
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.16, t + 0.04);
    out.gain.setValueAtTime(0.16, t + s.dur * 0.6);
    out.gain.linearRampToValueAtTime(0, t + s.dur);
    const soften = ctx.createBiquadFilter();
    soften.type = 'lowpass';
    soften.frequency.value = 2800;

    [s.f1, s.f2].forEach((f, i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = i === 0 ? 6 : 9;
      bp.frequency.setValueAtTime(f[0], t);
      bp.frequency.linearRampToValueAtTime(f[1], t + third);
      bp.frequency.linearRampToValueAtTime(f[2], t + s.dur);
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 1 : 0.5;
      osc.connect(bp).connect(g).connect(soften);
    });
    soften.connect(out).connect(this.sfxBus);
    const w = ctx.createGain();
    w.gain.value = 0.25;
    out.connect(w).connect(this.reverbSend);
    osc.start(t); vib.start(t);
    osc.stop(t + s.dur + 0.05); vib.stop(t + s.dur + 0.05);
  }

  /** Rate-limited voice so reactions stay special. */
  private react(kind: VoiceKind, chance: number, delay = 0, force = false): void {
    const now = this.ctx!.currentTime;
    if (!force && (now - this.lastVocal < 7 || Math.random() > chance)) return;
    this.lastVocal = now;
    this.vocal(kind, delay);
  }

  // ───────────────────────── gameplay events ─────────────────────────
  handle(e: SoundEvent): void {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    switch (e.type) {
      case 'jump':
        if (!this.throttle('jump', 0.08)) return;
        this.noiseHit({ dur: 0.32, type: 'bandpass', f0: 500, f1: 2600, q: 1.2, gain: 0.2, attack: 0.03 });
        this.noiseHit({ dur: 0.12, type: 'highpass', f0: 3500, gain: 0.05 }); // snow flick
        break;
      case 'ledge':
        this.noiseHit({ dur: 0.6, type: 'lowpass', f0: 1200, f1: 400, gain: 0.08, attack: 0.15 });
        break;
      case 'flipTick':
        if (!this.throttle('flip', 0.15)) return;
        this.noiseHit({ dur: 0.24, type: 'bandpass', f0: 1400, f1: 450, q: 2, gain: 0.08, attack: 0.06 });
        break;
      case 'land': {
        const f = e.force;
        this.noiseHit({ dur: 0.16 + f * 0.25, type: 'lowpass', f0: 900 + f * 600, f1: 180, gain: 0.18 + f * 0.3 });
        this.tone({ freq: 120, freqEnd: 45, dur: 0.18, gain: 0.12 + f * 0.25 });
        this.noiseHit({ t: now + 0.02, dur: 0.35, type: 'highpass', f0: 2800, gain: 0.04 + f * 0.04, attack: 0.03 });
        if (f > 0.8 && !e.clean) this.react('oof', 0.45, 0.04);
        break;
      }
      case 'trick': {
        const count = Math.min(2 + e.flips + Math.min(e.combo, 3) - 1, 6);
        const shift = Math.min(e.combo - 1, 3) * 2;
        const notes = [74, 78, 81, 86, 90, 93];
        for (let i = 0; i < count; i++) this.bell(mtof(notes[i] + shift), now + 0.03 + i * 0.065, 0.07, 1.2, 0.7);
        this.noiseHit({ dur: 0.7, type: 'highpass', f0: 6000, gain: 0.025, attack: 0.05, wet: 0.8 }); // sparkle
        if (e.flips >= 2 || e.combo >= 3) this.react(e.flips >= 3 ? 'whoa' : Math.random() < 0.5 ? 'woo' : 'yeah', 0.75, 0.12);
        else this.react('woo', 0.15, 0.12);
        break;
      }
      case 'coin': {
        if (!this.throttle('coin', 0.025)) return;
        this.coinStreak = now - this.lastCoin < 0.9 ? this.coinStreak + 1 : 0;
        this.lastCoin = now;
        const idx = Math.min(this.coinStreak, COIN_SCALE.length - 1);
        const freq = mtof(COIN_SCALE[idx]);
        const vol = 0.075 * (1 - Math.min(this.coinStreak, 8) * 0.03);
        this.bell(freq, now, vol, 0.7, 0.45);
        if (this.coinStreak >= 3) this.bell(freq * 1.5, now + 0.04, vol * 0.45, 0.6, 0.6);
        if (this.coinStreak >= 6) this.bell(freq * 2, now + 0.08, vol * 0.3, 0.8, 0.8);
        break;
      }
      case 'crash':
        this.crash(e.kind);
        break;
      case 'power':
        this.powerCue(e.kind, e.phase === 'start');
        break;
      case 'door':
        this.door(e.phase === 'open');
        break;
      case 'complete':
        this.levelComplete();
        break;
    }
  }

  /**
   * Phase 10B — power-up cues. Each activation is distinct (magnet shimmers
   * upward, the shield lands as a warm low chime, double points sparkle in
   * octaves); expiration is always a soft two-note settle so any power fading
   * reads the same gentle way.
   */
  private powerCue(kind: 'magnet' | 'shield' | 'double', onStart: boolean): void {
    if (!this.throttle(`power-${kind}`, 0.25)) return;
    const now = this.ctx!.currentTime;
    if (onStart) {
      if (kind === 'magnet') {
        this.noiseHit({ dur: 0.5, type: 'bandpass', f0: 500, f1: 3000, q: 1.4, gain: 0.045, attack: 0.06, wet: 0.5 });
        this.bell(mtof(81), now + 0.02, 0.05, 0.9, 0.7);
        this.bell(mtof(88), now + 0.14, 0.04, 1.1, 0.8);
      } else if (kind === 'shield') {
        this.tone({ freq: mtof(50), dur: 0.9, gain: 0.05, attack: 0.12, wet: 0.5 });
        this.bell(mtof(62), now + 0.05, 0.055, 1.6, 0.9);
        this.bell(mtof(69), now + 0.16, 0.035, 1.4, 0.8);
      } else {
        this.bell(mtof(81), now, 0.05, 0.8, 0.6);
        this.bell(mtof(93), now + 0.1, 0.045, 1.0, 0.7);
        this.noiseHit({ t: now + 0.05, dur: 0.5, type: 'highpass', f0: 6000, gain: 0.02, attack: 0.08, wet: 0.9 });
      }
    } else {
      // Expiration: a gentle descending settle, common to all powers.
      this.bell(mtof(76), now, 0.035, 0.8, 0.6);
      this.bell(mtof(69), now + 0.12, 0.03, 1.0, 0.7);
    }
  }

  /**
   * Phase 10B — safe-house door. Opening is a soft wooden creak (a slow
   * filtered saw with a latch click); closing is a low thump plus the latch.
   * Both stay very quiet — they are atmosphere, not events.
   */
  private door(open: boolean): void {
    if (!this.throttle('door', 0.4)) return;
    const ctx = this.ctx!;
    const now = ctx.currentTime;
    if (open) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(130, now);
      osc.frequency.linearRampToValueAtTime(175, now + 0.5);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 850;
      lp.Q.value = 2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(0.035, now + 0.1);
      g.gain.linearRampToValueAtTime(0, now + 0.55);
      osc.connect(lp).connect(g).connect(this.sfxBus);
      const wet = ctx.createGain();
      wet.gain.value = 0.5;
      g.connect(wet).connect(this.reverbSend);
      osc.start(now);
      osc.stop(now + 0.6);
      this.noiseHit({ t: now, dur: 0.05, type: 'highpass', f0: 2800, gain: 0.03 }); // latch
    } else {
      this.tone({ freq: 105, freqEnd: 62, dur: 0.22, gain: 0.07, wet: 0.35 });
      this.noiseHit({ t: now + 0.06, dur: 0.05, type: 'highpass', f0: 2400, gain: 0.04 }); // latch
      this.noiseHit({ t: now + 0.05, dur: 0.3, type: 'lowpass', f0: 700, f1: 200, gain: 0.03, attack: 0.02 });
    }
  }

  /**
   * Phase 10B — level completion: a short rising piano arpeggio over a warm
   * pad swell, with a touch of sparkle. Satisfying but gentle, and routed
   * through the SFX bus so it is heard even while the music rests.
   */
  private levelComplete(): void {
    if (!this.throttle('complete', 1.5)) return;
    const now = this.ctx!.currentTime;
    this.tone({ freq: mtof(50), dur: 1.6, gain: 0.04, attack: 0.25, wet: 0.4 });
    [62, 66, 69, 74].forEach((n, i) => this.pianoSfx(mtof(n), now + 0.05 + i * 0.1, 0.1 - i * 0.008, 2.6));
    this.pianoSfx(mtof(78), now + 0.48, 0.08, 3.2);
    this.noiseHit({ t: now + 0.35, dur: 1.1, type: 'highpass', f0: 6500, gain: 0.022, attack: 0.3, wet: 1 });
  }

  private tumble(t: number, bumps: number): void {
    for (let i = 0; i < bumps; i++) {
      const s = t + i * (0.13 + Math.random() * 0.08);
      const g = 0.22 * Math.pow(0.68, i);
      this.noiseHit({ t: s, dur: 0.18, type: 'lowpass', f0: 700, f1: 160, gain: g });
      this.tone({ t: s, freq: 95, freqEnd: 45, dur: 0.12, gain: g * 0.7 });
    }
    this.noiseHit({ t, dur: 1.1, type: 'bandpass', f0: 2200, f1: 600, q: 0.6, gain: 0.06, attack: 0.05 });
  }

  private crash(kind: 'rock' | 'tree' | 'landing' | 'fall'): void {
    const now = this.ctx!.currentTime;
    this.stopSpinWhoosh();
    if (kind === 'rock') {
      this.tone({ freq: 140, freqEnd: 40, dur: 0.3, gain: 0.4 });
      this.noiseHit({ dur: 0.06, type: 'bandpass', f0: 2400, q: 3, gain: 0.18 });
      this.tumble(now + 0.08, 4);
    } else if (kind === 'tree') {
      this.tone({ freq: 210, freqEnd: 120, type: 'triangle', dur: 0.14, gain: 0.25 });
      this.tone({ t: now + 0.05, freq: 160, freqEnd: 100, type: 'triangle', dur: 0.12, gain: 0.15 });
      this.noiseHit({ t: now + 0.05, dur: 0.9, type: 'lowpass', f0: 1800, f1: 400, gain: 0.12, attack: 0.08, wet: 0.4 }); // snow off branches
      this.tumble(now + 0.12, 3);
    } else if (kind === 'landing') {
      this.tumble(now, 5);
    } else {
      this.noiseHit({ dur: 1.0, type: 'bandpass', f0: 1600, f1: 300, q: 0.8, gain: 0.1, attack: 0.1 });
      this.noiseHit({ t: now + 0.7, dur: 0.35, type: 'lowpass', f0: 500, f1: 120, gain: 0.12 });
    }
    this.react(kind === 'fall' ? 'whoa' : 'aah', 1, 0.05, true);
  }

  // ───────────────────────── state transitions ─────────────────────────
  startRun(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.coinStreak = 0;
    this.lastVocal = now - 4;
    [69, 74, 78].forEach((n, i) => this.bell(mtof(n), now + i * 0.09, 0.055, 1.4, 0.8));
    this.noiseHit({ dur: 0.9, type: 'bandpass', f0: 400, f1: 1800, q: 0.8, gain: 0.06, attack: 0.4 });
    this.startMusic(1, 2.5);
  }

  pauseGame(): void {
    if (!this.ctx) return;
    this.stopSpinWhoosh();
    this.tone({ freq: 660, freqEnd: 440, dur: 0.16, gain: 0.06, wet: 0.4 });
    this.fadeMusic(0.35, 0.5);
  }

  resumeGame(): void {
    if (!this.ctx) return;
    this.tone({ freq: 440, freqEnd: 660, dur: 0.16, gain: 0.06, wet: 0.4 });
    this.fadeMusic(1, 0.8);
  }

  crashCue(): void {
    if (!this.ctx) return;
    this.stopMusic(1.6);
    const t = this.ctx.currentTime + 1.1;
    // Soft, wistful motif that resolves upward – an invitation to try again
    const motif: Array<[number, number]> = [[78, 0], [76, 0.45], [71, 0.9], [74, 1.5]];
    motif.forEach(([n, off]) => this.pianoSfx(mtof(n), t + off, 0.13, 3.2));
    this.pianoSfx(mtof(47), t, 0.09, 4.5);
    this.pianoSfx(mtof(43), t + 1.5, 0.09, 4.5);
  }

  gameOver(newRecord: boolean): void {
    this.crashCue();
    if (newRecord) window.setTimeout(() => this.highScore(), 2700);
  }

  recordCue(): void {
    window.setTimeout(() => this.highScore(), 2400);
  }

  /** Piano routed through the SFX bus so it survives the music fade-out. */
  private pianoSfx(freq: number, t: number, vel: number, decay: number): void {
    const ctx = this.ctx!;
    if (!this.claim(decay)) return;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    for (const [m, a] of [[1, 1], [2, 0.25], [3, 0.06]]) {
      const o = ctx.createOscillator();
      o.frequency.value = freq * m;
      const pg = ctx.createGain();
      pg.gain.value = a;
      o.connect(pg).connect(g);
      o.start(t);
      o.stop(t + decay + 0.05);
    }
    g.connect(this.sfxBus);
    const w = ctx.createGain();
    w.gain.value = 0.7;
    g.connect(w).connect(this.reverbSend);
  }

  menuMusic(): void {
    if (this.ctx) this.startMusic(0.6, 2);
  }

  startMusicResume(): void {
    if (this.ctx) this.startMusic(1, 1.1);
  }

  // ───────────────────────── interface cues ─────────────────────────
  click(): void {
    if (!this.ready || !this.throttle('click', 0.04)) return;
    this.tone({ freq: 1250, freqEnd: 900, dur: 0.07, gain: 0.09 });
  }

  toggleCue(on: boolean): void {
    if (!this.ready) return;
    this.tone({ freq: on ? 700 : 520, freqEnd: on ? 1040 : 380, dur: 0.12, gain: 0.05, wet: 0.3 });
  }

  highScore(): void {
    if (!this.ready || !this.throttle('record', 3)) return;
    const now = this.ctx!.currentTime;
    [62, 66, 69, 74, 78, 81, 86].forEach((n, i) => this.bell(mtof(n), now + i * 0.08, 0.06, 1.6, 0.8));
    this.pianoSfx(mtof(50), now, 0.1, 3);
    this.pianoSfx(mtof(57), now + 0.56, 0.08, 3);
    this.noiseHit({ t: now + 0.4, dur: 1.4, type: 'highpass', f0: 7000, gain: 0.03, attack: 0.3, wet: 1 });
  }

  achievement(): void {
    if (!this.ready || !this.throttle('achv', 1.5)) return;
    const now = this.ctx!.currentTime;
    [[69, 0], [74, 0.1], [78, 0.2], [81, 0.34]].forEach(([n, o]) => this.bell(mtof(n), now + o, 0.06, o > 0.3 ? 1.5 : 0.8, 0.7));
  }

  destroy(): void {
    window.clearInterval(this.schedulerId);
    void this.ctx?.close();
    this.ctx = null;
  }
}

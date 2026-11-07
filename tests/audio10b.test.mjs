/**
 * Phase 10B — cinematic sound design & adaptive audio verification.
 *
 * Method (kept honest): every assertion runs against a mock Web Audio graph
 * that implements the real param/scheduling API surface (setValueAtTime,
 * setTargetAtTime, start/stop, connect). Tests verify *behaviour*: which
 * nodes start, what gain targets are set, what persists, and that nothing
 * duplicates or leaks. No assertion here judges subjective audio quality —
 * human listening remains part of manual review.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './loadTypeScript.mjs';
import { rasterCanvas } from './raster.mjs';

const { LEVEL_SAVE_KEY } = await import(moduleUrl('src/game/levelManager.ts'));
const { AudioManager } = await import(moduleUrl('src/game/audio.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

const SETTINGS_KEY = 'afterglow-audio-v1';

// ── fake clock + mock Web Audio ─────────────────────────────────────────

class Clock {
  constructor() {
    this.time = 0;
    this.timers = [];
    this.intervals = [];
    this.nextId = 1;
  }

  setTimeout(fn, ms) {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ id, fn, at: this.time + (ms ?? 0) });
    return id;
  }

  clearTimeout(id) {
    this.timers = this.timers.filter((t) => t.id !== id);
  }

  setInterval(fn, ms) {
    const id = this.nextId;
    this.nextId += 1;
    this.intervals.push({ id, fn, ms, next: this.time + (ms ?? 0) });
    return id;
  }

  clearInterval(id) {
    this.intervals = this.intervals.filter((i) => i.id !== id);
  }

  advance(ms) {
    this.time += ms;
    for (const timer of [...this.timers]) {
      if (timer.at <= this.time) {
        this.timers.splice(this.timers.indexOf(timer), 1);
        timer.fn();
      }
    }
    for (const interval of this.intervals) {
      while (interval.next <= this.time) {
        interval.next += interval.ms;
        interval.fn();
      }
    }
  }

  flush() {
    this.advance(1e7);
  }
}

class Param {
  constructor(value = 0) {
    this.value = value;
    this.targets = [];
  }

  setValueAtTime(v) { this.value = v; this.targets.push({ v }); }
  linearRampToValueAtTime(v) { this.value = v; this.targets.push({ v }); }
  exponentialRampToValueAtTime(v) { this.value = v; this.targets.push({ v }); }
  setTargetAtTime(v) { this.value = v; this.targets.push({ v }); }
  cancelScheduledValues() {}
}

class MockNode {
  constructor(ctx, kind) {
    this.ctx = ctx;
    this.kind = kind;
    this.connections = [];
  }

  connect(node) {
    this.connections.push(node);
    this.ctx.wires.push([this.kind, node.kind]);
    return node;
  }

  disconnect() {}
}

class MockAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 0;
    this.sampleRate = 44100;
    this.nodes = [];
    this.wires = [];
    this.starts = [];
    this.suspends = 0;
    this.resumes = 0;
    this.destination = new MockNode(this, 'destination');
    MockAudioContext.instances.push(this);
  }

  track(node) { this.nodes.push(node); return node; }

  createGain() { return this.track(Object.assign(new MockNode(this, 'gain'), { gain: new Param(1) })); }
  createBiquadFilter() {
    return this.track(Object.assign(new MockNode(this, 'filter'), {
      type: 'lowpass', frequency: new Param(350), Q: new Param(1),
    }));
  }
  createOscillator() {
    return this.track(Object.assign(new MockNode(this, 'osc'), {
      type: 'sine', frequency: new Param(440), detune: new Param(0),
      start(t) { this.ctx.starts.push(this); this.startedAt = t ?? this.ctx.currentTime; },
      stop() {},
    }));
  }
  createBufferSource() {
    return this.track(Object.assign(new MockNode(this, 'source'), {
      buffer: null, loop: false,
      start(t) { this.ctx.starts.push(this); this.startedAt = t ?? this.ctx.currentTime; },
      stop() {},
    }));
  }
  createStereoPanner() { return this.track(Object.assign(new MockNode(this, 'panner'), { pan: new Param(0) })); }
  createConvolver() { return this.track(Object.assign(new MockNode(this, 'convolver'), { buffer: null })); }
  createDynamicsCompressor() {
    return this.track(Object.assign(new MockNode(this, 'compressor'), {
      threshold: new Param(-24), knee: new Param(30), ratio: new Param(12),
      attack: new Param(0.003), release: new Param(0.25),
    }));
  }
  createBuffer(channels, length) {
    return { numberOfChannels: channels, length, getChannelData: () => new Float32Array(length) };
  }

  resume() { this.resumes += 1; this.state = 'running'; return Promise.resolve(); }
  suspend() { this.suspends += 1; this.state = 'suspended'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
MockAudioContext.instances = [];

function storage(values = new Map()) {
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

function setupAudio({ settings } = {}) {
  MockAudioContext.instances = [];
  const clock = new Clock();
  const store = storage();
  if (settings) store.setItem(SETTINGS_KEY, JSON.stringify(settings));
  globalThis.localStorage = store;
  globalThis.document = { hidden: false };
  globalThis.window = {
    AudioContext: MockAudioContext,
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearInterval: (id) => clock.clearInterval(id),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
  };
  const audio = new AudioManager(false);
  return { audio, clock, store };
}

function frameState(patch = {}) {
  return {
    status: 'playing', speed: 0.5, moving: true, grounded: true, spinning: false,
    slope: 0, night: 0, storm: 0, theme: 'countryside', wind: 0.2, event: null,
    ...patch,
  };
}

/** Started oscillators, optionally filtered by type. */
const startedOsc = (ctx, type = null) =>
  ctx.starts.filter((n) => n.kind === 'osc' && (type === null || n.type === type));

// ── graph, unlock, settings ─────────────────────────────────────────────

test('unlock builds the graph exactly once (no duplicate engines)', () => {
  const { audio, clock } = setupAudio();
  audio.unlock();
  audio.unlock();
  audio.unlock();
  assert.equal(MockAudioContext.instances.length, 1, 'one AudioContext');
  const ctx = MockAudioContext.instances[0];
  assert.equal(ctx.state, 'running');
  assert.equal(clock.intervals.length, 1, 'one music scheduler interval');
  // Six ambience loops (glide, wind, storm, nightAir, leaves, crackle) + the
  // tension drone's two saws and tremolo lfo.
  const sources = ctx.nodes.filter((n) => n.kind === 'source' && n.loop);
  assert.equal(sources.length, 6, 'six looping noise sources');
  const oscs = ctx.nodes.filter((n) => n.kind === 'osc');
  assert.ok(oscs.length >= 3, 'tension drone oscillators exist');
  const tensionSaws = oscs.filter((o) => o.type === 'sawtooth' && o.frequency.value < 100);
  assert.equal(tensionSaws.length, 2, 'two low tension saws (D2/Eb2)');
});

test('saved settings load, apply to bus gains and persist on change', () => {
  const { audio } = setupAudio({ settings: { music: 0.2, sfx: 0.5, ambient: 0.9, muted: true } });
  assert.deepEqual(audio.settings, { music: 0.2, sfx: 0.5, ambient: 0.9, muted: true });
  audio.unlock();
  const ctx = MockAudioContext.instances[0];
  // Bus gains come from the persisted settings.
  assert.equal(audio.musicBus.gain.value, 0.2);
  assert.equal(audio.sfxBus.gain.value, 0.5);
  assert.equal(audio.ambientBus.gain.value, 0.9);
  // Muted zeroes the master, not the categories.
  assert.equal(audio.master.gain.value, 0);
  audio.setMuted(false);
  assert.equal(audio.master.gain.value, 0.9);
  audio.setVolume('ambient', 0.1);
  assert.equal(audio.ambientBus.gain.value, 0.1);
  audio.setVolume('music', 0.8);
  audio.setVolume('sfx', 0.3);
  assert.equal(audio.musicBus.gain.value, 0.8);
  assert.equal(audio.sfxBus.gain.value, 0.3);
  const saved = JSON.parse(globalThis.localStorage.getItem(SETTINGS_KEY));
  assert.deepEqual(saved, { music: 0.8, sfx: 0.3, ambient: 0.1, muted: false });
});

test('defaults apply when no settings are saved', () => {
  const { audio } = setupAudio();
  assert.deepEqual(audio.settings, { music: 0.7, sfx: 0.8, ambient: 0.7, muted: false });
  audio.unlock();
  assert.equal(audio.master.gain.value, 0.9);
});

// ── new Phase 10B one-shots ─────────────────────────────────────────────

test('power activation and expiration cues schedule distinct, throttled sounds', () => {
  const { audio, clock } = setupAudio();
  audio.unlock();
  // Lets the mock clock release voice-budget slots between segments.
  const breathe = () => clock.advance(2500);
  const ctx = MockAudioContext.instances[0];
  audio.musicOn = false;
  const oscFreqsFrom = (mark) => ctx.starts.slice(mark)
    .filter((n) => n.kind === 'osc')
    .map((n) => n.frequency.value);
  const has = (freqs, hz, tol = 2) => freqs.some((f) => Math.abs(f - hz) <= tol);
  ctx.currentTime = 10;
  let mark = ctx.starts.length;
  audio.handle({ type: 'power', kind: 'magnet', phase: 'start' });
  const magnetFreqs = oscFreqsFrom(mark);
  assert.ok(magnetFreqs.length > 0, 'magnet start schedules voices');
  // Same-kind repeat inside the throttle window adds nothing.
  audio.handle({ type: 'power', kind: 'magnet', phase: 'start' });
  assert.equal(ctx.starts.length - mark, 7, 'repeat throttled');
  breathe();
  ctx.currentTime = 11;
  mark = ctx.starts.length;
  audio.handle({ type: 'power', kind: 'shield', phase: 'start' });
  const shieldFreqs = oscFreqsFrom(mark);
  assert.ok(shieldFreqs.length > 0, 'shield start schedules voices');
  breathe();
  ctx.currentTime = 12;
  mark = ctx.starts.length;
  audio.handle({ type: 'power', kind: 'magnet', phase: 'start' }); // fresh budget
  const magnetAgain = ctx.starts.length;
  audio.handle({ type: 'power', kind: 'double', phase: 'start' });
  const doubleFreqs = ctx.starts.slice(magnetAgain)
    .filter((n) => n.kind === 'osc')
    .map((n) => n.frequency.value);
  assert.ok(doubleFreqs.length > 0, 'double start schedules voices');
  // The three kinds are voiced differently.
  assert.ok(has(shieldFreqs, 146.83), 'shield lands on a warm low pad');
  assert.ok(has(magnetFreqs, 1318.5) && !has(doubleFreqs, 1318.5), 'magnet-only shimmer bell');
  const key = (freqs) => freqs.slice().sort((a, b) => a - b).map((f) => f.toFixed(1)).join(',');
  assert.notEqual(key(magnetFreqs), key(doubleFreqs), 'magnet and double are voiced differently');
  assert.notEqual(key(shieldFreqs), key(magnetFreqs), 'shield and magnet are voiced differently');
  breathe();
  ctx.currentTime = 13;
  mark = ctx.starts.length;
  audio.handle({ type: 'power', kind: 'magnet', phase: 'end' });
  audio.handle({ type: 'power', kind: 'double', phase: 'end' });
  assert.ok(ctx.starts.length > mark, 'expiration cues schedule voices');
});

test('door open/close cues schedule a creak, a thump and latch clicks', () => {
  const { audio } = setupAudio();
  audio.unlock();
  const ctx = MockAudioContext.instances[0];
  ctx.currentTime = 10;
  audio.handle({ type: 'door', phase: 'open' });
  const saws = startedOsc(ctx, 'sawtooth');
  assert.ok(saws.some((o) => o.frequency.value >= 120 && o.frequency.value <= 180), 'creak saw 130→175Hz');
  const sourcesAfterOpen = ctx.starts.filter((n) => n.kind === 'source').length;
  assert.ok(sourcesAfterOpen > 0, 'latch click (noise) scheduled');
  ctx.currentTime = 11;
  audio.handle({ type: 'door', phase: 'close' });
  const sines = startedOsc(ctx, 'sine');
  assert.ok(sines.some((o) => o.frequency.value >= 55 && o.frequency.value <= 110), 'close thump 105→62Hz');
});

test('level completion schedules a rising piano phrase with sparkle', () => {
  const { audio } = setupAudio();
  audio.unlock();
  const ctx = MockAudioContext.instances[0];
  audio.musicOn = false;
  ctx.currentTime = 10;
  audio.handle({ type: 'complete' });
  const pianoNotes = [293.66, 369.99, 440, 587.33, 739.99]; // D4 F#4 A4 D5 F#5
  const oscFreqs = startedOsc(ctx).map((o) => o.frequency.value);
  for (const note of pianoNotes) {
    assert.ok(oscFreqs.some((f) => Math.abs(f - note) < 2), `piano partial ~${note.toFixed(0)}Hz`);
  }
  assert.ok(ctx.starts.some((n) => n.kind === 'source'), 'sparkle noise scheduled');
  // Throttled: an immediate repeat adds nothing.
  const count = ctx.starts.length;
  audio.handle({ type: 'complete' });
  assert.equal(ctx.starts.length, count, 'completion cue throttled');
});

// ── adaptive ambience (update) ───────────────────────────────────────────

test('glide responds to speed, ground contact and terrain surface', () => {
  const { audio } = setupAudio();
  audio.unlock();
  const ctx = MockAudioContext.instances[0];
  const withRandom = (fn) => {
    const original = Math.random;
    Math.random = () => 0.5;
    try { fn(); } finally { Math.random = original; }
  };
  withRandom(() => {
    ctx.currentTime = 1; audio.update(frameState({ theme: 'snowy-mountains', speed: 0.6, grounded: true, moving: true }));
    const snowGlide = audio.glide.gain.gain.targets.at(-1).v;
    const snowFilter = audio.glide.filter.frequency.targets.at(-1).v;
    ctx.currentTime = 1.2; audio.update(frameState({ theme: 'snowy-mountains', speed: 0.6, grounded: false, moving: true }));
    const airGlide = audio.glide.gain.gain.targets.at(-1).v;
    assert.ok(snowGlide > 0.08, `grounded glide audible (${snowGlide.toFixed(3)})`);
    assert.equal(airGlide, 0, 'no ground-contact audio while airborne');
    ctx.currentTime = 1.4; audio.update(frameState({ theme: 'countryside', speed: 0.6, grounded: true, moving: true }));
    const grassGlide = audio.glide.gain.gain.targets.at(-1).v;
    const grassFilter = audio.glide.filter.frequency.targets.at(-1).v;
    assert.ok(grassFilter < snowFilter * 0.8, 'valley grass reads darker than snow');
    assert.ok(grassGlide < snowGlide, 'grass is slightly softer than snow');
  });
});

test('leaf-litter crackle plays only on the forest floor, grounded', () => {
  const { audio } = setupAudio();
  audio.unlock();
  const ctx = MockAudioContext.instances[0];
  ctx.currentTime = 1; audio.update(frameState({ theme: 'moonlit-forest', speed: 0.5, grounded: true, moving: true }));
  assert.ok(audio.crackle.gain.gain.targets.at(-1).v > 0.01, 'forest floor crackles');
  ctx.currentTime = 1.2; audio.update(frameState({ theme: 'moonlit-forest', speed: 0.5, grounded: false, moving: true }));
  assert.equal(audio.crackle.gain.gain.targets.at(-1).v, 0, 'no crackle airborne');
  ctx.currentTime = 1.4; audio.update(frameState({ theme: 'countryside', speed: 0.5, grounded: true, moving: true }));
  assert.equal(audio.crackle.gain.gain.targets.at(-1).v, 0, 'no crackle in the valley');
});

test('special events shape the ambience smoothly', () => {
  const { audio } = setupAudio();
  audio.unlock();
  const ctx = MockAudioContext.instances[0];
  const last = (param) => param.targets.at(-1).v;
  // Pin the per-update jitter so gain comparisons are exact.
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  // Snowstorm pushes the wind up.
  ctx.currentTime = 1; audio.update(frameState({ theme: 'snowy-mountains', storm: 0 }));
  const calmWind = last(audio.wind.gain.gain);
  ctx.currentTime = 1.2; audio.update(frameState({ theme: 'snowy-mountains', storm: 0, event: { id: 'snowstorm', intensity: 1 } }));
  const stormWind = last(audio.wind.gain.gain);
  assert.ok(stormWind > calmWind * 1.4, `snowstorm wind up (${calmWind.toFixed(3)} → ${stormWind.toFixed(3)})`);
  // Forest-wind pushes the leaf rustle up.
  ctx.currentTime = 1.4; audio.update(frameState({ theme: 'moonlit-forest', wind: 0.2 }));
  const baseRustle = last(audio.leaves.gain.gain);
  ctx.currentTime = 1.6; audio.update(frameState({ theme: 'moonlit-forest', wind: 0.2, event: { id: 'forest-wind', intensity: 1 } }));
  const gustRustle = last(audio.leaves.gain.gain);
  assert.ok(gustRustle > baseRustle * 2, `forest-wind rustle up (${baseRustle.toFixed(3)} → ${gustRustle.toFixed(3)})`);
  // Calm journey softens the contact glide.
  ctx.currentTime = 1.8;
  audio.update(frameState({ theme: 'countryside', speed: 0.6 }));
  const normalGlide = last(audio.glide.gain.gain);
  ctx.currentTime = 2; audio.update(frameState({ theme: 'countryside', speed: 0.6, event: { id: 'calm-journey', intensity: 1 } }));
  const calmGlide = last(audio.glide.gain.gain);
  assert.ok(calmGlide < normalGlide * 0.85, `calm journey softens glide (${normalGlide.toFixed(3)} → ${calmGlide.toFixed(3)})`);
  // Rare challenge introduces subtle musical tension; everything else rests.
  ctx.currentTime = 2.2; audio.update(frameState({ event: { id: 'rare-challenge', intensity: 1 } }));
  assert.ok(last(audio.tension.gain.gain) > 0.02, 'tension drone fades in');
  ctx.currentTime = 2.4; audio.update(frameState({ event: { id: 'golden-hour', intensity: 1 } }));
  assert.equal(last(audio.tension.gain.gain), 0, 'tension rests outside rare challenges');
  Math.random = originalRandom;
});

// ── themed wildlife (schedule/critters) ─────────────────────────────────

function critterFixture({ theme, night, event = null }) {
  const { audio } = setupAudio();
  audio.unlock();
  const ctx = MockAudioContext.instances[0];
  audio.status = 'playing';
  audio.musicOn = false;
  audio.theme = theme;
  audio.night = night;
  audio.event = event;
  audio.nextCritter = 0;
  ctx.currentTime = 10;
  audio.schedule(); // arms the first gap
  ctx.currentTime = 40; // past any gap
  const before = ctx.starts.length;
  audio.schedule(); // fires the critter decision
  return { audio, ctx, fresh: () => ctx.starts.slice(before) };
}

test('daytime wildlife is themed: valley birds, snowy silence', () => {
  const withRandom = (fn) => {
    const original = Math.random;
    Math.random = () => 0;
    try { fn(); } finally { Math.random = original; }
  };
  let valley; let snowy; let misty;
  withRandom(() => {
    valley = critterFixture({ theme: 'countryside', night: 0.1 });
    snowy = critterFixture({ theme: 'snowy-mountains', night: 0.1 });
    misty = critterFixture({ theme: 'misty-mountains', night: 0.1 });
  });
  const bird = (list) => list.fresh().some((n) => n.kind === 'osc' && n.type === 'sine' && n.frequency.value > 2000);
  assert.ok(bird(valley), 'Green Valley: birds by day');
  assert.ok(!bird(snowy), 'Snowy Mountains: quiet and spacious by day');
  assert.ok(bird(misty), 'Misty Mountains: sparse birds can appear by day');
  // The sparse chance gate (45%) also lets misty fall silent on an unlucky
  // roll — the valley never does.
  const original = Math.random;
  Math.random = () => 0.99;
  let mistySilent;
  try { mistySilent = critterFixture({ theme: 'misty-mountains', night: 0.1 }); } finally { Math.random = original; }
  assert.ok(!bird(mistySilent), 'Misty Mountains: wildlife can be absent (sparse)');
});

test('night brings crickets to valley and forest, an owl to the mountains', () => {
  const withRandom = (fn) => {
    const original = Math.random;
    Math.random = () => 0;
    try { fn(); } finally { Math.random = original; }
  };
  let valley; let forest; let snowy;
  withRandom(() => {
    valley = critterFixture({ theme: 'countryside', night: 0.9 });
    forest = critterFixture({ theme: 'moonlit-forest', night: 0.9 });
    snowy = critterFixture({ theme: 'snowy-mountains', night: 0.9 });
  });
  const cricket = (list) => list.fresh().some((n) => n.kind === 'osc' && n.type === 'square' && n.frequency.value > 3900);
  const owl = (list) => list.fresh().some((n) => n.kind === 'osc' && n.type === 'sine' && n.frequency.value >= 330 && n.frequency.value <= 400);
  assert.ok(cricket(valley), 'Green Valley: crickets at night');
  assert.ok(cricket(forest), 'Moonlit Forest: crickets at night');
  assert.ok(!cricket(snowy), 'no crickets in the snow');
  assert.ok(owl(snowy), 'Snowy Mountains: distant owl instead');
});

test('calm journeys let nature rest', () => {
  const withRandom = (fn) => {
    const original = Math.random;
    Math.random = () => 0;
    try { fn(); } finally { Math.random = original; }
  };
  let calm;
  withRandom(() => {
    calm = critterFixture({ theme: 'countryside', night: 0.1, event: { id: 'calm-journey', intensity: 1 } });
  });
  assert.equal(calm.fresh().length, 0, 'no critters during a calm journey');
});

// ── budget, ads, pause/resume ────────────────────────────────────────────

test('voice budget bounds dense moments and releases slots over time', () => {
  const { audio, clock } = setupAudio();
  audio.unlock();
  const ctx = MockAudioContext.instances[0];
  audio.musicOn = false;
  ctx.currentTime = 100;
  const before = ctx.starts.length;
  for (let i = 0; i < 40; i += 1) audio.handle({ type: 'land', force: 0.5, clean: true });
  const burst = ctx.starts.length - before;
  assert.ok(burst <= 22, `one-shots capped under load (${burst} started)`);
  // Slots release as the (mock) clock runs; sound returns.
  clock.flush();
  ctx.currentTime = 200;
  const afterFlush = ctx.starts.length;
  audio.handle({ type: 'land', force: 0.5, clean: true });
  assert.ok(ctx.starts.length > afterFlush, 'voices available again after release');
});

test('ad suspension silences and restores without duplicating audio', () => {
  const { audio } = setupAudio();
  audio.unlock();
  const ctx = MockAudioContext.instances[0];
  const loopsBefore = ctx.nodes.filter((n) => n.kind === 'source' && n.loop).length;
  audio.setAdSuspended(true);
  assert.equal(ctx.state, 'suspended');
  assert.equal(ctx.suspends, 1);
  // Events during the ad are dropped, not queued.
  ctx.currentTime = 5;
  audio.handle({ type: 'coin' });
  audio.setAdSuspended(false);
  assert.equal(ctx.state, 'running');
  assert.equal(ctx.resumes, 1);
  const loopsAfter = ctx.nodes.filter((n) => n.kind === 'source' && n.loop).length;
  assert.equal(loopsAfter, loopsBefore, 'no duplicated loops');
  assert.equal(MockAudioContext.instances.length, 1, 'still one context');
});

test('pause ducks the music, resume restores it', () => {
  const { audio } = setupAudio();
  audio.unlock();
  const ctx = MockAudioContext.instances[0];
  audio.startRun();
  const last = (param) => param.targets.at(-1).v;
  audio.pauseGame();
  assert.ok(Math.abs(last(audio.musicFade.gain) - 0.35) < 0.001, 'music ducked to 0.35');
  audio.resumeGame();
  assert.equal(last(audio.musicFade.gain), 1, 'music restored');
});

test('long sessions stay stable: no node growth without events', async () => {
  const { audio, clock } = setupAudio();
  audio.unlock();
  const ctx = MockAudioContext.instances[0];
  audio.musicOn = false;
  audio.nextCritter = 1e9; // keep wildlife out of this measurement
  for (let i = 0; i < 500; i += 1) {
    ctx.currentTime += 0.1;
    audio.update(frameState({ theme: i % 2 ? 'moonlit-forest' : 'snowy-mountains', night: i % 2 ? 0.9 : 0.1, speed: (i % 10) / 10 }));
    clock.advance(100);
  }
  const nodes = ctx.nodes.length;
  const wires = ctx.wires.length;
  for (let i = 0; i < 500; i += 1) {
    ctx.currentTime += 0.1;
    audio.update(frameState({ theme: 'countryside', night: 0.5, speed: 0.4 }));
    clock.advance(100);
  }
  assert.equal(ctx.nodes.length, nodes, 'no node growth across 1000 updates');
  assert.equal(ctx.wires.length, wires, 'no connection growth');
});

// ── engine integration: the new events actually fire ────────────────────

function seedSave(journeySeed, currentLevel) {
  const store = storage();
  store.setItem(LEVEL_SAVE_KEY, JSON.stringify({
    version: 1, journeySeed, currentLevel, unlockedThrough: currentLevel,
    completedThrough: currentLevel - 1, levelScore: 0, runScore: 0,
    lifetimeScore: 0, checkpoint: null,
  }));
  return store;
}

function fastContext() {
  const gradient = { addColorStop() {} };
  const noop = () => {};
  return {
    canvas: null, fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1,
    lineCap: '', lineJoin: '', font: '', textAlign: '', textBaseline: '',
    shadowColor: '', shadowBlur: 0, setTransform: noop, clearRect: noop, fillRect: noop,
    strokeRect: noop, createLinearGradient: () => gradient, createRadialGradient: () => gradient,
    save: noop, restore: noop, translate: noop, rotate: noop, scale: noop, beginPath: noop,
    closePath: noop, moveTo: noop, lineTo: noop, quadraticCurveTo: noop, bezierCurveTo: noop,
    arc: noop, ellipse: noop, fill: noop, stroke: noop, fillText: noop, strokeText: noop,
    drawImage: noop,
  };
}

function makeGame(save, sounds) {
  globalThis.localStorage = save;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {}, location: { search: '' }, devicePixelRatio: 1,
  };
  globalThis.document = { createElement: () => rasterCanvas(192, 192) };
  const view = rasterCanvas(480, 270);
  const game = new SnowGameEngine(view, {
    onStatus() {}, onHud() {}, onGameOver() {}, onCrash() {},
    onSound: (event) => sounds.push(event),
  });
  game.start();
  return { game, fast: fastContext() };
}

const HAZ = ['rock', 'log', 'tree', 'gap', 'ramp', 'swinging-log', 'root', 'fence', 'ice', 'icicle', 'snowball', 'branch'];

function controllerJump(game) {
  const run = game.run;
  if (!run.rider.grounded) return;
  const x = run.rider.x;
  const danger = run.objects.find((object) => {
    if (object.kind === 'coin' || object.kind === 'ice' || object.bridged) return false;
    if (object.kind === 'gap') return !object.bridged && object.x > x + 60 && object.x < x + 240;
    return HAZ.includes(object.kind) && object.x > x + 80 && object.x < x + 190;
  });
  if (danger) game.jumpQueued = true;
}

/** Rides jump-disabled until the rider is grounded again (post-warmup). */
function settle(game, fast, maxFrames = 120) {
  for (let i = 0; i < maxFrames && !game.run.rider.grounded; i += 1) {
    ride(game, fast, 1, { jump: false });
  }
  assert.ok(game.run.rider.grounded, 'rider settled back onto the terrain');
}

function ride(game, fast, frames, { jump = true, invulnerable = true } = {}) {
  const run = game.run;
  run.elapsed = Math.max(run.elapsed, 5);
  const original = game.context;
  game.context = fast;
  let t = game.__rideTime ?? 0;
  for (let i = 0; i < frames; i += 1) {
    if (invulnerable) run.invulnerableUntil = run.elapsed + 10;
    run.rider.speed = 475;
    if (jump) controllerJump(game);
    t += 1000 / 60;
    game.__rideTime = t;
    game.frame(t);
  }
  game.context = original;
}

test('standard gameplay events flow to the audio callback', () => {
  const sounds = [];
  const { game, fast } = makeGame(seedSave(7, 3), sounds);
  ride(game, fast, 75); // past START_PAUSE
  settle(game, fast);
  game.run.objects = game.run.objects.filter((o) => o.kind !== 'coin');
  game.run.objects.push({ kind: 'coin', x: game.run.rider.x + 120, offset: 25 });
  game.jumpQueued = true;
  ride(game, fast, 90); // long enough for the jump's full flight and landing
  assert.ok(sounds.some((e) => e.type === 'coin'), 'coin collection cued');
  assert.ok(sounds.some((e) => e.type === 'jump'), 'jump cued');
  assert.ok(sounds.some((e) => e.type === 'land'), 'landing cued');
});

test('power pickup and expiration emit sound events', () => {
  const sounds = [];
  const { game, fast } = makeGame(seedSave(7, 3), sounds);
  ride(game, fast, 75); // past START_PAUSE
  settle(game, fast);
  game.run.objects = game.run.objects.filter((o) => o.kind !== 'coin' && o.kind !== 'magnet' && o.kind !== 'shield' && o.kind !== 'double');
  game.run.objects.push({ kind: 'magnet', x: game.run.rider.x + 130, offset: 25 });
  ride(game, fast, 40);
  assert.ok(sounds.some((e) => e.type === 'power' && e.kind === 'magnet' && e.phase === 'start'), 'magnet activation cued');
  assert.ok(game.run.magnetUntil > game.run.elapsed, 'magnet actually active');
  game.run.magnetUntil = game.run.elapsed + 0.05;
  ride(game, fast, 10);
  assert.ok(sounds.some((e) => e.type === 'power' && e.kind === 'magnet' && e.phase === 'end'), 'magnet expiration cued');
  const ends = sounds.filter((e) => e.type === 'power' && e.phase === 'end');
  assert.equal(ends.length, 1, 'expiration cued exactly once');
});

test('shield absorption emits a single end cue', () => {
  const sounds = [];
  const { game, fast } = makeGame(seedSave(7, 3), sounds);
  ride(game, fast, 75);
  settle(game, fast);
  const run = game.run;
  run.objects = run.objects.filter((o) => o.kind !== 'coin');
  run.objects.push({ kind: 'rock', x: run.rider.x + 140, width: 35 });
  run.shield = true;
  game.powerCueState = run.magnetUntil > run.elapsed ? ['magnet', 'shield'] : ['shield'];
  run.invulnerableUntil = 0;
  ride(game, fast, 60, { invulnerable: false, jump: false });
  assert.equal(run.shield, false, 'shield consumed by the hit');
  assert.ok(sounds.some((e) => e.type === 'power' && e.kind === 'shield' && e.phase === 'end'), 'shield end cued');
  ride(game, fast, 20, { invulnerable: false, jump: false });
  const ends = sounds.filter((e) => e.type === 'power' && e.kind === 'shield' && e.phase === 'end');
  assert.equal(ends.length, 1, 'no duplicate end cue from the tracker');
});

test('house transition emits door open/close and completion in cinematic order', () => {
  const sounds = [];
  const { game, fast } = makeGame(seedSave(7, 3), sounds);
  ride(game, fast, 75);
  game.run.bonus += 60000; // forces the safe-house approach
  let frames = 0;
  while (game.run.levelPhase !== 'approach' && frames < 400) {
    ride(game, fast, 1);
    frames += 1;
  }
  assert.equal(game.run.levelPhase, 'approach', 'house approach began');
  while (game.run.levelPhase !== 'riding' && frames < 2600) {
    ride(game, fast, 1);
    frames += 1;
  }
  assert.equal(game.run.levelPhase, 'riding', `house cycle completed (${frames} frames)`);
  const doorEvents = sounds.filter((e) => e.type === 'door').map((e) => e.phase);
  const completes = sounds.filter((e) => e.type === 'complete');
  assert.equal(completes.length, 1, 'exactly one completion cue');
  assert.deepEqual(doorEvents, ['open', 'close', 'open', 'close'], 'door cued open/close/open/close in order');
  // The completion cue lands with the door closing behind the rider.
  const completeAt = sounds.indexOf(completes[0]);
  const closeAt = sounds.findIndex((e, i) => i > completeAt && e.type === 'door' && e.phase === 'close');
  assert.ok(closeAt > completeAt, 'door closes after completion');
});

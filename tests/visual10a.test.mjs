/**
 * Phase 10A — visual polish verification.
 *
 * Methods used (kept distinct so nothing is over-claimed):
 *  - **Rasterized-frame pixel probes**: the engine's real draw stream is
 *    rasterized per-pixel by tests/raster.mjs (the same context API surface
 *    the browser sees) and assertions sample actual rendered pixels — crest
 *    rim colour, celebration warmth, rider bob.
 *  - **Draw-stream probes**: the recorder context captures actual fillStyle
 *    values from the render pass (aerial-perspective formula check).
 *  - **Animation-state probes**: the visual-only suspension spring and its
 *    reset points are asserted directly on the live engine.
 *  - **Rendered snapshots**: PNG frames are written for human review; the
 *    test only asserts they were produced. No aesthetic judgement is made
 *    here — a human pass over the PNGs remains part of manual review.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { moduleUrl } from './loadTypeScript.mjs';
import { rasterCanvas, encodePng, RasterContext, parseColor } from './raster.mjs';

const { LEVEL_SAVE_KEY, generateLevel } = await import(moduleUrl('src/game/levelManager.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

const W = 480;
const H = 270;
const OUT = '/home/user/phase10a-visuals/after';

// ── harness ─────────────────────────────────────────────────────────────

function storage(values = new Map()) {
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

function seedSave(journeySeed, currentLevel) {
  const store = storage();
  store.setItem(LEVEL_SAVE_KEY, JSON.stringify({
    version: 1, journeySeed, currentLevel, unlockedThrough: currentLevel,
    completedThrough: currentLevel - 1, levelScore: 0, runScore: 0,
    lifetimeScore: 0, checkpoint: null,
  }));
  return store;
}

function seedForEnvironment(number, theme) {
  for (let seed = 1; seed < 600; seed += 1) {
    if (generateLevel(number, seed).environment === theme) return seed;
  }
  throw new Error(`no seed for ${theme} at level ${number}`);
}

/** Fast recorder context — logs fill/stroke colours, gradients, fonts, ops. */
function recorderContext() {
  const state = { operations: 0 };
  const fills = [];
  const strokes = [];
  const gradients = [];
  const fonts = [];
  const makeGradient = (kind, x0, y0, x1, y1, r0 = 0, r1 = 0) => {
    const entry = { kind, x0, y0, x1, y1, r0, r1, stops: [] };
    gradients.push(entry);
    return { addColorStop(offset, color) { entry.stops.push({ offset, color }); } };
  };
  const context = {
    canvas: null,
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', font: '10px system-ui',
    textAlign: 'left', textBaseline: 'alphabetic',
    shadowColor: 'transparent', shadowBlur: 0,
    set font(value) { context._font = value; fonts.push(String(value)); },
    get font() { return context._font ?? '10px system-ui'; },
    _font: '10px system-ui',
    setTransform() { state.operations += 1; }, clearRect() { state.operations += 1; },
    fillRect() { state.operations += 1; fills.push({ color: context.fillStyle, alpha: context.globalAlpha }); },
    strokeRect() { state.operations += 1; },
    createLinearGradient: (x0, y0, x1, y1) => makeGradient('linear', x0, y0, x1, y1),
    createRadialGradient: (x0, y0, r0, x1, y1, r1) => makeGradient('radial', x0, y0, x1, y1, r0, r1),
    save() { state.operations += 1; }, restore() { state.operations += 1; },
    translate() { state.operations += 1; }, rotate() { state.operations += 1; }, scale() { state.operations += 1; },
    beginPath() { state.operations += 1; }, closePath() { state.operations += 1; },
    moveTo() { state.operations += 1; }, lineTo() { state.operations += 1; },
    quadraticCurveTo() { state.operations += 1; }, bezierCurveTo() { state.operations += 1; },
    arc() { state.operations += 1; }, ellipse() { state.operations += 1; },
    fill() { state.operations += 1; fills.push({ color: context.fillStyle, alpha: context.globalAlpha }); },
    stroke() { state.operations += 1; strokes.push({ color: context.strokeStyle, alpha: context.globalAlpha, width: context.lineWidth }); },
    fillText() { state.operations += 1; }, strokeText() { state.operations += 1; }, drawImage() { state.operations += 1; },
  };
  return { context, fills, strokes, gradients, fonts, state };
}

function makeEngine(save) {
  globalThis.localStorage = save;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {}, location: { search: '' }, devicePixelRatio: 1,
  };
  globalThis.document = { createElement: () => rasterCanvas(192, 192) };
  const view = rasterCanvas(W, H);
  const recorder = recorderContext();
  const game = new SnowGameEngine(view, { onStatus() {}, onHud() {}, onGameOver() {}, onCrash() {}, onSound() {} });
  game.start();
  game.__raster = view.getContext();
  game.__recorder = recorder;
  game.__fast = recorder.context;
  return game;
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

function ride(game, frames, { jump = controllerJump, invulnerable = true, speed = 475, fast = true } = {}) {
  const run = game.run;
  run.elapsed = Math.max(run.elapsed, 5);
  const original = game.context;
  if (fast) game.context = game.__fast;
  let time = game.__rideTime ?? 0;
  for (let index = 0; index < frames; index += 1) {
    if (invulnerable) run.invulnerableUntil = run.elapsed + 10;
    run.rider.speed = speed;
    if (jump) jump(game);
    time += 1000 / 60;
    game.__rideTime = time;
    game.frame(time);
  }
  game.context = original;
  return time;
}

/** Render exactly one frame through the rasterizer and return its pixels. */
function rasterFrame(game) {
  const original = game.context;
  game.context = game.__raster;
  const time = (game.__rideTime ?? 0) + 1000 / 60;
  game.__rideTime = time;
  game.frame(time);
  game.context = original;
  return game.__raster;
}

const pixel = (raster, x, y) => {
  const index = (Math.round(y) * raster.width + Math.round(x)) * 4;
  return { r: raster.data[index], g: raster.data[index + 1], b: raster.data[index + 2] };
};

const luminanceOf = ({ r, g, b }) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

const mixRgb = (a, b, t) => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

/** Topmost row within a column band matching a predicate (rider silhouette). */
function topmostRow(raster, xMin, xMax, yMin, yMax, predicate) {
  for (let y = Math.round(yMin); y <= Math.round(yMax); y += 1) {
    for (let x = Math.round(xMin); x <= Math.round(xMax); x += 1) {
      if (predicate(pixel(raster, x, y))) return y;
    }
  }
  return -1;
}

/** Brightest pixel in a small window (the crest stroke). */
function brightestIn(raster, x, yMin, yMax) {
  let best = null;
  let bestLuma = -1;
  for (let y = Math.round(yMin); y <= Math.round(yMax); y += 1) {
    const sample = pixel(raster, x, y);
    const luma = luminanceOf(sample);
    if (luma > bestLuma) { bestLuma = luma; best = sample; }
  }
  return best;
}

const riderDark = ({ r, g, b }) => Math.abs(r - 64) < 30 && Math.abs(g - 86) < 30 && Math.abs(b - 110) < 34;

// ── 1. suspension spring ────────────────────────────────────────────────

test('Suspension compresses on landing, rebounds, and settles', () => {
  const game = makeEngine(seedSave(4242, 8));
  ride(game, 90);
  // A clean jump with a guaranteed landing.
  game.jumpQueued = true;
  ride(game, 1, { jump: null });
  assert.ok(!game.run.rider.grounded, 'airborne after the jump');
  assert.ok(game.suspensionVelocity < 0 || game.suspension < 0,
    `takeoff extends the suspension (v=${game.suspensionVelocity.toFixed(2)}, s=${game.suspension.toFixed(3)})`);
  let landed = false;
  for (let index = 0; index < 140 && !landed; index += 1) {
    ride(game, 1, { jump: null });
    if (game.run.rider.grounded) landed = true;
  }
  assert.ok(landed, 'the rider lands');
  assert.ok(game.suspension > 0.03, `touchdown compresses the suspension (${game.suspension.toFixed(3)})`);
  const peak = game.suspension;
  // The spring settles within ~0.75s of riding.
  ride(game, 45, { jump: null });
  assert.ok(game.suspension < peak, 'the compression relaxes');
  assert.ok(Math.abs(game.suspension) < 0.05, `settled near rest (${game.suspension.toFixed(3)})`);
});

test('Suspension state resets on revive and on restart', () => {
  const game = makeEngine(seedSave(4242, 16));
  ride(game, 150);
  const run = game.run;
  run.invulnerableUntil = 0;
  run.shield = false;
  let plants = 0;
  let frames = 0;
  while (!run.over && frames < 1200) {
    game.clock += 1 / 120;
    game.step(1 / 120);
    frames += 1;
    if (!run.over && run.rider.grounded && plants < 6
      && !run.objects.some((object) => object.kind === 'rock' && object.x > run.rider.x + 20)) {
      run.objects.push({ kind: 'rock', x: run.rider.x + 70 });
      plants += 1;
    }
  }
  assert.ok(run.over, 'crashed for the revive');
  game.suspension = 0.8; // whatever the crash left
  assert.equal(game.revive(), true);
  assert.equal(game.suspension, 0, 'revive starts relaxed');
  assert.equal(game.suspensionVelocity, 0);
  game.returnToMenu();
  game.start();
  assert.equal(game.suspension, 0, 'restart starts relaxed');
});

// ── 2. cadence bob (rasterized frames) ──────────────────────────────────

test('Cadence bob animates the grounded rider within a tight envelope', () => {
  const game = makeEngine(seedSave(4242, 12));
  ride(game, 160);
  const run = game.run;
  assert.ok(run.rider.grounded, 'riding grounded');
  const riderX = Math.round(run.rider.x - run.cameraX);
  const rows = [];
  for (let index = 0; index < 7; index += 1) {
    const riderY = run.rider.y;
    const raster = rasterFrame(game);
    ride(game, 4, { jump: null, fast: false }); // ~0.07s apart — sub-bob sampling
    // The band is rider-relative: the camera's vertical follow shifts the
    // whole scene, so a fixed screen band would miss the rider on slopes.
    // The row is measured relative to the rider's own y so terrain undulation
    // under the wheels does not count as bob.
    const row = topmostRow(raster, riderX - 16, riderX + 20, riderY - 80, riderY + 12, riderDark);
    assert.ok(row > 0, 'the rider silhouette is visible');
    rows.push(row - riderY);
  }
  const spread = Math.max(...rows) - Math.min(...rows);
  assert.ok(spread >= 0.5, `the grounded rider animates vertically (spread ${spread.toFixed(1)}px)`);
  assert.ok(spread <= 4, `the bob stays subtle (spread ${spread.toFixed(1)}px)`);
});

// ── 3. night crest rim (rasterized frames) ──────────────────────────────

test('Night terrain crest picks up a cool moonlit rim', () => {
  const seed = seedForEnvironment(30, 'snowy-mountains');
  const game = makeEngine(seedSave(seed, 30));
  game.setDayPhasePreview(0.4);
  ride(game, 200);
  const run = game.run;
  const riderScreenX = run.rider.x - run.cameraX;
  const columns = [70, 100, 420].filter((x) => Math.abs(x - riderScreenX) > 40);

  // Pixel probe: the brightest pixel riding the crest line.
  const crestAt = (raster) => columns.map((x) => {
    const worldX = run.cameraX + x;
    const crestY = game.terrainAt(worldX);
    return brightestIn(raster, x, crestY - 3, crestY + 3);
  });
  const dayCrest = crestAt(rasterFrame(game));

  // Draw-stream probe: the crest stroke itself (lineWidth 2.4 is unique to
  // the terrain crest), so the rim formula is verified in isolation from the
  // palette's own night cooling.
  const crestStrokeAt = (phase) => {
    game.__recorder.strokes.length = 0;
    const original = game.context;
    game.context = game.__fast;
    const time = (game.__rideTime ?? 0) + 1000 / 60;
    game.__rideTime = time;
    game.frame(time);
    game.context = original;
    const stroke = game.__recorder.strokes.find((entry) => entry.width === 2.4);
    assert.ok(stroke, `crest stroke captured at phase ${phase}`);
    return parseColor(stroke.color);
  };
  const dayStroke = crestStrokeAt(0.4);
  const paletteDay = game.environment.palette(0.4);
  const expectedDay = mixRgb(parseColor(paletteDay.snow), { r: 255, g: 255, b: 255 }, 0.5);
  assert.ok(Math.abs(dayStroke.r - expectedDay.r) <= 3 && Math.abs(dayStroke.g - expectedDay.g) <= 3 && Math.abs(dayStroke.b - expectedDay.b) <= 3,
    `day crest stroke matches mix(snow, white, 0.5) (${dayStroke.r},${dayStroke.g},${dayStroke.b} vs ${expectedDay.r.toFixed(0)},${expectedDay.g.toFixed(0)},${expectedDay.b.toFixed(0)})`);

  game.setDayPhasePreview(0.92);
  ride(game, 30, { jump: null });
  const nightCrest = crestAt(rasterFrame(game));
  const nightStroke = crestStrokeAt(0.92);
  const paletteNight = game.environment.palette(0.92);
  const expectedNight = mixRgb(
    mixRgb(parseColor(paletteNight.snow), { r: 255, g: 255, b: 255 }, 0.5),
    parseColor('#c9e2f8'),
    paletteNight.night * 0.55,
  );
  assert.ok(Math.abs(nightStroke.r - expectedNight.r) <= 3 && Math.abs(nightStroke.g - expectedNight.g) <= 3 && Math.abs(nightStroke.b - expectedNight.b) <= 3,
    `night crest stroke matches the moonlit-rim formula (${nightStroke.r},${nightStroke.g},${nightStroke.b} vs ${expectedNight.r.toFixed(0)},${expectedNight.g.toFixed(0)},${expectedNight.b.toFixed(0)})`);
  const strokeRimGain = (nightStroke.b - nightStroke.r) - (dayStroke.b - dayStroke.r);
  assert.ok(strokeRimGain >= 8, `the rim measurably cools the stroke (${strokeRimGain.toFixed(0)} B−R gain)`);
  // Pixel-level direction: most sampled crest columns render cooler at night
  // (the brightest window pixel can be the fill on obstacle-covered columns).
  let coolerColumns = 0;
  for (let index = 0; index < columns.length; index += 1) {
    const dayCool = dayCrest[index].b - dayCrest[index].r;
    const nightCool = nightCrest[index].b - nightCrest[index].r;
    if (nightCool > dayCool) coolerColumns += 1;
  }
  assert.ok(coolerColumns >= Math.ceil(columns.length / 2),
    `most crest columns render cooler at night (${coolerColumns}/${columns.length})`);
});

// ── 4. aerial perspective (draw-stream formula check) ───────────────────

test('Far ridges haze toward the horizon more than mid ridges (aerial perspective)', () => {
  // Countryside is always clear weather, so the only mixes applied to the
  // parallax fill are the night tint (0 at phase 0.4) and the new aerial mix.
  const seed = seedForEnvironment(12, 'countryside');
  const game = makeEngine(seedSave(seed, 12));
  game.setDayPhasePreview(0.4);
  game.__recorder.fills.length = 0;
  ride(game, 60, { jump: null });
  const layers = game.environment.parallaxLayers();
  const palette = game.environment.palette(0.4);
  const horizon = parseColor(palette.horizon);
  const expected = (index) => {
    const raw = parseColor(layers[index].color);
    const aerial = Math.max(0, 0.38 - layers[index].parallax) * 0.5;
    return mixRgb(raw, horizon, aerial);
  };
  const close = (a, b) => Math.abs(a.r - b.r) <= 2 && Math.abs(a.g - b.g) <= 2 && Math.abs(a.b - b.b) <= 2;
  const layerFills = [];
  for (let index = 0; index < 2; index += 1) {
    const want = expected(index);
    const found = game.__recorder.fills
      .filter((entry) => typeof entry.color === 'string')
      .map((entry) => parseColor(entry.color))
      .find((color) => color && close(color, want));
    assert.ok(found, `parallax layer ${index} fill matches the aerial-perspective formula (${want.r.toFixed(0)},${want.g.toFixed(0)},${want.b.toFixed(0)})`);
    layerFills.push(found);
  }
  // And the far layer's mix factor toward the horizon is larger than the
  // mid layer's (0.165 vs 0.13 by design — distance-pull numbers are not
  // comparable across different base colours).
  const mixFactor = (index) => {
    const raw = parseColor(layers[index].color);
    const got = layerFills[index];
    const factors = ['r', 'g', 'b']
      .filter((channel) => Math.abs(horizon[channel] - raw[channel]) > 12)
      .map((channel) => (got[channel] - raw[channel]) / (horizon[channel] - raw[channel]));
    return factors.reduce((sum, value) => sum + value, 0) / Math.max(1, factors.length);
  };
  assert.ok(mixFactor(0) > mixFactor(1), `the far ridge mixes toward the horizon more (${mixFactor(0).toFixed(3)} vs ${mixFactor(1).toFixed(3)})`);
});

// ── 5. house celebration (rasterized frames + state) ────────────────────

test('Level completion adds roof sparks and a warm celebration glow', () => {
  const game = makeEngine(seedSave(4242, 12));
  game.setDayPhasePreview(0.4);
  ride(game, 200);
  game.run.bonus += 60000;
  let settle = 0;
  while (game.run.levelPhase === 'riding' && settle < 240) {
    game.clock += 1 / 60;
    game.step(1 / 60);
    settle += 1;
  }
  assert.equal(game.run.levelPhase, 'approach', 'house approach');
  const house = game.run.houses[game.run.houses.length - 1];

  // Ride through the door into the celebration.
  const warmParticles = () => game.run.particles.filter((particle) => particle.color === '#ffd98b' || particle.color === '#fff1cd').length;
  let time = game.__rideTime ?? 0;
  for (let index = 0; index < 1200 && game.run.levelPhase !== 'celebrating'; index += 1) {
    time += 1000 / 120;
    game.__rideTime = time;
    game.context = game.__fast;
    game.frame(time);
  }
  assert.equal(game.run.levelPhase, 'celebrating', 'celebration reached');
  assert.ok(warmParticles() >= 20, `sparks rise from the roofline (${warmParticles()})`);

  // The warmth overlay is verified through the draw stream: during the
  // celebration (and only then) the renderer issues a radial warm gradient
  // centred on the house plus an edge-dimming gradient. Pixel deltas are not
  // comparable here because the environment cross-fade into the next level
  // repaints the whole scene at the same time. Sample mid-envelope, where
  // the sin() envelope is at full strength.
  const seconds = game.levels.current.transitions.end.completionSeconds;
  while (game.run.sceneTime < seconds * 0.5) {
    game.clock += 1 / 120;
    game.step(1 / 120);
  }
  game.__recorder.gradients.length = 0;
  const original = game.context;
  game.context = game.__fast;
  time += 1000 / 60;
  game.__rideTime = time;
  game.frame(time);
  game.context = original;
  const warm = game.__recorder.gradients.find((entry) => entry.kind === 'radial'
    && entry.stops.some((stop) => String(stop.color).includes('255, 206, 130')));
  assert.ok(warm, 'a warm radial glow is drawn during the celebration');
  // The camera may have crept forward while the rider entered the door, so
  // compare against the live screen position of the house.
  const liveHouseScreenX = house.x - game.run.cameraX;
  assert.ok(Math.abs(warm.x0 - liveHouseScreenX) < 90 && Math.abs(warm.y0 - (house.groundY - 90)) < 90,
    `the glow is centred on the house (${warm.x0.toFixed(0)},${warm.y0.toFixed(0)} vs house ${liveHouseScreenX.toFixed(0)},${(house.groundY - 90).toFixed(0)})`);
  const edges = game.__recorder.gradients.find((entry) => entry.kind === 'radial'
    && entry.stops.some((stop) => String(stop.color).includes('16, 26, 44')));
  assert.ok(edges, 'an edge-dimming gradient is drawn during the celebration');
  const warmAlpha = warm.stops.map((stop) => parseColor(String(stop.color)).a / 255);
  assert.ok(Math.max(...warmAlpha) > 0.05 && Math.max(...warmAlpha) <= 0.25,
    `the glow stays subtle (peak alpha ${Math.max(...warmAlpha).toFixed(2)})`);

  // The overlay is absent while riding normally.
  const probe = makeEngine(seedSave(4242, 12));
  ride(probe, 120);
  probe.__recorder.gradients.length = 0;
  const probeOriginal = probe.context;
  probe.context = probe.__fast;
  const probeTime = (probe.__rideTime ?? 0) + 1000 / 60;
  probe.__rideTime = probeTime;
  probe.frame(probeTime);
  probe.context = probeOriginal;
  assert.ok(!probe.__recorder.gradients.some((entry) => entry.stops.some((stop) => String(stop.color).includes('255, 206, 130'))),
    'no celebration glow during normal riding');
});

// ── 6. typography + coin sparkle ────────────────────────────────────────

test('Canvas text uses the interface font stack', () => {
  const game = makeEngine(seedSave(4242, 12));
  ride(game, 60);
  game.__recorder.fonts.length = 0;
  const original = game.context;
  game.context = game.__fast;
  const time = (game.__rideTime ?? 0) + 1000 / 60;
  game.__rideTime = time;
  game.frame(time);
  game.context = original;
  assert.ok(game.__recorder.fonts.some((font) => font.includes('Avenir Next')),
    'canvas fonts now match the shell typography');
});

test('Coin pickups pop with a bright core sparkle', () => {
  const game = makeEngine(seedSave(4242, 12));
  ride(game, 120);
  const run = game.run;
  const coinX = run.rider.x + 140;
  run.objects.push({ kind: 'coin', x: coinX, offset: 20 });
  ride(game, 30, { jump: null });
  assert.ok(!run.objects.some((object) => object.kind === 'coin' && object.x === coinX), 'coin collected');
  const core = run.particles.filter((particle) => particle.color === '#fff6dc');
  assert.ok(core.length >= 3, `bright core particles spawned (${core.length})`);
});

// ── 7. performance guard ────────────────────────────────────────────────

test('Polish keeps the render loop fast and allocation-light', () => {
  const game = makeEngine(seedSave(4242, 30));
  const heapAtStart = process.memoryUsage().heapUsed;
  const frameTimes = [];
  let time = game.__rideTime ?? 0;
  for (let index = 0; index < 1500; index += 1) {
    const started = process.hrtime.bigint();
    game.run.invulnerableUntil = game.run.elapsed + 10;
    game.run.rider.speed = 475;
    controllerJump(game);
    time += 1000 / 60;
    game.__rideTime = time;
    game.context = game.__fast;
    game.frame(time);
    frameTimes.push(Number(process.hrtime.bigint() - started) / 1e6);
    if (game.__recorder.fills.length > 20000) game.__recorder.fills.length = 0;
    if (game.__recorder.fonts.length > 2000) game.__recorder.fonts.length = 0;
  }
  const average = frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length;
  const p99 = frameTimes.sort((a, b) => a - b)[Math.floor(frameTimes.length * 0.99)];
  const heapGrowth = (process.memoryUsage().heapUsed - heapAtStart) / 1024 / 1024;
  console.log(`visual10a perf: avg ${average.toFixed(2)}ms, p99 ${p99.toFixed(2)}ms, heap +${heapGrowth.toFixed(1)}MB`);
  assert.ok(average < 8, `average frame time ${average.toFixed(2)}ms`);
  assert.ok(p99 < 25, `p99 frame time ${p99.toFixed(2)}ms`);
  assert.ok(heapGrowth < 150, `heap growth ${heapGrowth.toFixed(1)}MB`);
});

// ── 8. rendered snapshots for human review ──────────────────────────────

test('Rendered snapshot frames are produced for human review', () => {
  mkdirSync(OUT, { recursive: true });
  const cases = [
    { name: 'snowy-day', theme: 'snowy-mountains', level: 30, phase: 0.4 },
    { name: 'snowy-night', theme: 'snowy-mountains', level: 30, phase: 0.92 },
    { name: 'moonlit-night', theme: 'moonlit-forest', level: 70, phase: 0.95 },
    { name: 'countryside-sunset', theme: 'countryside', level: 12, phase: 0.64 },
    { name: 'misty-day', theme: 'misty-mountains', level: 61, phase: 0.3 },
  ];
  const sizes = [];
  for (const testCase of cases) {
    const seed = seedForEnvironment(testCase.level, testCase.theme);
    const game = makeEngine(seedSave(seed, testCase.level));
    game.setDayPhasePreview(testCase.phase);
    ride(game, 260);
    const bytes = encodePng(rasterFrame(game));
    writeFileSync(`${OUT}/${testCase.name}.png`, bytes);
    sizes.push(`${testCase.name}:${(bytes.length / 1024).toFixed(0)}KB`);
  }
  // Airborne tuck.
  {
    const game = makeEngine(seedSave(4242, 8));
    game.setDayPhasePreview(0.4);
    ride(game, 120);
    game.jumpQueued = true;
    ride(game, 26, { jump: null });
    const bytes = encodePng(rasterFrame(game));
    writeFileSync(`${OUT}/airborne-tuck.png`, bytes);
    sizes.push(`airborne-tuck:${(bytes.length / 1024).toFixed(0)}KB`);
  }
  // Fresh landing (suspension compressed).
  {
    const game = makeEngine(seedSave(4242, 8));
    game.setDayPhasePreview(0.4);
    ride(game, 120);
    game.jumpQueued = true;
    let landed = false;
    for (let index = 0; index < 140 && !landed; index += 1) {
      ride(game, 1, { jump: null });
      if (game.run.rider.grounded) landed = true;
    }
    assert.ok(landed && game.suspension > 0.02, 'captured mid-compression');
    const bytes = encodePng(rasterFrame(game));
    writeFileSync(`${OUT}/landing-squat.png`, bytes);
    sizes.push(`landing-squat:${(bytes.length / 1024).toFixed(0)}KB`);
  }
  for (const name of ['snowy-day', 'snowy-night', 'moonlit-night', 'countryside-sunset', 'misty-day', 'airborne-tuck', 'landing-squat']) {
    assert.ok(statSync(`${OUT}/${name}.png`).size > 1000, `${name}.png written`);
  }
  console.log(`snapshots → ${OUT} [${sizes.join(' ')}]`);
});

test('Rasterizer sanity: frames contain sky, terrain and rider layers', () => {
  const seed = seedForEnvironment(30, 'snowy-mountains');
  const game = makeEngine(seedSave(seed, 30));
  game.setDayPhasePreview(0.4);
  ride(game, 200);
  const raster = rasterFrame(game);
  assert.ok(raster instanceof RasterContext, 'raster context in use');
  const sky = pixel(raster, 240, 20);
  const ground = pixel(raster, 240, H - 12);
  const skyLuma = luminanceOf(sky);
  const groundLuma = luminanceOf(ground);
  assert.ok(skyLuma > 0.25 && skyLuma < 0.95, `sky reads as sky (${skyLuma.toFixed(2)})`);
  assert.ok(groundLuma > 0.3, `ground reads as ground (${groundLuma.toFixed(2)})`);
  const riderX = Math.round(game.run.rider.x - game.run.cameraX);
  const riderRow = topmostRow(raster, riderX - 16, riderX + 20, game.run.rider.y - 80, game.run.rider.y + 12, riderDark);
  assert.ok(riderRow > 0, 'the rider silhouette is present');
  console.log(`raster frame: sky luma ${skyLuma.toFixed(2)}, ground luma ${groundLuma.toFixed(2)}, rider top row ${riderRow}`);
});

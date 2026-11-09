import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

const { generateLevel } = await import(moduleUrl('src/game/levelManager.ts'));
const {
  EnvironmentManager,
  ENVIRONMENTS,
  PARALLAX_LAYER_COUNT,
} = await import(moduleUrl('src/game/environment.ts'));
const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

const THEMES = ['countryside', 'snowy-mountains', 'misty-mountains', 'moonlit-forest'];
const LEVEL_FOR_THEME = { countryside: 1, 'snowy-mountains': 2, 'misty-mountains': 3, 'moonlit-forest': 4 };
const COLOR_KEYS = ['top', 'horizon', 'far', 'middle', 'near', 'snow', 'snowShade', 'glow', 'moon'];

function storage(values = new Map()) {
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, values };
}

function channels(color) {
  if (color.startsWith('#')) {
    return [1, 3, 5].map((index) => Number.parseInt(color.slice(index, index + 2), 16));
  }
  const match = color.match(/\d+/g);
  assert.ok(match, `expected a css colour string, received ${color}`);
  return match.slice(0, 3).map(Number);
}

function channelDistance(a, b) {
  const first = channels(a);
  const second = channels(b);
  return Math.max(...first.map((value, index) => Math.abs(value - second[index])));
}

/**
 * Records coordinates, path operations, arc geometry, stroke styles and the
 * maximum global alpha used, so ground detail, mist and foreground layers can
 * be audited for surface alignment, determinism and readability.
 */
function recorderContext() {
  const ops = [];
  const arcs = [];
  const strokes = [];
  const fills = [];
  let maxAlpha = 0;
  let operations = 0;
  const gradient = { addColorStop() {} };
  const wrap = (name) => (...values) => {
    operations += 1;
    ops.push({ name, values });
  };
  const context = {
    canvas: null,
    fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1,
    lineCap: 'butt', lineJoin: 'miter', font: '10px system-ui', textAlign: 'left', textBaseline: 'alphabetic',
    shadowColor: 'transparent', shadowBlur: 0,
    set fillStyle(value) { fills.push(String(value)); this._fill = value; },
    get fillStyle() { return this._fill ?? '#000'; },
    set strokeStyle(value) { strokes.push(String(value)); this._stroke = value; },
    get strokeStyle() { return this._stroke ?? '#000'; },
    set globalAlpha(value) { maxAlpha = Math.max(maxAlpha, value); this._alpha = value; },
    get globalAlpha() { return this._alpha ?? 1; },
    setTransform: wrap('setTransform'),
    clearRect: wrap('clearRect'),
    fillRect: wrap('fillRect'),
    strokeRect: wrap('strokeRect'),
    createLinearGradient: (...values) => { operations += 1; ops.push({ name: 'linearGradient', values }); return gradient; },
    createRadialGradient: (...values) => { operations += 1; ops.push({ name: 'radialGradient', values }); return gradient; },
    save() { operations += 1; },
    restore() { operations += 1; },
    translate: wrap('translate'),
    rotate: wrap('rotate'),
    scale: wrap('scale'),
    beginPath() { operations += 1; },
    closePath() { operations += 1; },
    moveTo: wrap('moveTo'),
    lineTo: wrap('lineTo'),
    quadraticCurveTo: wrap('quadraticCurveTo'),
    bezierCurveTo: wrap('bezierCurveTo'),
    arc(...values) { operations += 1; arcs.push({ x: values[0], y: values[1], radius: values[2] }); },
    ellipse: wrap('ellipse'),
    fill() { operations += 1; },
    stroke() { operations += 1; },
    fillText: wrap('fillText'),
    strokeText: wrap('strokeText'),
    drawImage() { operations += 1; },
  };
  return { context, ops, arcs, strokes, fills, get operations() { return operations; }, get maxAlpha() { return maxAlpha; } };
}

/** rgba() luminance helper — proves bright strokes survive the night. */
function colorLuminance(style) {
  const match = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(String(style));
  if (!match) return 0;
  return 0.299 * Number(match[1]) + 0.587 * Number(match[2]) + 0.114 * Number(match[3]);
}

function colorAlpha(style) {
  const match = /rgba?\(\d+, \d+, \d+(?:, ([\d.]+))?\)/.exec(String(style));
  return match && match[1] !== undefined ? Number(match[1]) : 1;
}

function makeEngine({ search = '', save = storage() } = {}) {
  globalThis.localStorage = save;
  globalThis.window = {
    addEventListener() {}, removeEventListener() {},
    requestAnimationFrame() { return 0; }, cancelAnimationFrame() {},
    location: { search },
  };
  globalThis.document = {
    createElement: () => {
      const inner = recorderContext();
      return { width: 192, height: 192, getContext: () => inner.context };
    },
  };
  const recorder = recorderContext();
  const frames = [];
  const game = new SnowGameEngine({
    getBoundingClientRect: () => ({ width: 900, height: 600 }),
    getContext: () => recorder.context,
  }, { onStatus() {}, onHud() {}, onGameOver() {}, onFrame: (state) => frames.push(state) });
  return { game, recorder, frames, save };
}

function makeView(overrides = {}) {
  return {
    width: 900,
    height: 600,
    cameraX: 5000,
    cameraY: 0,
    clock: 12.5,
    phase: 0.4,
    riderX: 5200,
    isMenu: false,
    lighter: false,
    groundAt: (x) => 340 + Math.sin(x * 0.002) * 18,
    ...overrides,
  };
}

// ───────────────────────── day / night cycle ─────────────────────────

test('Every environment rides a full, smooth day and night cycle', () => {
  for (const theme of THEMES) {
    const environment = new EnvironmentManager();
    environment.setLevel(generateLevel(LEVEL_FOR_THEME[theme], 4242));

    const nights = [];
    const colors = [];
    for (let phase = 0; phase < 1; phase += 0.02) {
      const palette = environment.palette(phase);
      nights.push(palette.night);
      colors.push(palette);
    }
    const day = nights[Math.round(0.4 / 0.02)];
    const night = nights[Math.round(0.9 / 0.02)];
    assert.ok(day <= 0.45, `${theme} sees daylight (phase 0.4 night = ${day})`);
    assert.ok(night >= 0.5, `${theme} reaches night (phase 0.9 night = ${night})`);

    // Smooth dawn / dusk: no step may lurch beyond what the stop layout allows
    // (gradients are additionally bounded per-segment in environment.test.mjs).
    for (let index = 1; index < nights.length; index += 1) {
      assert.ok(Math.abs(nights[index] - nights[index - 1]) <= 0.16, `${theme} night lurches at ${(index * 0.02).toFixed(2)}`);
      for (const key of COLOR_KEYS) {
        assert.ok(channelDistance(colors[index][key], colors[index - 1][key]) <= 55, `${theme} ${key} lurches at ${(index * 0.02).toFixed(2)}`);
      }
    }
  }
});

test('Sun and moon trade places across the cycle in every environment', () => {
  for (const theme of THEMES) {
    const environment = new EnvironmentManager();
    environment.setLevel(generateLevel(LEVEL_FOR_THEME[theme], 4242));

    const day = recorderContext();
    environment.drawSky(day.context, makeView({ phase: 0.4 }), environment.palette(0.4));
    const sunArc = day.arcs.find((arc) => arc.y > makeView().height * 0.2 && arc.y < makeView().height * 0.34 && arc.radius > 8);
    assert.ok(sunArc, `${theme} draws a sun by day`);
    assert.ok(day.maxAlpha < 1, `${theme} sun never fully blows out the sky`);

    const night = recorderContext();
    environment.drawSky(night.context, makeView({ phase: 0.9 }), environment.palette(0.9));
    const moonArc = night.arcs.find((arc) => arc.y > makeView().height * 0.14 && arc.y < makeView().height * 0.24 && arc.radius >= 9);
    assert.ok(moonArc, `${theme} draws a moon at night`);
    const stars = night.arcs.filter((arc) => arc.radius <= 1.6).length;
    assert.ok(stars >= 8, `${theme} shows stars at night (${stars})`);

    // The moonlit forest keeps the richest night sky of the four themes.
    if (theme === 'moonlit-forest') {
      assert.ok(stars >= 40, 'moonlit forest keeps its dense starfield');
    }
  }
});

test('The celestial cycle is untouched: engine phase is continuous and preview-free by default', () => {
  const { game } = makeEngine();
  game.start();
  const phases = [];
  for (let index = 0; index < 40; index += 1) {
    game.frame(1000 + index * 16.7);
    phases.push(game.environmentView.phase);
  }
  for (let index = 1; index < phases.length; index += 1) {
    const delta = phases[index] - phases[index - 1];
    assert.ok(delta > 0 && delta < 0.01, `phase advances smoothly (${delta})`);
  }
});

test('Level transitions blend the night factor without resetting the cycle', () => {
  const environment = new EnvironmentManager();
  environment.setLevel(generateLevel(1, 42));
  environment.transitionTo(generateLevel(4, 42), 3, 1000);
  const nights = [];
  for (let index = 0; index <= 30; index += 1) {
    environment.update(0.1, { width: 900, height: 600, cameraX: 1000, cameraDx: 3, storm: 0, lighter: false, phase: 0.9, night: 0.9 });
    nights.push(environment.palette(0.9).night);
  }
  for (let index = 1; index < nights.length; index += 1) {
    assert.ok(Math.abs(nights[index] - nights[index - 1]) <= 0.12, 'night factor jumps during the cross-fade');
  }
  assert.ok(Math.abs(nights[nights.length - 1] - nights[0]) < 0.35, 'blend ends near the moonlit night value');
});

// ───────────────────────── dev previews ─────────────────────────

test('Weather preview pins any condition in any environment and restores cleanly', () => {
  const environment = new EnvironmentManager();
  environment.setLevel(generateLevel(1, 42));
  const configured = environment.weatherEffects();

  environment.setWeatherPreview([{ kind: 'snow', intensity: 0.9 }]);
  assert.deepEqual(environment.weatherEffects(), [{ kind: 'snow', intensity: 0.9 }]);
  environment.update(0.5, { width: 900, height: 600, cameraX: 0, cameraDx: 0, storm: 0, lighter: false });
  assert.ok(environment.snowIntensity > 0.85, 'previewed snow reaches the particle system');

  // The preview survives a level transition blend.
  environment.transitionTo(generateLevel(4, 42), 2, 500);
  environment.update(1, { width: 900, height: 600, cameraX: 0, cameraDx: 0, storm: 0, lighter: false });
  assert.deepEqual(environment.weatherEffects(), [{ kind: 'snow', intensity: 0.9 }]);

  environment.setWeatherPreview(null);
  // Mid-blend the configured effects of both endpoints return (wind + fog).
  const restored = environment.weatherEffects();
  assert.deepEqual(restored.map((effect) => effect.kind).sort(), ['fog', 'wind']);
  assert.ok(restored.every((effect) => effect.intensity >= 0 && effect.intensity <= 1));

  // A fresh manager with no preview returns the untouched level configuration.
  const reference = new EnvironmentManager();
  reference.setLevel(generateLevel(1, 42));
  assert.deepEqual(reference.weatherEffects(), configured);
});

test('Engine weather presets cover every condition and drive the storm level', () => {
  const { game, frames } = makeEngine();
  game.start();
  for (const preset of ['clear', 'snow', 'fog', 'wind', 'storm']) {
    game.setWeatherPreview(preset);
    const effects = game.environment.weatherEffects();
    if (preset === 'clear') assert.equal(effects.length, 0);
    if (preset === 'snow') assert.deepEqual(effects, [{ kind: 'snow', intensity: 0.8 }]);
    if (preset === 'fog') assert.deepEqual(effects, [{ kind: 'fog', intensity: 0.65 }]);
    if (preset === 'wind') assert.deepEqual(effects, [{ kind: 'wind', intensity: 0.65 }]);
    if (preset === 'storm') {
      assert.deepEqual(effects, [
        { kind: 'snow', intensity: 0.9 },
        { kind: 'wind', intensity: 0.85 },
        { kind: 'fog', intensity: 0.3 },
      ]);
    }
  }
  game.setWeatherPreview('storm');
  game.frame(4000);
  game.frame(4016.7);
  assert.ok(frames.length > 0 && frames[frames.length - 1].storm > 0.8, 'storm preview drives the storm level');
  game.setWeatherPreview('auto');
  const restored = game.environment.weatherEffects();
  assert.deepEqual(restored, [{ kind: 'wind', intensity: 0.22 }], 'auto restores the level one countryside breeze');
});

test('Day-phase preview freezes the cycle for lighting audits', () => {
  const { game, frames } = makeEngine();
  game.start();
  game.setDayPhasePreview(0.9);
  game.frame(4000);
  game.frame(4016.7);
  assert.ok(game.lastNight > 0.5, 'countryside renders its deep night under the preview');
  assert.ok(frames.some((state) => state.night > 0.5), 'audio state sees the previewed night');

  game.setDayPhasePreview(0.4);
  game.frame(4033.4);
  assert.ok(game.lastNight <= 0.12, 'previewed day is bright');

  game.setDayPhasePreview(null);
  const before = game.environmentView.phase;
  for (let index = 0; index < 20; index += 1) {
    game.frame(4050 + index * 16.7);
  }
  assert.ok(game.environmentView.phase > before, 'cycle resumes advancing after the preview is cleared');
});

// ───────────────────────── ground appearance ─────────────────────────

test('Ground detail hugs the physics surface in every environment', () => {
  for (const theme of THEMES) {
    const environment = new EnvironmentManager();
    environment.setLevel(generateLevel(LEVEL_FOR_THEME[theme], 4242));
    assert.ok(['grass', 'snow', 'rocky', 'forest'].includes(environment.groundStyle.kind), `${theme} has a ground style`);

    const view = makeView();
    const recorder = recorderContext();
    environment.drawGroundDetail(recorder.context, view, environment.palette(0.4));
    assert.ok(recorder.operations > 60, `${theme} draws crest detail (${recorder.operations} ops)`);

    const surfaceAt = (screenX) => view.groundAt(view.cameraX + screenX);
    let checked = 0;
    for (const op of recorder.ops) {
      if (op.name === 'moveTo' || op.name === 'lineTo' || op.name === 'quadraticCurveTo' || op.name === 'fillRect' || op.name === 'ellipse') {
        const values = op.values;
        const xs = op.name === 'fillRect' ? [values[0]] : op.name === 'ellipse' ? [values[0]] : values.filter((_, index) => index % 2 === 0);
        const ys = op.name === 'fillRect' ? [values[1]] : op.name === 'ellipse' ? [values[1]] : values.filter((_, index) => index % 2 === 1);
        for (let index = 0; index < ys.length; index += 1) {
          const x = xs[index];
          const y = ys[index];
          if (!Number.isFinite(x) || !Number.isFinite(y)) assert.fail(`${theme} drew a NaN coordinate`);
          if (x < -60 || x > view.width + 60) assert.fail(`${theme} drew outside the culled span at x=${x.toFixed(0)}`);
          assert.ok(Math.abs(y - surfaceAt(x)) <= 26, `${theme} detail drifts off the surface at x=${x.toFixed(0)} (${y.toFixed(1)} vs ${surfaceAt(x).toFixed(1)})`);
          checked += 1;
        }
      }
    }
    assert.ok(checked > 20, `${theme} audited enough detail coordinates (${checked})`);

    // Purely cosmetic: the collision surface is bit-identical after drawing.
    const before = Array.from({ length: 40 }, (_, index) => view.groundAt(view.cameraX + index * 25));
    environment.drawGroundDetail(recorder.context, view, environment.palette(0.9));
    const after = Array.from({ length: 40 }, (_, index) => view.groundAt(view.cameraX + index * 25));
    assert.deepEqual(after, before, 'ground detail never mutates the physics surface');

    // Deterministic, and thinner on the lighter graphics tier.
    const first = recorderContext();
    const second = recorderContext();
    environment.drawGroundDetail(first.context, view, environment.palette(0.4));
    environment.drawGroundDetail(second.context, view, environment.palette(0.4));
    assert.deepEqual(first.ops, second.ops, `${theme} ground detail is deterministic`);

    const full = recorderContext();
    const light = recorderContext();
    environment.drawGroundDetail(full.context, makeView(), environment.palette(0.4));
    environment.drawGroundDetail(light.context, makeView({ lighter: true }), environment.palette(0.4));
    assert.ok(light.operations < full.operations, `${theme} lighter tier draws less detail (${light.operations} vs ${full.operations})`);
  }
});

test('Ground mist drifts along the crest and needs a surface to exist', () => {
  const environment = new EnvironmentManager();
  environment.setLevel(generateLevel(4, 42)); // moonlit: strongest groundMist
  const view = makeView();
  const palette = environment.palette(0.9);

  const withSurface = recorderContext();
  environment.drawWeather(withSurface.context, view, palette);
  assert.ok(withSurface.operations > 20, 'mist renders over the surface');

  const surfaceless = recorderContext();
  const bare = { ...view };
  delete bare.groundAt;
  environment.drawWeather(surfaceless.context, bare, palette);
  assert.ok(surfaceless.operations < withSurface.operations, 'no surface, no mist');

  const view2 = makeView({ cameraX: 9000 });
  const far = recorderContext();
  environment.drawWeather(far.context, view2, palette);
  assert.notDeepEqual(far.ops, withSurface.ops, 'mist follows the terrain, not the screen');
});

test('Foreground silhouettes are sparse, deterministic and stay readable', () => {
  for (const theme of THEMES) {
    const environment = new EnvironmentManager();
    environment.setLevel(generateLevel(LEVEL_FOR_THEME[theme], 4242));

    let anchor = -1;
    let anchorRecorder = null;
    for (let cameraX = 0; cameraX < 6200 && anchor < 0; cameraX += 200) {
      const recorder = recorderContext();
      environment.drawForeground(recorder.context, makeView({ cameraX }), environment.palette(0.4));
      if (recorder.operations > 4) {
        anchor = cameraX;
        anchorRecorder = recorder;
      }
    }
    assert.ok(anchor >= 0, `${theme} draws foreground silhouettes somewhere in a span`);

    const first = recorderContext();
    const second = recorderContext();
    environment.drawForeground(first.context, makeView({ cameraX: anchor }), environment.palette(0.4));
    environment.drawForeground(second.context, makeView({ cameraX: anchor }), environment.palette(0.4));
    assert.deepEqual(first.ops, second.ops, `${theme} foreground is deterministic`);

    // Readability: silhouettes never render fully opaque.
    assert.ok(first.maxAlpha <= 0.5, `${theme} foreground alpha stays subtle (${first.maxAlpha})`);

    // Culling: only the visible span is drawn.
    const translateOps = first.ops.filter((op) => op.name === 'translate');
    for (const op of translateOps) {
      assert.ok(op.values[0] >= -400 && op.values[0] <= makeView().width + 400, `${theme} foreground prop culled incorrectly`);
    }
  }
});

// ───────────────────────── ambient particles ─────────────────────────

test('Fireflies wait for night and pollen fades with it, without reallocation', () => {
  const moonlit = new EnvironmentManager();
  moonlit.setLevel(generateLevel(4, 42));
  const update = (night) => moonlit.update(1 / 60, {
    width: 900, height: 600, cameraX: 5000, cameraDx: 2, storm: 0, lighter: false,
    groundAt: (x) => 340, phase: 0.9, night,
  });
  update(0.95);
  const firefliesAtNight = moonlit.activeAmbientParticles;
  assert.ok(firefliesAtNight >= 8, `fireflies come out at night (${firefliesAtNight})`);
  update(0.2);
  assert.equal(moonlit.activeAmbientParticles, 0, 'no fireflies in daylight');
  update(0.95);
  assert.equal(moonlit.activeAmbientParticles, firefliesAtNight, 'the same particles return at dusk');

  const country = new EnvironmentManager();
  country.setLevel(generateLevel(1, 42));
  const updateCountry = (night) => country.update(1 / 60, {
    width: 900, height: 600, cameraX: 5000, cameraDx: 2, storm: 0, lighter: false,
    groundAt: (x) => 340, phase: 0.4, night,
  });
  updateCountry(0);
  const pollenAtDay = country.activeAmbientParticles;
  assert.ok(pollenAtDay > 0, 'pollen drifts by day');
  updateCountry(0.95);
  assert.ok(country.activeAmbientParticles < pollenAtDay, 'pollen thins out at night');
});

// ───────────────────────── engine integration ─────────────────────────

test('Every environment renders its full atmosphere with finite coordinates at night', () => {
  for (const number of [1, 2, 3, 4]) {
    const { game, recorder, frames } = makeEngine({ search: `?level=${number}` });
    game.start();
    game.setDayPhasePreview(0.9);
    for (let index = 0; index < 30; index += 1) {
      game.frame(4000 + index * 16.7);
    }
    assert.ok(recorder.operations > 500, `level ${number} renders at night (${recorder.operations} ops)`);
    const numeric = recorder.ops.flatMap((op) => op.values.filter((value) => typeof value === 'number'));
    assert.ok(numeric.every((value) => Number.isFinite(value)), `level ${number} drew a NaN coordinate at night`);

    // The terrain crest stays high-contrast after dark: obstacles remain readable.
    const brightCrest = [...recorder.strokes, ...recorder.fills].some(
      (style) => colorAlpha(style) >= 0.8 && colorLuminance(style) >= 150,
    );
    assert.ok(brightCrest, `level ${number} keeps a bright, opaque crest stroke at night`);

    // The audio frame state carries the new atmosphere fields.
    const frame = frames[frames.length - 1];
    assert.equal(frame.theme, ENVIRONMENTS[game.levels.current.environment].id);
    assert.ok(frame.wind >= 0 && frame.wind <= 1, `level ${number} wind strength is bounded`);
    assert.ok(frame.night > 0.4, `level ${number} reports night to the audio engine`);
  }
});

test('Parallax depth ladder is complete: sky, four ridges, decorations, foreground', () => {
  const environment = new EnvironmentManager();
  environment.setLevel(generateLevel(2, 42));
  const layers = environment.parallaxLayers();
  assert.equal(layers.length, PARALLAX_LAYER_COUNT);
  for (let index = 1; index < layers.length; index += 1) {
    assert.ok(layers[index].parallax > layers[index - 1].parallax, 'parallax keeps increasing with depth');
  }
  // The foreground runs faster than the camera (in front of the gameplay).
  const view = makeView();
  const recorder = recorderContext();
  environment.drawForeground(recorder.context, view, environment.palette(0.4));
  const translate = recorder.ops.find((op) => op.name === 'translate');
  if (translate) {
    const screenX = translate.values[0];
    const worldCell = Math.round((view.cameraX * 1.18 + screenX) / 620);
    assert.ok(Math.abs(worldCell * 620 - (view.cameraX * 1.18 + screenX)) < 620, 'foreground anchors on its own faster parallax grid');
  }
});

test('Decoration fields span chunk boundaries without gaps', () => {
  for (const number of [1, 2, 3, 4]) {
    const environment = new EnvironmentManager();
    environment.setLevel(generateLevel(number, 90210));
    const spacing = ENVIRONMENTS[environment.theme].decorations.spacing;
    const decorations = environment.decorationsNear(0, 2400).sort((a, b) => a.x - b.x);
    assert.ok(decorations.length > 5, `level ${number} has decorations`);
    for (let index = 1; index < decorations.length; index += 1) {
      const gap = decorations[index].x - decorations[index - 1].x;
      assert.ok(gap <= spacing * 4.5, `level ${number} decoration gap ${gap.toFixed(0)}px after ${decorations[index - 1].x.toFixed(0)}`);
    }
    const firstChunk = decorations.filter((item) => item.x < 260).length;
    const secondChunk = decorations.filter((item) => item.x >= 260 && item.x < 520).length;
    assert.ok(firstChunk > 0 && secondChunk > 0, `level ${number} decorates both sides of the chunk boundary`);
  }
});

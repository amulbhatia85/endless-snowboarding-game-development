/**
 * Menu attract-scene rider placement (refinement follow-up).
 *
 * The idle rider on the main menu used to render at 72% of the width on the
 * gameplay ground line (60.5% of height) — directly behind the nav stack on
 * phones. The engine now rides a UI-aware attract horizon. These assertions
 * pin the rider's drawn anchor to the open band the menu's real CSS leaves,
 * measured in the rendered game (browser QA, 2026-11):
 *   - 390x844 portrait: copy block ends at y=336, nav stack starts y=394;
 *   - 844x390 landscape: tagline ends y=253, nav column starts x=451;
 *   - 1280x800 desktop: copy block ends y=543, nav column starts x=817.
 * The rider sprite extends ~28px above its anchor and ~3px below. The damped
 * attract noise (0.12 x the ±70px terrain envelope = ±8.4px) is accounted
 * for in the fraction choice, so per-frame anchors only add the sprite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleUrl } from './loadTypeScript.mjs';

const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

const SPRITE_ABOVE = 28;
const SPRITE_BELOW = 3;

function storage(values = new Map()) {
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); } };
}

/** Records context ops so the rider's drawn anchor can be found:
 *  drawRider is the only pass that emits translate(0, WHEEL_CONTACT_Y=5)
 *  immediately followed by scale(BIKE_SCALE=0.5); the translate before the
 *  rotate in that block is the rider's anchor. */
function pairRecorder() {
  const ops = [];
  const gradient = { addColorStop() {} };
  const handler = {
    get(target, prop) {
      if (prop in target) return target[prop];
      return (...args) => { ops.push([prop, args]); };
    },
    set() { return true; },
  };
  const context = new Proxy({
    canvas: null,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => ({}),
    measureText: () => ({ width: 12 }),
    translate: (x, y) => ops.push(['translate', [x, y]]),
    scale: (x, y) => ops.push(['scale', [x, y]]),
  }, handler);
  return { context, ops };
}

function makeMenuEngine(W, H) {
  globalThis.localStorage = storage();
  globalThis.window = {
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {}, location: { search: '' }, devicePixelRatio: 1,
  };
  const recorder = pairRecorder();
  const fakeCanvas = (cw, ch) => ({
    width: 0, height: 0, style: {},
    clientWidth: cw, clientHeight: ch,
    addEventListener() {}, removeEventListener() {},
    getBoundingClientRect: () => ({ width: cw, height: ch, left: 0, top: 0, right: cw, bottom: ch }),
    getContext: () => pairRecorder().context,
  });
  globalThis.document = { createElement: () => fakeCanvas(192, 192) };
  const canvas = fakeCanvas(W, H);
  canvas.getContext = () => recorder.context;
  const game = new SnowGameEngine(canvas, { onStatus() {}, onHud() {}, onGameOver() {}, onCrash() {}, onSound() {} });
  return { game, recorder };
}

/** Anchor of the rider's draw transform in the latest recorded frame. */
function riderAnchor(recorder) {
  const { ops } = recorder;
  for (let i = 0; i < ops.length - 1; i += 1) {
    if (ops[i][0] === 'translate' && ops[i][1][0] === 0 && ops[i][1][1] === 5
      && ops[i + 1][0] === 'scale' && ops[i + 1][1][0] === 0.5) {
      for (let j = i - 1; j >= 0; j -= 1) {
        if (ops[j][0] === 'translate') return { x: ops[j][1][0], y: ops[j][1][1] };
      }
    }
  }
  return null;
}

function driftMenu(game, recorder, frames) {
  const anchors = [];
  for (let i = 0; i < frames; i += 1) {
    recorder.ops.length = 0;
    game.frame(1000 + i * 16.7);
    const anchor = riderAnchor(recorder);
    if (anchor) anchors.push(anchor);
  }
  return anchors;
}

test('menu attract rider sits in the open band on every measured layout', () => {
  const layouts = [
    // [W, H, copyRect, navRect, fraction] — rectangles from the rendered
    // menu's real CSS (browser QA, 2026-11).
    [390, 844, [22, 104, 368, 336], [22, 394, 368, 804], 0.455],   // iPhone portrait
    [844, 390, [31, 185, 425, 253], [451, 123, 810, 345], 0.79],   // iPhone landscape
    [1280, 800, [134, 287, 769, 543], [817, 204, 1146, 626], 0.79], // desktop side-by-side
  ];
  for (const [W, H, copyRect, navRect, fraction] of layouts) {
    const { game, recorder } = makeMenuEngine(W, H);
    assert.equal(game.status, 'menu', 'fresh engine starts on the menu');
    const anchors = driftMenu(game, recorder, 90);
    assert.ok(anchors.length >= 60, `rider drawn every frame (${anchors.length}/90, ${W}x${H})`);
    const ys = anchors.map((a) => a.y);
    // The damped-noise envelope: anchors stay within ±8.4 of the fraction line.
    const line = fraction * H - 5;
    assert.ok(Math.min(...ys) >= line - 8.5, `min anchor y ${Math.min(...ys).toFixed(1)} inside the damped envelope (${W}x${H})`);
    assert.ok(Math.max(...ys) <= line + 8.5, `max anchor y ${Math.max(...ys).toFixed(1)} inside the damped envelope (${W}x${H})`);
    const blocks = [['copy', copyRect], ['nav', navRect]];
    for (const anchor of anchors) {
      const expectedX = W * 0.30;
      assert.ok(Math.abs(anchor.x - expectedX) < 1.5, `rider x ${anchor.x.toFixed(1)} ≈ 30% of ${W}`);
      assert.ok(anchor.x - 15 >= 16, `rider clear of the left safe padding (${W}x${H})`);
      const top = anchor.y - SPRITE_ABOVE;
      const bottom = anchor.y + SPRITE_BELOW;
      assert.ok(bottom <= H - 8, `rider inside the screen (${W}x${H})`);
      for (const [name, [left, blockTop, right, blockBottom]] of blocks) {
        const overlapsX = anchor.x - 15 < right && anchor.x + 15 > left;
        if (!overlapsX) continue;
        assert.ok(bottom <= blockTop || top >= blockBottom,
          `rider clear of the ${name} block (${W}x${H}): rider ${top.toFixed(1)}-${bottom.toFixed(1)} vs block ${blockTop}-${blockBottom}`);
      }
    }
  }
});

test('attract horizon is a display line; terrainAt stays on the gameplay line', () => {
  const { game, recorder } = makeMenuEngine(390, 844);
  // Even while the menu is showing, the collision/save surface is gameplay.
  const sampled = game.terrainAt(12345);
  const rawNoise = game.terrain.heightAt(12345);
  assert.ok(Math.abs(sampled - (0.605 * 844 + rawNoise)) < 0.01,
    'terrainAt samples the gameplay line regardless of menu status');
  // The drawn rider, though, rides the attract surface.
  recorder.ops.length = 0;
  game.frame(1000);
  const anchor = riderAnchor(recorder);
  assert.ok(anchor, 'menu frame drew the rider');
  assert.ok(Math.abs(anchor.y - (0.455 * 844 - 5)) <= 8.5, `menu rider anchor ${anchor.y.toFixed(1)} on the attract line`);
  // Entering a run spawns the rider on the gameplay ground.
  game.start();
  const spawnGround = game.terrainAt(0);
  assert.ok(Math.abs(spawnGround - 0.605 * 844) < 0.01, `spawn ground ${spawnGround.toFixed(1)} on the gameplay line (x=0 has no noise)`);
  assert.ok(Math.abs(game.run.rider.y - (spawnGround - 5)) < 0.01, 'fresh rider spawns on the gameplay ground');
});

test('a parked run keeps its gameplay line while the menu shows the attract scene', () => {
  const { game, recorder } = makeMenuEngine(844, 390);
  game.start();
  game.frame(2000);
  const beforeY = game.run.rider.y;
  game.suspendToMenu();
  // A resize while parked re-snaps to the *gameplay* line — the rider keeps
  // its position (no attract-line corruption of parked state).
  game.handleResize();
  assert.ok(Math.abs(game.run.rider.y - beforeY) < 1e-6, 'parked rider untouched by resize in menu');
  // The menu drift scene still draws the rider on the attract line.
  recorder.ops.length = 0;
  game.frame(2016.7);
  const anchor = riderAnchor(recorder);
  assert.ok(anchor, 'parked menu frame drew the rider');
  assert.ok(Math.abs(anchor.y - (0.79 * 390 - 5)) <= 8.5, `parked-menu rider anchor ${anchor.y.toFixed(1)} on the attract line`);
  game.resumeParkedRun();
  const rawNoise = game.terrain.heightAt(5000);
  assert.ok(Math.abs(game.terrainAt(5000) - (0.605 * 390 + rawNoise)) < 0.01, 'resumed run back on the gameplay line');
});

test('setAttractBand centres the rider in the measured corridor and damps noise to its headroom', () => {
  const { game, recorder } = makeMenuEngine(390, 844);
  // The real 390x844 menu leaves y 336..394 free in the rider's column.
  game.setAttractBand(336, 394);
  recorder.ops.length = 0;
  game.frame(1000);
  const anchors = driftMenu(game, recorder, 40);
  assert.ok(anchors.length >= 30, 'rider drawn every frame');
  const anchorY = (Math.min(...anchors.map(a => a.y)) + Math.max(...anchors.map(a => a.y))) / 2;
  // Sprite span is 28 above / 3 below the anchor; the band is 58px, so the
  // anchor sits at the band centre biased for the sprite (±14.5 headroom)
  // and the damped noise stays inside that headroom.
  const expected = (336 + 28 + 394 - 3) / 2;
  assert.ok(Math.abs(anchorY - expected) < 0.5, `anchor ${anchorY.toFixed(1)} centred in the band (expected ${expected.toFixed(1)})`);
  const spread = Math.max(...anchors.map(a => a.y)) - Math.min(...anchors.map(a => a.y));
  assert.ok(spread <= 14.5 * 2 + 1, `noise spread ${spread.toFixed(1)}px stays inside the band headroom`);
  for (const a of anchors) {
    assert.ok(a.y - SPRITE_ABOVE >= 336 - 0.5 && a.y + SPRITE_BELOW <= 394 + 0.5, `rider inside the corridor (${a.y.toFixed(1)})`);
  }
  // A too-narrow corridor degrades gracefully: the rider clamps to its
  // bottom edge with the noise fully damped (no oscillation into the UI).
  game.setAttractBand(200, 220);
  const tight = driftMenu(game, recorder, 30);
  assert.ok(tight.length >= 20, 'rider still drawn');
  const tightSpread = Math.max(...tight.map(a => a.y)) - Math.min(...tight.map(a => a.y));
  assert.ok(tightSpread < 0.01, `noise fully damped in a tight corridor (spread ${tightSpread.toFixed(2)})`);
  for (const a of tight) assert.ok(a.y + SPRITE_BELOW <= 220 + 0.01, 'tight-corridor rider stays at the bottom edge');
  // terrainAt is never affected by the band.
  const rawNoise = game.terrain.heightAt(777);
  assert.ok(Math.abs(game.terrainAt(777) - (0.605 * 844 + rawNoise)) < 0.01, 'terrainAt stays on the gameplay line');
});

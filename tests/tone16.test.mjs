import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 16 — the dusk tone grade.
//
// Afterglow's art direction is dusk, so every colour the environment hands to
// the renderer passes through one grade. These tests pin the behaviour that
// matters: the world gets darker, nothing crushes to black or blows out to
// white, and the grade is theme-agnostic so cross-fades never pop.

const { generateLevel } = await import(moduleUrl('src/game/levelManager.ts'));
const { EnvironmentManager, TONE_GRADE, toneGrade } = await import(moduleUrl('src/game/environment.ts'));

const channels = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number);
const luminance = (color) => {
  const [r, g, b] = channels(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

// Levels whose themes differ, found by scanning seeds: 1 countryside,
// 2 snowy-mountains, 3 misty-mountains, 4 moonlit-forest, 17 jungle.
const LEVELS = [1, 2, 3, 4, 17];
const COLOR_KEYS = ['top', 'horizon', 'far', 'middle', 'near', 'snow', 'snowShade'];

test('every theme is graded darker than the raw palette would be', () => {
  for (const level of LEVELS) {
    const environment = new EnvironmentManager();
    environment.setLevel(generateLevel(level, 4242));
    const palette = environment.palette(0.4);
    for (const key of COLOR_KEYS) {
      const value = channels(palette[key]);
      // The grade always pulls a colour down except where it is already deeper
      // than the floor, in which case it lifts it out of pure black.
      assert.ok(value.every((channel) => channel <= 255), `${level}/${key} stays in range`);
      assert.ok(luminance(palette[key]) <= 214, `${level}/${key} respects the ceiling (${palette[key]})`);
    }
  }
});

test('the grade never crushes the world to black', () => {
  // Pure black in must come out as visible shadow, not zero.
  const graded = toneGrade('#000000');
  assert.ok(channels(graded).every((channel) => channel >= 4), `shadows keep detail (${graded})`);
  // And the very brightest input still lands under the per-channel ceiling.
  const bright = channels(toneGrade('#ffffff'));
  const ceiling = [TONE_GRADE.ceiling.r, TONE_GRADE.ceiling.g, TONE_GRADE.ceiling.b];
  assert.ok(bright.every((channel, i) => channel <= ceiling[i]), `highlights are held (${bright.join(', ')})`);
});

test('the grade warms shadows toward blue rather than turning the world grey', () => {
  // Blue is scaled the gentlest, so an equal-grey input comes out blue-leaning.
  const [r, g, b] = channels(toneGrade('#808080'));
  assert.ok(b > r, `shadow cast stays cool (${r}, ${g}, ${b})`);
  assert.ok(b > g, `shadow cast stays cool (${r}, ${g}, ${b})`);
});

test('strength interpolates so callers can soften the grade locally', () => {
  // hex is not rgb() text, so expand it before reading channels back
  const input = [255, 207, 150];
  const none = channels(toneGrade('#ffcf96', 0));
  const full = channels(toneGrade('#ffcf96', 1));
  const half = channels(toneGrade('#ffcf96', 0.5));
  assert.deepEqual(none, input, 'strength 0 is a no-op');
  for (let i = 0; i < 3; i += 1) {
    assert.ok(half[i] > full[i] && half[i] < none[i], `channel ${i} sits between the two`);
  }
});

test('night still reads through the grade across the whole cycle', () => {
  for (const level of LEVELS) {
    const environment = new EnvironmentManager();
    environment.setLevel(generateLevel(level, 4242));
    assert.ok(environment.palette(0.4).night <= 0.45, `${level} keeps daylight at phase 0.4`);
    assert.ok(environment.palette(0.9).night >= 0.5, `${level} still reaches night at phase 0.9`);
  }
});

test('the grade preserves theme identity: snow stays the brightest ground', () => {
  const snow = new EnvironmentManager();
  snow.setLevel(generateLevel(2, 4242));
  const snowLum = luminance(snow.palette(0.4).snow);

  for (const level of [1, 17]) {
    const other = new EnvironmentManager();
    other.setLevel(generateLevel(level, 4242));
    assert.ok(
      luminance(other.palette(0.4).snow) < snowLum,
      `snowy ground stays brighter than level ${level}`,
    );
  }
  assert.ok(snowLum > 160, `snow stays bright under dusk light (${snowLum.toFixed(0)})`);
});

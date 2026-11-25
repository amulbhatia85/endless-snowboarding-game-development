import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { moduleUrl } from './loadTypeScript.mjs';

// Phase 17 — menu legibility.
//
// Two defects shipped together and both were invisible to the existing suite,
// because the suite cannot see CSS cascade or canvas pixels:
//
//  1. The rider is a dark silhouette on now-graded-dark snow, so it needed a
//     permanent light rim. The rim is built from the rider's own body mask, so
//     it must be registered with the body — a stale or missing mask would draw
//     a halo around the wrong shape.
//  2. A new two-class `.screen-menu .menu-button` rule outranked the older
//     single-class `.menu-play` rule: Play kept its dark navy text but lost its
//     amber fill, so the label vanished into the dark menu.

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '..', 'src', 'index.css'), 'utf8');
const engineSource = readFileSync(join(here, '..', 'src', 'game', 'engine.ts'), 'utf8');

const { SnowGameEngine } = await import(moduleUrl('src/game/engine.ts'));

/** Count selector specificity as (ids, classes, elements). */
function specificity(selector) {
  const classes = (selector.match(/\./g) ?? []).length;
  const pseudos = (selector.match(/:(?!:)/g) ?? []).length;
  return classes + pseudos;
}

function ruleBodies(text) {
  // Flattens "@media" nesting away; enough to inspect declarations by selector.
  return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selector, body]) => ({ selector: selector.trim().split('\n').pop().trim(), body }))
    .filter((rule) => rule.selector.includes('.menu-play') || rule.selector.includes('.menu-button'));
}

test('the Play button keeps an amber fill, not the dark glass of the other buttons', () => {
  const rules = ruleBodies(css).filter((rule) => rule.selector.includes('.menu-play') && !rule.selector.includes(':hover'));

  const base = rules.find((rule) => rule.selector === '.menu-play');
  assert.ok(base, 'the original .menu-play rule is still present');
  assert.match(base.body, /#f0c896/, 'Play still carries its amber base fill');

  // The dark glass may only be applied through a selector that explicitly
  // excludes Play. Any rule matching Play without that guard is the bug.
  const menuScoped = rules.filter((rule) => rule.selector.startsWith('.screen-menu'));
  assert.ok(menuScoped.length > 0, 'menu-scoped button rules exist');
  for (const rule of menuScoped) {
    const darkGlass = /#0d2033|rgba\(7, 18, 30, 0\.78\)/.test(rule.body);
    if (!darkGlass) continue;
    assert.ok(
      rule.selector.includes(':not(.menu-play)'),
      `"${rule.selector}" paints dark glass and must exclude Play`,
    );
  }
});

test('Play sets its label to pure white so it separates from the amber', () => {
  const strongRule = ruleBodies(css).find((rule) => rule.selector === '.screen-menu .menu-play strong');
  assert.ok(strongRule, 'Play has an explicit label-colour rule');
  assert.match(strongRule.body, /color:\s*#ffffff/, 'Play label is white');

  // And no menu-scoped rule re-darkens it.
  const darkening = ruleBodies(css).filter(
    (rule) => rule.selector.includes('.menu-play') && /color:\s*#?(23384a|142839|33485b|23384)/i.test(rule.body),
  );
  for (const rule of darkening) {
    assert.ok(
      !rule.selector.startsWith('.screen-menu'),
      `menu-scoped rule "${rule.selector}" must not set the Play label back to dark navy`,
    );
  }
});

test('the Play override outranks the generic menu-button styling', () => {
  // .screen-menu .menu-button = the two-class rule that beat the original
  // one-class Play rule and caused the bug.
  const generic = specificity('.screen-menu .menu-button');
  const play = specificity('.screen-menu .menu-button.menu-play');
  assert.ok(play > generic, `Play override (${play}) must beat the generic rule (${generic})`);

  // The label rule only has to beat the base `.menu-button` colour rule.
  const label = specificity('.screen-menu .menu-play strong');
  assert.ok(label > specificity('.menu-button'), `label rule (${label}) beats the base rule`);
});

test('the rider halo is drawn behind the body, every frame, and registered to it', () => {
  assert.match(engineSource, /drawRiderHalo\(/, 'a halo pass exists');
  assert.match(
    engineSource,
    /this\.drawRiderHalo\(context, grounded, idle, airTime, bob\);\s*\n\s*if \(strength > 0\) this\.drawRiderOutline/,
    'the halo is drawn before the optional power-up outline, and unconditionally',
  );
  assert.match(
    engineSource,
    /this\.drawRiderBodyMask\(maskContext, grounded, idle, airTime, bob\)/,
    'the halo mask is built from the live body pose, so it cannot drift out of register',
  );
  // The mask must be rebuilt from the same body-drawing call the rider uses.
  const maskFn = engineSource.slice(engineSource.indexOf('private drawRiderBodyMask'));
  assert.match(maskFn.slice(0, 400), /this\.drawRiderBody\(/, 'the mask reuses drawRiderBody');
});

function stubContext() {
  return new Proxy({}, { get: (target, key) => (key in target ? target[key] : () => {}), set: () => true });
}

test('the halo is a no-op, not a crash, when no 2D context is available', () => {
  const previous = globalThis.document;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => null }) };
  try {
    const engine = Object.create(SnowGameEngine.prototype);
    engine.riderOutline = undefined;
    assert.doesNotThrow(() => engine.drawRiderHalo(stubContext(), true, true, 0, 0));
  } finally {
    globalThis.document = previous;
  }
});

test('with a context available the halo builds its mask and backdrop once, then reuses them', () => {
  const created = [];
  const previous = globalThis.document;
  globalThis.document = {
    createElement: () => {
      const canvas = { width: 0, height: 0, getContext: () => stubContext() };
      created.push(canvas);
      return canvas;
    },
  };
  try {
    const engine = Object.create(SnowGameEngine.prototype);
    engine.riderOutline = undefined;
    engine.suspension = 0;
    engine.clock = 0;
    engine.character = { coat: '#1f3350', scarf: '#e06a4f', cap: '#f0c896', sleeve: '#2b4463' };
    engine.drawRiderHalo(stubContext(), true, true, 0, 0);
    assert.ok(engine.riderOutline, 'the halo cache is populated');
    assert.equal(created.length, 3, 'mask, glow and backdrop surfaces are allocated');
    const first = engine.riderOutline;
    engine.drawRiderHalo(stubContext(), true, true, 0, 0);
    assert.equal(engine.riderOutline, first, 'the second frame reuses the cache instead of reallocating');
  } finally {
    globalThis.document = previous;
  }
});

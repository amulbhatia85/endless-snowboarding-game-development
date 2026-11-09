# Crash, Revive, Checkpoint & Game Recovery (Phase 8)

A recovery layer built on the existing crash physics, rewarded-ad service,
checkpoint saves and state machine. Nothing about terrain, difficulty,
transitions, rewards or controls changes.

## What was already there (reused, unchanged in spirit)

- **Crash detection** — obstacle collisions (`checkCollision`), gap falls
  (`fallingInto` + below-terrain), unsafe landings (angle/spin limits in
  `land()`). `finishRun` is idempotent (`if (run.over) return`), so one fatal
  event can only ever produce one crash and one game-over. Ordinary jumps,
  flips and recoverable landings never crash.
- **Revive gating** — `reviveAvailable` is true only for `status === 'crashed'
  && run.over`; cinematics (house entry/exit/completion) run in `playing` with
  `over === false`, so reviving mid-transition is impossible.
- **Rewarded ads** — `AdService.showRewarded()` resolves true only after the
  SDK `Rewarded` *and* `Dismissed` events; sessions are single-flight with
  settled flags; `FailedToShow` settles false; interstitials fire at most
  every 3rd completed run with a 90 s floor, and only from the game-over
  screen — never during cinematics. Google test IDs in development,
  production placeholders preserved.
- **App-side revive flow** — `adBusy` + `pendingReviveRef` prevent concurrent
  or replayed reward callbacks; the pending revive defers until the app is
  visible/active again (mobile backgrounding and tab switches are safe).
- **Checkpoints** — every 3 s of safe riding (`saveStableCheckpoint`): only
  while riding, grounded, not over a gap/ramp, outside every hazard's warning
  window and 80 px danger radius. Full generation state
  (terrain origins, cursors, scores) is stored, validated on load, and stays
  separate from level completion.

## New in Phase 8

| Feature | Where |
|---|---|
| **Crash tumble** — a brief, cosmetic, physics-flavoured reaction: the rider pops over the bars, slides, spins and settles. Score is frozen, the camera never moves, the slide stops against obstacles, and gap victims keep falling. | `finishRun` + `updateEffects`, tuned by `RECOVERY_CONFIG` |
| **Smooth revive camera** — 60 % of the correction applied instantly, the regular smoothed follow finishes the ease (no snap, no jump). | `revive()` |
| **Configurable protection** — revive invulnerability (3 s) moved into `RECOVERY_CONFIG`. It blocks obstacle collisions only; **gaps stay fatal** by design. | `src/game/recovery.ts` |
| **Crash screen: level + restart** — the overlay now shows LEVEL N · name and offers **Restart Level** next to Revive / End Run. | `src/App.tsx` |
| **Restart-from-crash path** — finalizes the run exactly once first (coins banked, score recorded, achievements settled, interstitial frequency honoured), then restarts the current level from its beginning with a clean attempt. | `restartFromCrash` |
| **Checkpoint hardening** — checkpoints containing a crash tumble are rejected on load (riding-only states, defensively enforced). | `isRunCheckpoint` |
| **Deterministic terrain tests** — the terrain suite's default engine is now pre-seeded (the hazard-corridor test was seed-random and flaky). | `tests/terrain.test.mjs` |

## Configuration (`src/game/recovery.ts`)

```ts
reviveInvulnerabilitySeconds: 3     // protection window after revive
crashTumbleSeconds: 0.9             // tumble animation length
crashTumbleSlideFactor: 0.55        // fraction of speed kept in the slide
crashTumblePopVelocity: -170        // upward pop on ground crashes
crashTumbleSpin: 4.6                // over-the-bars rotation (rad/s)
crashTumbleSlideDecay: 3.4          // exponential slide decay
crashTumbleSpinDecay: 2.4           // exponential spin decay
reviveCameraCatchUp: 0.6            // instant share of the camera correction
```

## Tests (`npm run test:recovery`, 14 tests)

1. One crash / one game-over per fatal event; ordinary jumps never crash
2. Gaps stay fatal during revive protection
3. Tumble is physical, settles, camera never moves
4. Revive only for genuinely ended runs, never twice simultaneously, never mid-cinematic
5. Revived riders spawn clear of hazards/gaps, aligned, protected, camera eased
6. Protection blocks collisions, expires, no repeated events
7. Speed and controls return to normal after revive (no slow-motion)
8. Restart from crash resets the attempt, preserves progression and wallet
9. Checkpoints avoid danger windows and match the terrain on reload
10. No reward duplication across crash → revive → restart cycles
11. Level completion still works after a mid-level revive
12. Six crash/revive cycles leak nothing (bounded objects/particles)
13. Pause/resume safe around crashes and protection
14. Ads never reward without a completed native reward session; every-3rd-run frequency verified

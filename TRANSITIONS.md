# Level Transitions — Cinematic House Arrival (Phase 6)

When a run reaches the 50,000-point level target, the level resolves through a
short cinematic instead of a hard cut. The rider glides up to a safe house,
steps inside, the door closes, a completion card fades in, and the next level
begins with the rider stepping back out of the same house into a new
environment.

## State machine

```
riding ──target + grounded──▶ approach ──▶ entering ──▶ celebrating ──▶ exiting ──▶ riding
                                (decelerate   (eased glide   (completion    (door reopens,
                                 to the door,  through the    card, door     speed ramps up,
                                 door opens)   open door,     closes)        fade-in, ride out)
                                 terrain       rider fades
                                 flattens)     to 0)
```

Everything runs through the existing `stepLevelScene` pipeline inside the
engine's fixed-step loop — no new managers.

| Phase | Duration | What happens |
|---|---|---|
| `approach` | distance-based | House spawns **≥ 1.05 screen widths ahead** (never pops in), terrain blends to a flat runway over ~380 px, obstacles ahead are cleared, speed eases down toward the door. The front door swings open over the final 240 px. |
| `entering` | `transitions.end.entrySeconds` | Eased 23 px glide through the doorway; `riderOpacity` 1 → 0. On completion: score sync, `markSafeHouseReached()`, environment cross-fade begins. |
| `celebrating` | `transitions.end.completionSeconds` (3.1 s) | Rider hidden, door closes behind them. **LEVEL N COMPLETED** card with a `TAP TO CONTINUE` hint (fades in after a 1.1 s grace window; a press then skips the wait). |
| `exiting` | `transitions.start.seconds` (2.4 s) | Level advances (`advanceAfterTransition` — persisted, level score zeroed), door reopens, rider fades back in and accelerates out; obstacle/coin generation resumes ahead of the rider. Door closes once they are clear. |

## Safety properties (all test-enforced — `npm run test:transition`)

- **No pop-in / teleporting** — the house always spawns off the right edge; rider
  movement is monotonic with per-frame steps bounded at 120 fps.
- **Controls & spawning disabled** during every cinematic phase: `press()`,
  `populateAhead`, checkpoints and collisions all early-return unless
  `levelPhase === 'riding'`. The completion-skip press is the one deliberate
  exception and only after the grace window.
- **Exactly one completion** — `markSafeHouseReached()` is idempotent,
  `advanceAfterTransition()` throws unless target + safe house are both
  recorded, `completedThrough` is written once, and the HUD reports exactly one
  `celebrating` phase.
- **Persistence only after completion** — nothing is saved while approaching,
  entering or celebrating. A reload mid-cinematic resumes the last stable
  *riding* checkpoint (the level replays); a reload during `exiting` resumes
  the already-advanced next level. Pausing freezes the scene and resumes it.
- **Continuous world** — the global day/night cycle (`(0.62 + (worldX +
  clock·18)/25500) % 1`) never resets across levels; the environment
  cross-fades over `celebrating → exiting` so the new theme is fully blended
  by the time the rider rides out.
- **Score continuity** — the new level's score starts at 0 while the lifetime
  and run totals keep accumulating.

## House art

One recognizable cabin design reused across environments with themed
variations: warm glowing cross-frame window and round attic window, hinged
front door with knob, chimney smoke, ambient halo. `snowy-mountains` adds roof
snow, icicles and drifts; `moonlit-forest` / `misty-mountains` add a flickering
lantern post. The theme is taken from the *old* level during
approach→celebrating and from the *new* level during exiting; the environment
cross-fade handles the hand-off. Culling: ±170 px around the door.

## Developer tools

- **`?dev=1` level bar → “⏭ Finish level”** — tops the level score up to the
  target so the natural cinematic runs immediately (no 50 k grind, nothing
  saved that the sandbox doesn't already isolate — `startLevelPreview` uses
  in-memory storage).
- **`engine.devFinishLevel()`** — the same trigger programmatically; returns
  `false` unless a run is active and in normal riding play.

## Tests

`npm run test:transition` (8 tests) drives the real engine (fixed steps +
environment update + draw at 120 fps, seeded saves):

1. L1 completes at the target; house spawns off-screen, terrain smooth, no hazards ahead.
2. Entry telemetry: exact phase order, monotonic bounded steps, gradual fades, rider inside the doorway, no hazard spawns, rendering alive.
3. Door animation: open on approach → open through entry → closed behind → reopened for exit → closed after.
4. Completion fires once; early taps ignored; post-grace press continues; checkpoint frozen during the celebration and cleared by the advance.
5. L2 loads snowy with a natural accelerating exit, score reset, palette switch, day/night continuity, jumping restored.
6. Pause / return-to-menu / reload during every phase resume in a valid state; double transitions rejected.
7. Three levels × three seeds: L1→snowy, L2→misty, L3→moonlit, each playable afterwards.
8. Developer finish triggers the natural approach and completes.

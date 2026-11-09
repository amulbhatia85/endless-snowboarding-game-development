# Rewards, Coins, Abilities & Unlockables (Phase 7)

A scalable reward and progression layer built on the existing glowstone
pickup, power-up and progression systems. Nothing about bicycle physics,
terrain, difficulty, level transitions or rendering changes.

## The wallet (`src/game/wallet.ts`)

A persistent **glowstone balance** (`afterglow-wallet-v1`), versioned and
validated exactly like the level save:

- **Separate currency** — the 50 000-point level score is untouched; glowstones
  are banked on top of it.
- **Transaction points** — collected stones are banked only when a run ends
  (`finalizeRun`), is abandoned (`returnToMenu`), or a level completes. A
  per-run watermark (`walletCommittedCoins`) makes every commit idempotent,
  so crashes, revives, restarts and interruptions can never double-credit.
- **Corrupt saves degrade to an empty wallet** — never a throw, never damage
  to other saved progress. Negative or non-integer values are rejected on load.
- **Sandbox rules** — `?dev=1` / `?level=N` sessions use an in-memory wallet,
  so preview play and the ⏭ Finish level button can never write to the real
  balance.

## Reward configuration (`REWARD_CONFIG`)

| Setting | Default | Notes |
|---|---|---|
| `levelCompletion` | 100 | every completed level |
| `cleanRunBonus` | 50 | no crashes during the level attempt (revives don't erase a crash) |
| `coinsPerFlip` | 5 | per backflip landed during the level |
| `flipRewardCap` | 25 | caps long trick chains |
| `milestones` | L5 → 200, L10 → 400, L25 → 1000 | special level numbers |
| `abilities.magnetSeconds` | 10 | magnet duration |
| `abilities.doubleSeconds` | 12 | double-glowstone duration |
| `abilities.shieldUses` | 1 | shield absorbs one eligible collision |

Rewards settle **the moment the completion condition is met** (target + safe
house, i.e. the Phase 6 `entering → celebrating` hand-off), so the completion
card shows real numbers. A `rewardedThrough` watermark makes the grant
idempotent: replaying a level after an interrupted transition earns only its
freshly collected stones, never a second helping of one-time rewards.

## Temporary abilities (pre-existing, now configurable)

The three power-ups were already implemented and are preserved as-is:
**Shield** (absorbs one collision), **Magnet** (attracts nearby glowstones),
**Double glowstones** (2× pickups). Only their durations moved into
`REWARD_CONFIG`. Physics and collision rules are unchanged; no ability makes
gaps or terrain safe.

## Unlockables (`src/game/progression.ts`)

The rider/bicycle selection system is extended, not replaced:

- **Characters** — Scout/Piper/Nova stay free with their flip thresholds;
  **Willow** (250 ◆) and **Ash** (600 ◆ + 3 levels completed) are purchasable.
- **Bicycles** — Amber/Glacier/Ember stay free with distance thresholds;
  **Midnight** (400 ◆) and **Aurora** (900 ◆ + 5 levels completed) are
  purchasable.
- **Trails** — cosmetic trail colour: Classic (free), Ember (250 ◆),
  Frost (250 ◆), Gilded (500 ◆ + the *Glowkeeper* achievement).

All cosmetics are visual only — colors and trail tint; physics, hitboxes and
scoring are identical. Locked items can never equip: `resolveSelections`
falls back to the defaults whenever a preference points at a locked entry.
Purchases go through `engine.purchaseUnlockable(id)` (single writer):
`ok | owned | locked | insufficient | invalid`, deducting exactly once and
never allowing a negative balance.

## UI

- **Rewards page** (main menu → Rewards): balance header, three cosmetic
  sections with cards showing colour swatches, EQUIP / BUY · price / the exact
  unlock requirement, and the equipped item highlighted.
- **Settings**: the two cosmetic dropdowns became a summary row linking to the
  Rewards page (selection logic unchanged — it still lives in preferences).
- **Completion screen** (Phase 6 card): adds a staggered-fade ledger —
  glowstones collected, completion bonus, clean run, backflips, milestone and
  the total. The gameplay HUD is untouched.

## Tests (`npm run test:rewards`, 12 tests)

1. Coins collect exactly once; wallet only banks at transaction points
2. Balance persists across restarts; corrupt/negative saves degrade safely
3. No glowstone ever spawns inside a hazard or over an open gap; heights stay jump-reachable
4. Wallet unit math: milestones, caps, validation, purchase outcomes
5. Completion rewards match configuration; granted once; per-level counters reset
6. A crash (even revived) voids the clean-run bonus; collected stones still bank
7. Interrupted transitions (celebration & exit reloads) never duplicate rewards
8. Developer sandboxes never touch the saved wallet
9. Abilities activate/expire per configuration; shield absorbs exactly one collision
10. Purchases deduct exactly once; insufficient/locked/invalid are rejected
11. Locked cosmetics never equip; purchases and stats unlock them
12. Physics, generation and level transitions keep working with rewards active

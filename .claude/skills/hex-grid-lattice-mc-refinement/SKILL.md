---
name: hex-grid-lattice-mc-refinement
description: |
  Design guide + benchmarked pitfalls for building Monte-Carlo / Simulated
  Annealing refinement layers on top of greedy hex-grid layouts for code
  visualization (packages/gui/src/store/hexLayout.ts, sandbox/hex-sandbox,
  future Rust ports). Use when: (1) planning to add MC/SA on top of an
  existing hex-grid pack, (2) deciding whether a simpler SA would match a
  hierarchical MC with force-directed + chain drag, (3) budgeting wall-clock
  for million-node cold-start, (4) debugging "blob turns Swiss-cheese" or
  "folders stop nucleating" during MC refinement, (5) choosing between
  folder cohesion and raw Σ-link-length as cost function. Contains four
  hard-won, quantified lessons and anti-patterns that would take a full
  day of experiments to rediscover.
author: Claude Code
version: 1.0.0
date: 2026-04-15
---

# Hex-Grid Lattice MC Refinement: Design Principles

## Problem

You already have a greedy hex-grid packer (pack.js / hexLayout.ts / future
Rust port) that produces reasonable file-tree layouts. You want to push
closer to optimal via Monte Carlo / Simulated Annealing. Four non-obvious
design decisions determine whether the refinement actually helps or wastes
compute; this skill documents them with benchmark numbers from a full
multi-hour experiment session so you don't rediscover them the hard way.

## Context / Trigger Conditions

- Hex-grid hierarchical layout for code visualisation (file → folder → pkg
  → root), hundreds to millions of nodes
- Greedy pack already exists and is "good enough" structurally
- Considering MC/SA refinement to reduce Σ link length further
- Or planning a from-scratch MC cold-start because "why not"
- Or seeing surprising symptoms (Swiss-cheese holes, folders refusing to
  nucleate, MC never improving on the last 20 minutes)
- Or choosing move set: random adjacency swap vs force-directed vs chain
  drag vs folder drift

## Lesson 1 — Hole-guard > smart proposals

**Claim**: For dense-pack hex lattice MC, preventing isolated-hole formation
gives more improvement than adding force-directed proposal generation.
Geometric invariants beat smart directions.

**Benchmark** (1497 grafema nodes, warm-start from greedy, 15s wall budget):

| Move set | Σ-link reduction over greedy |
|---|---|
| Random swaps + Metropolis (naive) | 5.0% |
| **+ hole-guard** (reject hops that create interior holes) | **6.9%** (+1.9 p.p.) |
| + force-directed top-3 flanking proposal | 7.6% (+0.7 p.p.) |
| + hierarchical force (intra before snap, external after) | 7.5% (noise) |
| + BFS bent chain drag | 7.5% (noise) |

**Why hole-guard matters so much**: Single-atom hop moves create vacancies
when an atom jumps from a boundary cell into empty space. In Metropolis,
hop-OUT is typically ΔE > 0 (stretches links, rarely accepted) while
hop-BACK is ΔE < 0 (shortens links, almost always accepted). This breaks
detailed balance — holes form at the boundary and migrate inward, turning
the blob Swiss-cheese over thousands of iterations even though the energy
metric keeps improving.

**Fix**: before allowing an atom to hop into an empty neighbour, verify
the atom's old cell has ≥2 empty neighbours so it remains connected to the
outer empty region after the hop. One-line check, 40% relative improvement:

```js
const oldEmptyNeighbours = countEmptyHexNeighbours(a.coord);
if (oldEmptyNeighbours < 2) return null; // would create isolated hole
```

**Non-obvious corollary**: after adding hole-guard, force-directed proposals
give only +0.7 p.p. more. If you're on a refinement budget, spend it on
invariants, not smart proposals.

## Lesson 2 — MC cold-start is infeasible vs structured construction

**Claim**: Lattice MC with local moves (swap, hop, drift, chain) cannot
close the gap with a structured greedy pack for cold-start initialisation,
even with hours of compute.

**Benchmark** (1497 grafema nodes, cold-start from alphabetic ring):

| Budget | Σ-link reduction | vs greedy's 13026 |
|---|---|---|
| Greedy (3.6s) | n/a | **1.00×** |
| MC 60s | 31.4% | 14.0× worse |
| MC 180s | 38.3% | 12.6× worse |
| MC 300s | 42.9% | 11.7× worse |
| MC 900s (15 min) | 54.9% | 9.2× worse |

**Log-linear scaling**: ~20 p.p. of reduction per log-unit of wall-clock.
Extrapolating to match greedy's 13026 requires +40 p.p. more = 2 more log
units = **100× the 900s budget = 25 hours** per run. Infeasible.

**Why**: glassy regime — the move set is too local. Acceptance rate stays
at 16-22% even after 15 min (never drops below 1.5% which would indicate
equilibrium). Convergence detector never fires. "Run until frozen" SA
doctrine doesn't apply.

**Practical rule**: Always seed MC with a structured algorithm. For hex
hierarchical layouts, use the greedy pack (pack.js / future Rust port).
Reserve MC as a **refinement layer** for the final ~7% polish on warm
starts, not as a primary algorithm.

## Lesson 3 — Hierarchical nucleation-aware force trades raw energy for
folder cohesion

**Claim**: Gating force-direction on folder nucleation state (pre-snap
intra-folder, post-snap external) improves folder cohesion by ~36% at
the cost of ~13% raw Σ-link energy. This is the right tradeoff for
code-map visualisation.

**Design**:
```
for each atom a:
  find the deepest ancestor folder F that is NOT yet in `connected` set
  AND whose size ≤ connCheckMaxSize
  if F exists:
    # pre-snap: crystallise F
    force(a) = Σ (sibling.pos - a.pos) × weight   over same-F links
    # fallback if no intra-F links: pull to F's centroid
  else:
    # post-snap of all ancestors: place the now-coherent unit
    force(a) = Σ (other.pos - a.pos) × weight  over external-to-leaf links
```

**Benchmark** (1497 nodes, cold-start 60s):

| Force type | Σlinks | conn folders | adj invariants |
|---|---|---|---|
| Plain force (always external) | 162873 | 273/518 | 186 |
| Hierarchical (intra→external) | 182678 | **379/518** | 159 |

Plain gives best raw energy. Hierarchical gives **+38% more connected
folders** — the ones where a leaf actually condensed into a coherent
blob. For a visualisation where folders should read as regions on a map,
structure beats raw length.

**Required fix — size-cap trap**: folders above `connCheckMaxSize`
never enter the `connected` set (BFS check too expensive). Without
explicit skip in the ancestor walk, atoms below them are trapped
forever in "pre-snap, pull toward huge-folder centroid" mode, producing
weak scattered forces. Fix:

```js
for (const fp of ancestors) {
  if (connected.has(fp)) continue;
  const size = folderAtoms.get(fp)?.size ?? 0;
  if (size > connCheckMaxSize) continue; // virtually nucleated
  activeFolder = fp;
  break;
}
```

This one-liner was missed in the first implementation and caused conn
counts to plateau at 372/518. After the fix: 379/518 at 60s, 391/518
at 180s.

## Lesson 4 — Bent chain drag via BFS vacancy routing

**Claim**: Row-shift chain drag (all atoms in a column shift by one
hex) frequently breaks folder connectedness. Replacing it with BFS
vacancy routing (the chain bends around obstacles) preserves invariants
more often.

**Design**:
```
tryChainDrag(atom a, direction d):
  target = a.coord + d
  if target empty: use a plain hop instead
  if a.coord has <2 empty neighbours: abort (hole-guard)

  BFS from `target` through OCCUPIED cells, looking for the nearest empty
  cell. Each step uses any of 6 hex neighbours (chain bends freely).
  Max depth CHAIN_BFS_MAX_DEPTH=6.

  When empty cell found, reconstruct path: [target, c1, c2, ..., empty]
  Each cell path[i] moves to path[i+1]:
    - occupant of path[0] → path[1]
    - occupant of path[1] → path[2]
    - ...
    - occupant of path[k-1] → empty
    Finally `a` moves from a.coord to path[0] (now freed).

  Per-atom step direction can differ (that's the bending).
  ΔE: sum over affected atoms' external links; inter-chain links use
  new positions (both endpoints moved).
```

**Why bending helps**: a rigid row-shift only succeeds if the entire row
can translate without breaking a registered `connected(F)` invariant.
For a typical mid-nucleation cold-start, at least one atom on the row
is usually a cut vertex of some folder — rigid shift fails. A bent
chain can route around that atom, pushing only atoms whose folder is
safe to re-arrange.

**Not implemented (future)**: proactive constraint-aware BFS that
weights candidates by "is this atom a cut vertex of an active
invariant folder". Current implementation is reactive — it applies
the chain, then rejects on invariant-check failure. Proactive would
cost O(folder BFS) per step and wasn't worth it for our benchmarks,
but may matter for much larger projects.

## Consolidated verdict

For a refinement layer on top of greedy on ~1500-node projects:

- **Minimum viable MC** = plain random swaps + Metropolis + hole-guard
  gets 6.9% over greedy in 15s. ~100 lines of code.
- **Maximum effort MC** (force-directed + hierarchical + bent chain +
  nucleation invariants) gets 7.5% in 15s. ~600 lines of code.
- **Net value of the fancy machinery**: +0.6 p.p. (noise-level).
- **Only reason to keep the complexity**: folder cohesion guarantees
  (hierarchical nucleation) and map-like visual structure. If raw Σ-links
  is the only metric, delete it and use plain SA.

For million-node targets: **MC is not the answer at all**. Port the
greedy pack to Rust (see REG-1102). MC refinement gives ≤7% that you
can spend a week of engineering on; greedy port gives 100× throughput
for 1-2 weeks of engineering. Cold-start MC gives an extrapolated 25h
wall-clock for a result that greedy produces in seconds.

## Example

```js
// The minimum-viable refinement loop that captures 90% of the value:
async function refine(map, wallMs = 15000) {
  const rng = Math.random;
  const atoms = [...map.nodes.values()];
  const linksByAtom = indexLinksByAtom(map.links);
  const occupancy = buildOccupancy(map);

  // Temperature auto-calibrate from 300 random adjacency-swap ΔE samples
  const avgDelta = sampleSwapDeltas(300, atoms, linksByAtom, rng);
  const T0 = Math.max(1, avgDelta * 2);
  const T1 = Math.max(0.05, avgDelta * 0.01);

  const tStart = performance.now();
  let energy = computeTotalEnergy(map.links);

  while (performance.now() - tStart < wallMs) {
    const t = (performance.now() - tStart) / wallMs;
    const T = T0 * (T1 / T0) ** t;

    // Propose: 80% adjacency swap, 15% long-distance swap, 5% hole-safe hop
    const roll = rng();
    const move = roll < 0.80 ? adjSwap(atoms, rng, occupancy, map)
               : roll < 0.95 ? randomSwap(atoms, rng)
               : holeSafeHop(atoms, rng, occupancy);          // ← guards against Lesson 1
    if (!move) continue;

    const dE = computeDeltaE(move, linksByAtom);
    if (dE > 0 && rng() >= Math.exp(-dE / T)) continue;

    applyMove(move, occupancy);
    energy += dE;
  }
}
```

For the project-specific `holeSafeHop` implementation, look in
`sandbox/hex-sandbox/src/pack-mc.js` (commit 6dcefd09) — it's a 20-line
helper with the ≥2-empty-neighbours guard.

## Notes

- All benchmarks used a 1497-node grafema codebase with 4351 real
  polyglot import edges (scan-links.mjs). Synthetic data with
  folder-biased random links gives artificially optimistic numbers.
- The `connected.has(fp)` check relies on a size-cap
  (`connCheckMaxSize=200`) — any folder above that never enters the
  invariant set; code walking ancestors must skip them explicitly
  (Lesson 3 size-cap trap).
- `0 reheats` across every cold-start benchmark confirms the glassy
  regime: acceptance stays above the 1.5% reheat threshold even at
  15 min. Don't budget based on "time to convergence" — budget on
  wall-clock.
- Chain drag is expensive per-call (BFS + multi-atom apply/undo).
  Cap its proposal frequency to 5% or less of the move mix, otherwise
  iteration throughput drops below the point where simpler moves
  give better ΔE/second.
- For incremental (warm-start with small changes) use case, MC is
  ideal: seeded from last layout, low-temperature polish. This is
  the ONE use case where MC beats everything including fresh greedy.

## References

- Session artifact: sandbox/hex-sandbox/src/pack-mc.js at commit 6dcefd09
- Related skills:
  - `.claude/skills/hex-grid-sa-o1-connectivity/` — O(1) connectivity check
    for SA migrate moves (orthogonal speedup)
  - `.claude/skills/hex-grid-sequential-bfs-layout/` — the greedy algorithm
    this MC refines (pack.js)
- Linear: REG-1102 (Rust port of greedy for million-node target),
  REG-1100 (layout/view split), REG-1101 (npm package)
- Physics literature: Wolff 1989 (cluster moves), Binder & Heermann
  "Monte Carlo Simulation in Statistical Physics" (glassy regime)

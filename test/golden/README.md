# Regression Goldens (REG-1117)

Four semantic regression layers that fail only on meaningful regressions and
explain themselves clearly. Replaces snapshot-the-whole-graph tests.

## Layers

1. **Layer 1 — `behaviors.json`** (`test/unit/behaviorGolden.test.js`).
   Per-FEATURE: `BEHAVIOR.hash`, `effects[]`, `coreNodeCount`, `depth`.
   Diff fails when the implementation identity (hash) drifts.

2. **Layer 2 — `contracts.json`** (`test/unit/contractDiff.test.js`).
   Per-FEATURE: `SpecedContractData` (source, inputs, outputs, errors).
   Categorised diff: BREAKING vs MINOR vs COSMETIC. Description-only changes
   are ignored.

3. **Layer 3 — `cross-modality-divergence.json`** (`test/unit/crossModalityEquivalence.test.js`).
   Within each `SHARES_BEHAVIOR_WITH` cluster, FEATUREs are expected to have
   structurally-equivalent contracts. Intentional divergences (e.g. CLI uses
   `--config` while MCP exposes `configPath` for the same logical input) live
   here as `{pairKey: rationale}`. Empty by default.

4. **Layer 4 — `effect-surfaces.json`** (`test/unit/effectSurfaceDiff.test.js`).
   Per-FEATURE: sorted `effects[]`. Adding `FS_WRITE` / `NETWORK_OUT` /
   `DB_WRITE` is flagged as ESCALATION; everything else is NOTE.

## When to regenerate

Goldens only change when **intentional** drift happens. Workflow:

1. Make the change to source (refactor, new feature, bugfix that alters effects).
2. Run analysis: `pnpm build && grafema analyze`.
3. Run the layer tests: most will fail with a categorised diff and a
   regenerate-hint command.
4. Decide: is each diff acceptable? If yes, regenerate the affected golden:
   ```bash
   node test/golden/regenerate-behaviors.mjs --rfdb .grafema/rfdb.sock
   node test/golden/regenerate-contracts.mjs --rfdb .grafema/rfdb.sock
   node test/golden/regenerate-effect-surfaces.mjs --rfdb .grafema/rfdb.sock
   ```
5. Commit the updated JSON next to the source change. PR reviewer can audit
   the contract diffs before merge.

All four goldens can be regenerated from a **single** live-graph pass — they
read disjoint projections of the same RFDB connection. Run the three scripts
sequentially against the same socket.

## Recommended first regen order

After the first full analysis run that produces FEATURE / BEHAVIOR /
SPECED_CONTRACT nodes:

1. `behaviors.json` — anchors the implementation-identity baseline.
2. `effect-surfaces.json` — derived from the same BEHAVIOR data; any
   inconsistency here vs Layer 1 surfaces a bug in `collectEffectSurfaces`.
3. `contracts.json` — independent projection (SPECED_CONTRACT nodes).
4. `cross-modality-divergence.json` — populate only after running the
   crossModalityEquivalence test once and reviewing legitimate drifts.

## Initial state

All four goldens start as `{}` (or the equivalent structure for divergence).
Layer tests treat empty goldens as "no regressions detectable" — they pass
without comparison. The CI gate becomes effective only after the first
regen.

## Why not snapshot the whole graph?

Whole-graph snapshots flap on every parser tweak, every node-id reshuffle,
every metadata-format change. They produce 100 KB+ diffs that no human
reviews. These four layers each project the graph to a small, semantically
meaningful subset:

| Layer | Failure means |
|------|----------------|
| 1    | Implementation behavior changed (hash drift) |
| 2    | Public contract changed |
| 3    | Cross-modality contracts diverged |
| 4    | Effect surface changed (security-sensitive) |

Each test fails with a focused, categorised, human-readable diff and a
clear remediation hint.

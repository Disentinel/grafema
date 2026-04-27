# Regression Goldens (REG-1117)

Four semantic regression layers that fail only on meaningful regressions and
explain themselves clearly. Replaces snapshot-the-whole-graph tests.

## Two-tier golden setup

The infrastructure separates two distinct golden roles. Both live under
`test/golden/`, but they have different ownership, lifecycle, and consumers.

### Tier 1 — Fixture goldens (committed, validated by every test run)

Path: `test/golden/fixture/{behaviors,contracts,effect-surfaces,cross-modality-divergence}.json`

These are the COMMITTED reference projection of the **synthetic test
fixture** used by the four layer tests. The fixture seeds a tiny graph (1-2
features) into an ephemeral `TestRFDB` database, runs the projection
helper, and asserts zero diff vs. the fixture-golden.

A non-zero diff means the **diff infrastructure itself** regressed
(`collectBehaviors`, `collectContracts`, `collectEffectSurfaces`,
`behaviorDiff`, `contractDiff`, `effectDiff`, or the test seeders). It is
NOT a real-world regression.

Regen (no live RFDB needed — uses TestRFDB):

```bash
pnpm --filter @grafema/util build
node test/golden/regenerate-fixture-goldens.mjs
```

The script runs the same fixture seeders the layer tests use and writes all
four files in one pass. Commit the result alongside any intentional change
to the fixture or projection helpers.

### Tier 2 — Production goldens (gitignored / repo-empty `{}`)

Path: `test/golden/{behaviors,contracts,effect-surfaces,cross-modality-divergence}.json`

These are the live-graph snapshot of the real Grafema codebase
(~150 features). Repo state stays as `{}` — they are NOT committed populated
and are NOT consumed by the layer tests. CI / release-gate workflows
populate them on demand and compare against them to detect real-world
regressions.

Regen (requires a live RFDB socket from `grafema analyze`):

```bash
GRAFEMA_RFDB_SOCK=.grafema/rfdb.sock node test/golden/regenerate-behaviors.mjs
GRAFEMA_RFDB_SOCK=.grafema/rfdb.sock node test/golden/regenerate-contracts.mjs
GRAFEMA_RFDB_SOCK=.grafema/rfdb.sock node test/golden/regenerate-effect-surfaces.mjs
```

After running them in CI, the gate compares the produced JSON against the
last known-good snapshot stored elsewhere (artifact, S3, branch baseline).
The repo files themselves should be reset to `{}` after each ad-hoc regen
so a stray `git add` doesn't accidentally commit a live snapshot.

## Layers

1. **Layer 1 — `fixture/behaviors.json`** (`test/unit/behaviorGolden.test.js`).
   Per-FEATURE: `BEHAVIOR.hash`, `effects[]`, `coreNodeCount`, `depth`.
   Fixture-test: zero-diff against committed projection.

2. **Layer 2 — `fixture/contracts.json`** (`test/unit/contractDiff.test.js`).
   Per-FEATURE: `SpecedContractData` (source, inputs, outputs, errors).
   Categorised diff: BREAKING vs MINOR vs COSMETIC. Description-only changes
   are ignored.

3. **Layer 3 — `fixture/cross-modality-divergence.json`** (`test/unit/crossModalityEquivalence.test.js`).
   Within each `SHARES_BEHAVIOR_WITH` cluster, FEATUREs are expected to have
   structurally-equivalent contracts. Intentional divergences (e.g. CLI uses
   `--config` while MCP exposes `configPath`) are listed here. The fixture
   seeds two structurally-identical contracts so the allowlist is empty.

4. **Layer 4 — `fixture/effect-surfaces.json`** (`test/unit/effectSurfaceDiff.test.js`).
   Per-FEATURE: sorted `effects[]`. Adding `FS_WRITE` / `NETWORK_OUT` /
   `DB_WRITE` is flagged as ESCALATION; everything else is NOTE.

## When fixture-goldens drift

You should rarely need to update them. Triggers:

1. The fixture seeder in a layer test changed (different effects, hash, etc).
2. A projection helper changed (e.g. `collectBehaviors` started extracting a
   new field).
3. The diff format / normalization changed.

Workflow:

1. Make the intentional change.
2. Run the layer tests; expect failures with a focused diff.
3. Decide each diff is acceptable.
4. `node test/golden/regenerate-fixture-goldens.mjs`
5. Re-run tests; confirm green.
6. Commit the regenerated `test/golden/fixture/*.json` together with the
   source change.

## Why two tiers?

Earlier the layer tests read directly from the top-level
`test/golden/*.json` files, which were ALSO the production-snapshot
target. Populating production goldens (~150 features) made the layer tests
fail because the small fixture's projection couldn't match. The two-tier
split decouples the concerns: layer tests validate diff-infrastructure
correctness on a tiny stable fixture, while production-snapshot regen
remains a separate flow consumed by CI gates.

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

# HANDOFF → fresh session (2026-06-09, ~14:00)

**Nothing is broken.** The "hang" was a **fresh `analyze` run that actually COMPLETED but took ~5.9 hours**
(`Analysis complete in 21217.51s` → 425 737 nodes / 942 563 edges). The detached run kept going after the
session was stopped. The real issue is **analysis perf**, not a crash.

Branch `feat/datalog`. **HEAD = `c5f8e1a0`, origin is 2 commits BEHIND** (unpushed: `0eca193b` decisions doc +
`c5f8e1a0` deadline fix). Working tree clean. The other ~84 overnight commits ARE pushed.

---

## 1. Cleanup (the MAIN repo is already clean)

The main repo's socket is **already clear** (I killed my orphaned auto-start server, PID 61436, and removed
`.grafema/rfdb.sock`). There are ~90 OTHER lingering `rfdb-server` procs, but they are **NOT blocking the main
repo and NOT the cause of the slowness** (idle, ~1.6MB RSS each):
- ~62 are temp **test** servers (`/T/grafema-*-test-*/...`) — leaked by test runs, safe to kill.
- A few belong to **OTHER worktrees** (`grafema-worker-2`, `grafema-worker-4`) — **do NOT blindly kill these**;
  they may be active sessions in those worktrees.

Targeted, safe cleanup (temp-test servers only — does NOT touch worktrees or any `.grafema` server):
```bash
ps aux | grep -E 'rfdb[-_]server' | grep -v grep | grep -E '/T/grafema-.*-test-|--data-dir /tmp' \
  | awk '{print $2}' | xargs -r kill -9
# before any fresh analyze in THE MAIN REPO, just clear its own socket:
pkill -9 -f -- '--socket /Users/vadimr/grafema/.grafema/rfdb.sock'; rm -f /Users/vadimr/grafema/.grafema/rfdb.sock
```

## 2. Environment gotchas discovered today (so you don't re-hit them)

- **`cabal` is NOT on the tool-shell PATH.** `source ~/.ghcup/env` before any Haskell build. (ghc/cabal at `~/.ghcup/bin`.)
- **`pnpm build` (all) FAILS** on `packages/gui` vite: `ENOENT packages/gui/public/assets`. For analysis you don't
  need gui — build only the CLI chain: `pnpm --filter '@grafema/cli...' build` (covers types/util/rfdb).
- **Native binaries go stale + the orchestrator hard-rejects them** (`.build-hash` guard, E "Stale binary detected").
  Rebuild via `scripts/build-native.sh <pkg> cabal install --install-method=copy --overwrite-policy=always`
  (Haskell) — it syncs `~/.grafema/bin` + writes `.build-hash`. Today rebuilt: `grafema-resolve`, `haskell-analyzer`.
- **Cross-worktree symlink rot:** `packages/grafema-orchestrator/target/release/grafema-resolve` was a symlink to
  `grafema-worker-1` (Mar 21). `resolve_binary` (config.rs:340) prefers the **sibling of the orchestrator binary
  FIRST**, so a stale sibling symlink wins over fresh `~/.grafema/bin`. I removed it; check the others
  (`grafema-analyzer` symlink → main js-analyzer, that one is fine).
- **Two DB dirs, don't confuse them:** `.grafema/graph.rfdb` = the LIVE analyze output (now v660+, FRESH,
  425k/942k). `.grafema/grafema.rfdb` = a separate OLD snapshot (v104, Mar-4, 143k/136k) — the one the overnight
  probes used (hence the staleness caveat). Query `graph.rfdb` for current data.

## 3. How to run a fresh analysis (the recipe that worked)

```bash
cd /Users/vadimr/grafema
source ~/.ghcup/env
pnpm --filter '@grafema/cli...' build       # NOT pnpm build (gui breaks)
# fresh release binaries already built today: rfdb-server + orchestrator under packages/*/target/release
export RFDB_DATALOG_V2=on                     # exercise the v2 engine; OFF = legacy DEPENDS_ON
export GRAFEMA_ORCHESTRATOR="$PWD/packages/grafema-orchestrator/target/release/grafema-orchestrator"
export GRAFEMA_RFDB_SERVER="$PWD/packages/rfdb-server/target/release/rfdb-server"
pkill -9 -f 'rfdb[-_]server'; rm -f .grafema/rfdb.sock
node packages/cli/dist/cli.js analyze . --clear --log-level info   # ~6h currently (see perf issue)
```
**Recommendation:** for a *working* fresh graph fast, run with `RFDB_DATALOG_V2` UNSET (legacy DEPENDS_ON,
no v2 materialize) and debug v2/perf separately — don't keep v2 on the analyze critical path until the perf
issue below is understood.

## 4. The two real findings from the fresh run

1. **⚠ PERF PATHOLOGY (top priority): the full analysis takes ~5.9 HOURS** (21217s) for 425k/942k. That is
   pathological — needs profiling. Candidates: resolution phase, the v2 DEPENDS_ON materialize (depends.dl join on
   a 408k-node graph), or the per-shard write path. The 4 user plugins below also each burn 60s. **Profile which
   phase dominates** (the orchestrator logs per-phase timing; `type-inference` alone was 103s, `shape-tracker` 55s).
2. **v2 `@materialize` 30s deadline was too tight → FIXED** (`c5f8e1a0`): `dispatch_materialize_datalog` now uses a
   batch deadline `RFDB_MATERIALIZE_DEADLINE_SECS` (default 600s), not the 30s interactive default. depends.dl on
   the real graph exceeded 30s (E-EXEC-001). **Verify** this fix actually let DEPENDS_ON materialize complete in
   the 6h run (grep the run log / re-run with v2 on and check for DEPENDS_ON edges).
- Side: 4 user plugins **time out at 60s** on the 408k graph — `method-call-resolver`, `axum-route-detector`,
  `shape-verifier`, `semantic-bridge-detector` (non-fatal, but real perf debt).

## 5. The 9 user-approved decisions + execution order (the roadmap)

Full text + rationale in `_ai/research/rfdb-datalog-overnight-loop-report.md` (§ "DECISIONS RESOLVED"). Summary:

1. **Edge verb form → PRESENT tense** (stative). Canonicalize analyzers' `DERIVED_FROM → DERIVES_FROM` (js+haskell
   `Expressions.hs` `geType`), audit other past-tense outliers (`ASSIGNED_FROM`), reanalyze. Consumers already use
   present. (Do after a baseline graph exists.)
2. **MCP wire for sim / why-not — GREENLIT.** Add server `SimDatalog` + `ExplainDatalogGap` Request variants +
   TS/MCP tools, mirroring the shipped `explain_fact` vertical. (Engine methods `sim_datalog_v2` /
   `explain_datalog_gap` already exist + tested.) sim input shape `{nodes, edges}` accepted.
3. **Plugin-loader contract — yes.** User: **cross-file resolvers are the heaviest part** → that's the focus.
4. **Planner q-error fix — APPROVED (supervised).** Spec in `_ai/gaps.md`: thread per-predicate cardinality into
   `derived_estimate` (plan.rs:668); recursive self-leg uses base-case estimate.
5. **Numeric literals typed (Int+Float) — confirmed** (already done).
6. **Coverage output — keep BOTH** `%` metric AND why-not worklist.
7. **Value-domain spec DSL — prototype it**, aim for the tersest notation.
8. **First cross-artifact modelling target = the GUI** (frontend → backend), what already exists in
   grafema / grafema-cloud — NOT nginx. Needs the fresh graph to include the GUI.
9. **Flip `RFDB_DATALOG_V2` default → ON** — BUT only after the perf issue (#4 above) is resolved; right now v2 on
   the analyze path is the slow/timeout path, so do NOT flip until depends.dl materialize is fast + verified.

## 6. What the overnight session built (already pushed, green)

The **coverage triad** is engine-complete + tested (unit + real-store + e2e): `explain_datalog_fact` (why),
`explain_datalog_gap` (why-not, `GapWitness`), `sim_datalog_v2` (what-if, via `OverlayStorageView`). MVCC stitch
verified (version-pinned snapshot reads + single-flip commit). Entry points: `_ai/research/rfdb-datalog-RESUME.md`
(canonical ledger) + `…overnight-loop-report.md` (digest). `_ai/gaps.md` has the planner q-error spec + the
(corrected) negation note. Enox has: coverage-triad, sim, lang-spec plugin grounding, migration thesis, q-error.

## 7. First-session checklist

- [ ] Clean rfdb-server zombies (§1).
- [ ] Decide: push the 2 local commits (`0eca193b`, `c5f8e1a0`) or review first.
- [ ] **Profile the ~6h analysis** — which phase dominates? (the real blocker for #9).
- [ ] Verify the deadline fix let v2 DEPENDS_ON complete (or whether v2 is the 6h cause).
- [ ] Then proceed down the decision order (1 → 9) once a fast baseline analysis exists.

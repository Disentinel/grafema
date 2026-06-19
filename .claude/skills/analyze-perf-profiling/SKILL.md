---
name: analyze-perf-profiling
description: >-
  Profile grafema's OWN analysis pipeline (`grafema analyze`) by route + bottlenecks instead of
  guessing. Use when analyze is slow, hangs, OOMs, or hits a scale limit. Covers the auto-emitted
  JSONL profiler, the critical-path computation, the derive/enricher blind spot, the KNOWN artificial
  limits (so you don't rediscover them from a crash), and host/RAM requirements.
---

# Profiling `grafema analyze` — see the route and its traffic jams

The cardinal rule: **measure the critical path FIRST; never "discover" a bottleneck from a crash or a
guessed limit.** Most analyze pain is an arbitrary cap that bites at scale or a dead analyzer daemon —
both are visible up front if you look.

## 1. The profiler is AUTOMATIC — no flag, no special mode

Every `grafema analyze` writes a JSONL profiler stream to **`.grafema/analysis-profile.jsonl`**.
Read it with the bundled tool:

```bash
node scripts/profile-analyze.mjs .grafema/analysis-profile.jsonl          # phase breakdown, outliers, mem
node scripts/profile-analyze.mjs .grafema/analysis-profile.jsonl --predict 14000   # scale to N files
node scripts/profile-analyze.mjs .grafema/analysis-profile.jsonl --json    # machine-readable
```

Captured: per-file (`parse_ms`/`analyze_ms`/`total_ms`/`node_count`/`edge_count`, all languages),
batch commits (`commit_ms` per `batch_index` — growth ⇒ O(N²), RFD-51), phase start/complete events,
and `rss_mb`/`cpu_s` on every event.

## 2. Critical path (the route + the jams) — one-liner from the JSONL

```bash
node -e 'const fs=require("fs");const ev=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);const s={},r=[];for(const e of ev){const t=e.event||e.type||"";const m=e.elapsed_ms??e.ts_ms;if(t.endsWith("_start"))s[t.replace(/_start$/,"")]=m;if(t.endsWith("_complete")){const k=t.replace(/_complete$/,"");if(s[k]!=null)r.push([k,m-s[k]])}}r.sort((a,b)=>b[1]-a[1]);const tot=r.reduce((x,y)=>x+y[1],0)||1;for(const[k,d]of r)console.log(k.padEnd(22),(d/1000).toFixed(1).padStart(8)+"s",(100*d/tot).toFixed(0)+"%")' .grafema/analysis-profile.jsonl
```

Real run (grafema self-analyze, June 2026, after the BEAM fix): `rust_resolve 52s/38%`,
`analysis 37s/27%`, `haskell_resolve 23s/17%`, `beam_resolve 13s`, `js_resolve 11s`, `compact 1.2s`.

## 3. THE BLIND SPOT — derive packs + enrichers are NOT in the JSONL

The profiler covers analysis + the resolve phases. The **derive phase (≈40 `@stdlib/*` rule packs,
~180s) and the TS enrichers run in rfdb-server / post-resolve and are NOT phase-events in the JSONL** —
this is exactly where the worst scale bugs live (cap overflows, the parallel-derive SIGSEGV, planner
q-errors). To see derive bottlenecks today, grep the verbose analyze log:

```bash
grep "Rule pack materialized" analyze.log   # per-pack: pack="@stdlib/..." ms=N edges=M  → packs with high ms / 0 edges
grep -E "Analysis complete|enricher|timed out" analyze.log
```

**DONE — the profile subgraph:** `grafema analyze` now emits the pipeline as a **profile subgraph** in
the `profile:` namespace (under synthetic file `__grafema_profile/<run_ts>`): `profile:run` /
`profile:phase` / `profile:stage` nodes + `METRIC` nodes (`wall_ms`, `edges_produced`, `nodes_produced`)
+ `PART_OF` / `PRECEDES` / `OBSERVES` edges. The **derive packs are now stages too** — the blind spot is
closed (no more `Rule pack materialized` log-grep). On by default (`GRAFEMA_PROFILE_SUBGRAPH=0` to
disable). Read the route + jams + dead stages straight from the GRAPH:

```bash
node scripts/profile-graph.mjs --project .            # critical path + jams + dead stages
node scripts/profile-graph.mjs --json
```

Critical path = longest `PRECEDES` chain by summed `wall_ms` (the helper walks it). Dead stages =
`wall_ms` high AND `edges_produced=0` — a pure Datalog query (the CI-gate candidate):

```
dead(S, Name, Ms) :- node(S, "profile:stage"), attr(S, "edges_produced", "0"),
                     attr(S, "wall_ms", Ms), gt(Ms, "1000"), attr(S, "name", Name).
```

Full schema + queries: `_ai/profile-subgraph.md`. The `METRIC`/`OBSERVES` node+edge types are reused
(same as per-file `parse_ms` today).

## 4. KNOWN artificial limits — check these BEFORE assuming a real bottleneck

These conservative caps / timeouts bite at self-scale (~700k nodes). They are env-overridable
(some only on branch `fix/derive-batch-cap` and the worker branches). **For a full self-analyze run:**

```bash
RFDB_MATERIALIZE_DEADLINE_SECS=3600 RFDB_MAX_MATERIALIZED_FACTS=200000000 grafema analyze --quickstart
```

| Limit | Default | Symptom | Override |
|---|---|---|---|
| `max_intermediate_results` (derive batch) | 100k | `E-EXEC-001 ... exceeds max_intermediate_results` | `RFDB_MATERIALIZE_MAX_INTERMEDIATE` (lifted by default on fix branch) |
| `MAX_MATERIALIZED_FACTS` (planner guard) | 10M | `E-PLAN-003 ... per-rule output estimate N exceeds` — often a q-error OVERestimate (cross-product ignoring selective join keys) | `RFDB_MAX_MATERIALIZED_FACTS` |
| materialize deadline | 30s (query default) | derive aborts mid-pack | `RFDB_MATERIALIZE_DEADLINE_SECS` (default 600) |
| RFDB RPC client timeout | 60s | `RFDB … timed out after 60000ms` → enrichers SKIPPED | `RFDB_RPC_TIMEOUT_MS` / `RFDB_RPC_BULK_TIMEOUT_MS` |
| analyzer pool `request_timeout` | 120s/file | a DEAD analyzer daemon burns it per file (BEAM: 25 .ex × 120s = 241s) | fixed by liveness-probe (perf branch); else install the toolchain |

## 5. Host & toolchains

A full self-analyze peaks **~7.5–11 GB RAM / ~14 min**. Run it on **grafema-dev** (Hetzner cx53,
16 vCPU / 32 GB, `ssh grafema-dev`, `source ~/.cargo/env`), NOT the laptop or a 7 GB VM (OOM kills
rfdb-server → exit 143, which looks like a crash but is memory pressure). Missing language toolchains
make those files **skip** (elixir/mix for BEAM, swift, libclang for C/C++) — fast now, but the self-graph
is then partial for those languages. Running 2 full analyzes on the 32 GB box is the safe max (>2 OOMs).

## 6. Known standing perf debt (don't re-derive)

`REG-1128`: heavy Node.js resolve plugins do N+1 IPC walks — `type-inference 72.7s / 0 edges`,
`method-call-resolver 55s / 0 edges`, `shape-verifier 53s / 0 edges`. Fix direction = rewrite as Datalog
rules. Derive-phase plan (parallelize independent packs, hoist `derive_stats`, bound the `js_local_refs`
scope-walk) is in `_ai/self-analyze-perf-findings.md`.

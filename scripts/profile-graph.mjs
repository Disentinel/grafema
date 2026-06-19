#!/usr/bin/env node
/**
 * profile-graph.mjs — read the PROFILE SUBGRAPH from the graph and print the
 * pipeline's critical path + dead stages. This is the "pipeline profiling as a
 * queryable subgraph" deliverable: the route + jams come from the GRAPH (incl.
 * the derive packs, which were previously invisible — only a "Rule pack
 * materialized" log line), NOT from log-grepping.
 *
 * The profile subgraph is emitted by `grafema analyze` (on by default; disable
 * with GRAFEMA_PROFILE_SUBGRAPH=0). Schema:
 *   profile:run   — one per analyze (attrs: ts, total_ms)
 *   profile:phase — analysis | resolve | derive          PART_OF -> run
 *   profile:stage — one per resolver-cmd / derive-pack    PART_OF -> phase
 *                   PRECEDES -> next stage in execution order (the route)
 *   METRIC        — wall_ms / edges_produced / nodes_produced  OBSERVES -> stage
 *
 * Usage:
 *   node scripts/profile-graph.mjs [--project DIR] [--json] [--dead-threshold-ms N]
 *
 * The same facts are queryable directly with `grafema query --raw` — see the
 * documented queries in the skill and in _ai/profile-subgraph.md.
 */
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { RFDBServerBackend } from '@grafema/util';

function parseArgs(argv) {
  const opts = { project: '.', json: false, deadThresholdMs: 1000 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project' || a === '-p') opts.project = argv[++i];
    else if (a === '--json') opts.json = true;
    else if (a === '--dead-threshold-ms') opts.deadThresholdMs = parseInt(argv[++i], 10);
  }
  return opts;
}

/** Run a Datalog query, returning rows as plain {var: value} objects. */
async function dl(backend, query) {
  const rows = await backend.datalogQuery(query);
  return rows.map((r) => {
    const o = {};
    for (const b of r.bindings) o[b.name] = b.value;
    return o;
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  const projectPath = resolve(opts.project);
  const dbPath = join(projectPath, '.grafema', 'graph.rfdb');
  if (!existsSync(dbPath)) {
    console.error(`No graph database at ${dbPath} — run: grafema analyze`);
    process.exit(1);
  }

  const backend = new RFDBServerBackend({ dbPath, clientName: 'profile-graph' });
  await backend.connect();

  try {
    // The run (most recent total_ms / ts).
    const runs = await dl(
      backend,
      'r(R, Ts, Total) :- node(R, "profile:run"), attr(R, "ts", Ts), attr(R, "total_ms", Total).'
    );

    // Every stage with its measures + phase/kind, straight from node metadata.
    const stages = await dl(
      backend,
      's(S, Name, Ms, Edges, Phase, Kind) :- node(S, "profile:stage"), ' +
        'attr(S, "name", Name), attr(S, "wall_ms", Ms), attr(S, "edges_produced", Edges), ' +
        'attr(S, "phase", Phase), attr(S, "kind", Kind).'
    );

    // The PRECEDES route (stage execution order edges).
    const precedes = await dl(backend, 'p(A, B) :- edge(A, B, "PRECEDES").');

    if (stages.length === 0) {
      console.error(
        'No profile:stage nodes found. Either analyze has not run with the ' +
          'profile subgraph enabled, or GRAFEMA_PROFILE_SUBGRAPH=0 was set.'
      );
      process.exit(2);
    }

    const byId = new Map();
    for (const s of stages) {
      byId.set(s.S, {
        id: s.S,
        name: s.Name,
        phase: s.Phase,
        kind: s.Kind,
        wall_ms: Number(s.Ms) || 0,
        edges_produced: Number(s.Edges) || 0,
      });
    }

    // Build the PRECEDES adjacency among known stages.
    const next = new Map(); // id -> id
    const hasIncoming = new Set();
    for (const e of precedes) {
      if (byId.has(e.A) && byId.has(e.B)) {
        next.set(e.A, e.B);
        hasIncoming.add(e.B);
      }
    }

    // Walk each chain from its head (a stage with no incoming PRECEDES) and sum
    // wall_ms. The critical path = the chain with the largest summed wall_ms.
    const chains = [];
    for (const s of byId.values()) {
      if (hasIncoming.has(s.id)) continue;
      const chain = [];
      let cur = s.id;
      const seen = new Set();
      while (cur != null && !seen.has(cur)) {
        seen.add(cur);
        chain.push(byId.get(cur));
        cur = next.get(cur) ?? null;
      }
      const sum = chain.reduce((a, st) => a + st.wall_ms, 0);
      chains.push({ phase: chain[0]?.phase, sum_ms: sum, stages: chain });
    }
    chains.sort((a, b) => b.sum_ms - a.sum_ms);
    const critical = chains[0];

    // Top jams overall by wall_ms.
    const jams = [...byId.values()].sort((a, b) => b.wall_ms - a.wall_ms).slice(0, 12);

    // Dead stages: wall_ms >= threshold AND produced 0 edges (the REG-1128 class).
    const dead = [...byId.values()]
      .filter((s) => s.wall_ms >= opts.deadThresholdMs && s.edges_produced === 0)
      .sort((a, b) => b.wall_ms - a.wall_ms);

    if (opts.json) {
      console.log(
        JSON.stringify({ run: runs[0] ?? null, critical, chains, jams, dead }, null, 2)
      );
      return;
    }

    const run = runs[0];
    console.log('=== PROFILE SUBGRAPH (from the graph) ===');
    if (run) console.log(`run: ${run.Ts}   total_ms=${run.Total}`);
    console.log(`stages: ${byId.size}   chains: ${chains.length}\n`);

    console.log('--- critical path (longest PRECEDES chain by summed wall_ms) ---');
    if (critical) {
      console.log(`phase=${critical.phase}  sum=${(critical.sum_ms / 1000).toFixed(1)}s`);
      for (const s of critical.stages) {
        console.log(
          `  ${String((s.wall_ms / 1000).toFixed(1) + 's').padStart(8)}  ` +
            `${s.name.padEnd(34)} edges=${s.edges_produced}`
        );
      }
    }

    console.log('\n--- top jams (all stages by wall_ms) ---');
    for (const s of jams) {
      console.log(
        `  ${String((s.wall_ms / 1000).toFixed(1) + 's').padStart(8)}  ` +
          `[${s.phase}/${s.kind}] ${s.name.padEnd(34)} edges=${s.edges_produced}`
      );
    }

    console.log(`\n--- dead stages (wall_ms >= ${opts.deadThresholdMs} AND edges_produced=0) ---`);
    if (dead.length === 0) {
      console.log('  (none)');
    } else {
      for (const s of dead) {
        console.log(
          `  ${String((s.wall_ms / 1000).toFixed(1) + 's').padStart(8)}  ` +
            `[${s.phase}/${s.kind}] ${s.name}`
        );
      }
    }
  } finally {
    await backend.close?.();
  }
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});

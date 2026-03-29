#!/usr/bin/env node
/**
 * Quick script: render the Grafema orchestrator in DSL notation.
 * Connects to running RFDB server, extracts subgraph, renders notation.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Resolve from monorepo node_modules
const { RFDBClient } = await import('../packages/rfdb/dist/index.js');
const { extractSubgraph, renderNotation } = await import('../packages/util/dist/index.js');

const SOCKET = '.grafema/rfdb.sock';
// Choose target: orchestrator (Rust) or MCP server (TS)
const target = process.argv[2] || 'orchestrator';

const TARGETS = {
  orchestrator: [
    'MODULE#packages/grafema-orchestrator/src/main.rs',
    'MODULE#packages/grafema-orchestrator/src/lib.rs',
    'MODULE#packages/grafema-orchestrator/src/analyzer.rs',
    'MODULE#packages/grafema-orchestrator/src/config.rs',
    'MODULE#packages/grafema-orchestrator/src/discovery.rs',
    'MODULE#packages/grafema-orchestrator/src/parser.rs',
    'MODULE#packages/grafema-orchestrator/src/plugin.rs',
    'MODULE#packages/grafema-orchestrator/src/process_pool.rs',
    'MODULE#packages/grafema-orchestrator/src/rfdb.rs',
    'MODULE#packages/grafema-orchestrator/src/gc.rs',
    'MODULE#packages/grafema-orchestrator/src/source_hash.rs',
    'MODULE#packages/grafema-orchestrator/src/rust_parser.rs',
    'MODULE#packages/grafema-orchestrator/src/python_parser.rs',
  ],
  mcp: [
    'MODULE#packages/mcp/src/server.ts',
  ],
};

const ORCHESTRATOR_MODULES = TARGETS[target];
if (!ORCHESTRATOR_MODULES) {
  console.error(`Unknown target: ${target}. Use: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(1);
}

async function main() {
  const client = new RFDBClient(SOCKET, 'dsl-render');
  await client.connect();
  console.error('Connected to RFDB server');

  // RFDBClient already implements getNode, getOutgoingEdges, getIncomingEdges
  // — exactly the GraphBackend interface extractSubgraph expects.
  const backend = client;

  const depth = 2;
  const results = [];

  for (const moduleId of ORCHESTRATOR_MODULES) {
    try {
      const subgraph = await extractSubgraph(backend, moduleId, depth);
      if (subgraph.rootNodes.length === 0) {
        console.error(`  ${moduleId} — not found`);
        continue;
      }
      const dsl = renderNotation(subgraph, { depth, budget: 10 });
      results.push(dsl);
    } catch (err) {
      console.error(`  Error rendering ${moduleId}: ${err.message}`);
    }
  }

  console.log(`# Grafema ${target} — DSL Notation\n`);
  console.log(results.join('\n\n'));

  client.close();
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

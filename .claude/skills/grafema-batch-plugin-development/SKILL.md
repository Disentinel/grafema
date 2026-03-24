---
name: grafema-batch-plugin-development
description: |
  How to write a Grafema batch-mode plugin that reads the graph and filesystem,
  then writes new edges/nodes directly to RFDB. Use when: (1) need to add
  project-specific edges that generic analyzers can't produce, (2) need to
  read config files (JSON/YAML) and trace values into code, (3) implementing
  framework-specific resolvers (Django settings, Express routes, pipeline configs).
  Covers: grafema.config.yaml plugin config, RFDB field naming (src/dst NOT
  source/target), addEdges/addNodes API, RFDBServerBackend connection pattern.
author: Claude Code
version: 1.0.0
date: 2026-03-25
---

# Grafema Batch Plugin Development

## Problem
Generic language analyzers (Python, JS, etc.) can't resolve project-specific
patterns like config-driven registries, DI containers, or framework routing.
Batch plugins bridge this gap by reading both the graph AND filesystem.

## Context / Trigger Conditions
- Need to resolve dynamic dependencies driven by config files (JSON, YAML)
- Framework-specific patterns: `importlib.import_module()` + config, DI wiring,
  event dispatch, route→handler mapping
- Generic analyzer produces the base graph, but project-specific edges are missing
- User asks for "project-level plugin" or "config-driven resolution"

## Solution

### 1. Plugin configuration in grafema.config.yaml

```yaml
plugins:
  - name: my-project-plugin
    command: "node my-plugin.mjs"
    mode: batch  # KEY: batch mode gets RFDB_SOCKET env var
```

### 2. Plugin receives environment variables

```
RFDB_SOCKET=/path/to/.grafema/rfdb.sock
RFDB_DATABASE=default
```

### 3. Plugin template (Node.js / ESM)

```javascript
const { RFDBServerBackend } = await import(
  '/path/to/grafema/packages/util/dist/storage/backends/RFDBServerBackend.js'
);

const backend = new RFDBServerBackend({
  socketPath: process.env.RFDB_SOCKET,
  autoStart: false,  // server already running
});
await backend.connect();

// Read existing graph
const allNodes = await backend.getAllNodes();

// Read project config files (filesystem access!)
import { readFileSync } from 'fs';
const config = JSON.parse(readFileSync('config.json', 'utf-8'));

// Build new edges
const newEdges = [];
// ... resolution logic ...

// CRITICAL: use src/dst, NOT source/target
newEdges.push({
  src: sourceNodeId,     // NOT 'source'
  dst: targetNodeId,     // NOT 'target'
  edgeType: 'MY_EDGE',  // NOT 'type' alone
  metadata: { ... },
});

// Write to RFDB
await backend.addEdges(newEdges);
await backend.flush();
await backend.close();
```

### 4. Critical field naming

| Correct | WRONG (silent failure) | What happens |
|---------|----------------------|--------------|
| `src` | `source` | `String(undefined)` = `"undefined"` stored |
| `dst` | `target` | Same — edge created with garbage IDs |
| `edgeType` | `type` only | Works but less explicit |

As of v0.3.22+, validation throws with helpful hints:
```
addEdges: edge at index 0 is missing required 'src' field.
Did you mean 'src'? Found 'source' = 'grafema://...'
```

### 5. Orchestrator execution order

```
Analysis (parse files) → Resolution (python-resolve, etc.)
  → User plugins (your batch plugin runs HERE)
    → Unresolved diagnostics → Module dependency derivation → Metrics
```

Plugin runs AFTER built-in resolution, so it can read resolved edges.

## Verification

After `grafema analyze`, check:
```bash
grafema overview --json | jq '.edgesByType'
```
New edge types from your plugin should appear.

## Example: Pipeline Config Resolver

Resolves `importlib.import_module(f".stages.{name}")` + `pipeline_config.json`:

```javascript
// Find importlib calls in graph
const importlibCalls = allNodes.filter(
  n => n.type === 'CALL' && n.name === 'import_module' && n.receiver === 'importlib'
);

// Read config
const stages = config.pipeline.stages.filter(s => s.enabled);

// For each configured stage, emit REGISTRY_WIRES edge
for (const call of importlibCalls) {
  for (const stage of stages) {
    const targetModule = allNodes.find(
      n => n.type === 'MODULE' && n.file === `pkg/stages/${stage.module}.py`
    );
    if (targetModule) {
      newEdges.push({
        src: call.id,
        dst: targetModule.id,
        edgeType: 'REGISTRY_WIRES',
        metadata: { mechanism: 'importlib', config_source: 'pipeline_config.json' },
      });
    }
  }
}
```

## Notes

- Batch plugins write directly to RFDB — orchestrator reports `nodes=0 edges=0`
  in its log for batch plugins (this is expected, not a bug)
- Plugin runs from the project root directory (where grafema.config.yaml lives)
- Plugin stderr goes to orchestrator log; stdout is captured but ignored for batch mode
- Use `depends_on: ["python-resolution"]` if your plugin needs resolved edges
- getAllNodes() returns ALL nodes including METRIC/ISSUE — filter by type
- Node IDs are URI format: `grafema://host/file#TYPE-%3Ename%5Bscope%5D`

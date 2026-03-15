# Federation MVP Roadmap: Manifests + Effects on Grafema's Own Dependencies

Date: 2026-03-15
Goal: Dogfood the manifest system on Grafema's own dependency tree.
Principle: Show on ourselves first. Each step delivers value independently.

---

## Scope: Grafema's Dependency Tree

### Internal packages (workspace)
```
@grafema/types       → 0 external deps (leaf)
@grafema/rfdb-client → @msgpack/msgpack
@grafema/util        → ajv, minimatch, yaml, @grafema/rfdb-client, @grafema/types
@grafema/api         → graphql, graphql-scalars, graphql-yoga, dataloader
@grafema/mcp         → @modelcontextprotocol/sdk, ajv, yaml
@grafema/cli         → commander, yaml, @grafema/api
```

### External dependencies (11 packages)
```
Level 0 (zero or internal-only deps):
  yaml, commander, minimatch, dataloader, @msgpack/msgpack

Level 1 (deps on level 0):
  ajv, graphql, @anthropic-ai/sdk

Level 2:
  graphql-scalars (→ graphql)
  graphql-yoga (→ graphql, graphql-scalars)
  @modelcontextprotocol/sdk (→ various)
```

Total: 11 external + 6 internal = 17 packages. Perfect MVP scale.

---

## Phase 1: Effects Database for Node.js Builtins

**What**: YAML file mapping Node.js builtin functions to effects.
**How**: Hand-curate top ~200 builtins + use Claude subagents for completeness check.
**Output**: `effects-db/runtimes/node.yaml`
**Value**: Foundation for all subsequent effect propagation.

```yaml
# Example entries
node:fs:
  readFileSync: [IO]
  writeFileSync: [IO, MUTATION]
  readFile: [IO, ASYNC]
  existsSync: [IO]
  mkdirSync: [IO, MUTATION]

node:path:
  join: [PURE]
  resolve: [PURE]
  parse: [PURE]

node:crypto:
  createHash: [PURE]
  randomBytes: [NONDETERMINISTIC]
  randomUUID: [NONDETERMINISTIC]

node:child_process:
  exec: [IO, ASYNC]
  execSync: [IO]
  spawn: [IO, ASYNC]

node:net:
  createServer: [IO, ASYNC]
  connect: [IO, ASYNC]

node:console:
  log: [IO]
  error: [IO]
  warn: [IO]

node:process:
  exit: [IO, THROW]
  cwd: [IO]
  env: [IO]
```

### Subtasks
- [ ] Create `effects-db/runtimes/node.yaml` — core modules (fs, path, crypto, net, http, etc.)
- [ ] Create `effects-db/taxonomy.yaml` — effect type definitions
- [ ] Validate: spawn 3 Claude subagents to independently verify completeness and correctness
- [ ] Cross-validate: check for contradictions between passes

---

## Phase 2: Effects for Grafema's 11 External Dependencies

**What**: Generate effect annotations for each external package.
**How**: Hybrid pipeline — Grafema analysis + Claude inference + cross-validation.
**Output**: `effects-db/packages/<name>.yaml` per package.

### Topological order (analyze leaves first):

```
Batch 1 (zero external deps):
  yaml           — YAML parser, likely PURE
  commander      — CLI framework, IO (reads argv, writes stdout)
  minimatch      — glob matching, PURE
  dataloader     — batching, ASYNC
  @msgpack/msgpack — serialization, PURE

Batch 2 (deps on batch 1):
  ajv            — JSON schema validator, PURE (mostly)
  graphql        — query parser/executor, PURE (mostly)
  @anthropic-ai/sdk — API client, IO + ASYNC

Batch 3 (deps on batch 2):
  graphql-scalars  — custom scalars, PURE
  graphql-yoga     — HTTP server, IO + ASYNC
  @modelcontextprotocol/sdk — MCP protocol, IO + ASYNC
```

### Per-package pipeline:
1. `npm pack <package>` → get source
2. Grafema analyze → call graph + partial effects from builtins
3. Claude subagent 1: "Given this README and export list, annotate effects"
4. Claude subagent 2: independent pass, different prompt
5. Reconcile: agreement → high confidence, disagreement → UNKNOWN
6. Output: `effects-db/packages/<name>.yaml`
7. Verify: spot-check a few functions manually

### Subtasks
- [ ] Batch 1: 5 packages, parallel subagents (10 total — 2 per package)
- [ ] Batch 2: 3 packages
- [ ] Batch 3: 3 packages
- [ ] Cross-validate all results
- [ ] Write final effects-db entries

---

## Phase 3: Manifest Format Implementation

**What**: TypeScript code that generates manifest.yaml from Grafema graph.
**How**: Query graph for MODULE nodes with exports → serialize to manifest format.
**Output**: `grafema analyze` produces `.grafema/manifest.yaml` alongside graph.

### Implementation:
```
Input:  Grafema graph (nodes + edges)
Process:
  1. Find MODULE nodes → package boundary
  2. Find exported symbols (EXPORTS edge from MODULE)
  3. For each export: name, kind, semanticId
  4. Look up effects from effects-db (builtins) + compute transitively via call graph
  5. Determine flow types (IN/OUT/PIPE/SINK) from data flow edges
  6. Collect imports (IMPORTS_FROM edges to external packages)
  7. Generate capabilities summary (node counts, edge types)
Output: manifest.yaml
```

### Subtasks
- [ ] Define ManifestSchema (TypeScript types)
- [ ] Implement ManifestGenerator class
- [ ] Wire into `grafema analyze` post-processing
- [ ] Test: generate manifest for @grafema/types (simplest, zero deps)
- [ ] Test: generate manifest for @grafema/util (has external deps)
- [ ] Validate: generated manifest matches hand-written expectations

---

## Phase 4: Manifests for Grafema's Own Packages

**What**: Run the full pipeline on Grafema's own monorepo.
**How**: `grafema analyze` each internal package → manifest.
**Output**: `.grafema/manifest.yaml` in each package directory.

### Order (topological):
```
1. @grafema/types        → leaf, no deps
2. @grafema/rfdb-client  → depends on @msgpack/msgpack
3. @grafema/util         → depends on types, rfdb-client, ajv, minimatch, yaml
4. @grafema/api          → depends on types, util, graphql-*
5. @grafema/mcp          → depends on types, util, @modelcontextprotocol/sdk
6. @grafema/cli          → depends on types, util, api, commander
```

### Verification:
- Each manifest should list correct exports (compare with actual index.ts)
- Effects should propagate correctly (util functions that call fs → IO)
- Imports should reference correct purls
- Cross-check: `grafema effects check @grafema/util` matches expectations

### Subtasks
- [ ] Generate manifest for @grafema/types
- [ ] Generate manifest for @grafema/rfdb-client
- [ ] Generate manifest for @grafema/util (first real test — has builtins + external deps)
- [ ] Generate manifests for api, mcp, cli
- [ ] Review all manifests for correctness
- [ ] Demo: show effect propagation working end-to-end

---

## Phase 5: Import Resolution via Manifests

**What**: When Grafema encounters `import { foo } from 'yaml'`, resolve against manifest.
**How**: Look up manifest in effects-db or node_modules/.grafema/manifest.yaml.
**Output**: IMPORTS_FROM edges resolve to proxy nodes with effect annotations.

### Subtasks
- [ ] Implement manifest lookup (effects-db → node_modules → CDN fallback)
- [ ] Create proxy nodes for external symbols
- [ ] Wire effect annotations from manifest into proxy nodes
- [ ] Test: import resolution for @grafema/cli → commander, yaml resolved
- [ ] Verify: `trace_dataflow` through proxy nodes shows correct effects

---

## Success Criteria

After all phases, running `grafema analyze` on the Grafema monorepo should:

1. **Generate manifests** for all 6 internal packages automatically
2. **Resolve imports** from 11 external packages via effects-db manifests
3. **Show effects** for any function: `grafema effects check packages/cli/src/commands/analyze.ts`
   ```
   analyze() → effects: [IO, ASYNC]
     calls readConfig() → [IO]        (transitively: yaml.parse [PURE] + fs.readFile [IO])
     calls runAnalysis() → [IO, ASYNC] (transitively: child_process.spawn [IO, ASYNC])
   ```
4. **Flag unknowns**: functions calling into unanalyzed code show `[UNKNOWN]`

---

## Grafema Incremental Analysis Side-Job

During implementation, use Grafema's own MCP tools to:
- Query the graph while writing code (dogfooding)
- Test incremental analysis: after each code change, re-analyze affected package only
- Measure: how much time does incremental save vs full?
- Track gaps: where does the graph fail to answer questions about the code being written?
- Report findings in `_ai/gaps.md`

This is both validation of the federation concept (per-package analysis)
and dogfooding of the incremental workflow.

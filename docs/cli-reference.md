# Grafema feature catalogue

_33 features exported._

## Contents

- [`cli:command` `analyze`](#clicommand-analyze)
- [`cli:command` `build`](#clicommand-build)
- [`cli:command` `check`](#clicommand-check)
- [`cli:command` `context`](#clicommand-context)
- [`cli:command` `coverage`](#clicommand-coverage)
- [`cli:command` `describe`](#clicommand-describe)
- [`cli:command` `doctor`](#clicommand-doctor)
- [`cli:command` `explain`](#clicommand-explain)
- [`cli:command` `export`](#clicommand-export)
- [`cli:command` `features`](#clicommand-features)
- [`cli:command` `file`](#clicommand-file)
- [`cli:command` `get`](#clicommand-get)
- [`cli:command` `git-ingest`](#clicommand-git-ingest)
- [`cli:command` `graphql`](#clicommand-graphql)
- [`cli:command` `impact`](#clicommand-impact)
- [`cli:command` `init`](#clicommand-init)
- [`cli:command` `list`](#clicommand-list)
- [`cli:command` `ls`](#clicommand-ls)
- [`cli:command` `overview`](#clicommand-overview)
- [`cli:command` `query`](#clicommand-query)
- [`cli:command` `resolve`](#clicommand-resolve)
- [`cli:command` `restart`](#clicommand-restart)
- [`cli:command` `setup-skill`](#clicommand-setup-skill)
- [`cli:command` `start`](#clicommand-start)
- [`cli:command` `stats`](#clicommand-stats)
- [`cli:command` `status`](#clicommand-status)
- [`cli:command` `stop`](#clicommand-stop)
- [`cli:command` `tldr`](#clicommand-tldr)
- [`cli:command` `trace`](#clicommand-trace)
- [`cli:command` `types`](#clicommand-types)
- [`cli:command` `who`](#clicommand-who)
- [`cli:command` `why`](#clicommand-why)
- [`cli:command` `wtf`](#clicommand-wtf)

## `cli:command` `analyze`

**File**: `packages/cli/src/commands/analyze.ts`
**Modality**: `cli:command`

### When to use

Builds (or rebuilds) the code graph. Run after a fresh `init`, after
major refactors, or when you `git pull` significant changes. For
incremental updates, `analyze` reuses cached parser output where
possible. Pass `--clear` to drop all existing data and rebuild from
scratch — useful when extractor logic changes upstream.

### Contract — commander

Run project analysis

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | yes | `.` | Project path to analyze |
| `--service` | `string` | yes |  | Analyze only a specific service |
| `--entrypoint` | `string` | yes |  | Override entrypoint (bypasses auto-detection) |
| `--clear` | `boolean` | yes |  | Clear existing database before analysis |
| `--quiet` | `boolean` | yes |  | Suppress progress output |
| `--verbose` | `boolean` | yes |  | Show verbose logging |
| `--debug` | `boolean` | yes |  | Enable debug mode (writes diagnostics.log) |
| `--log-level` | `string` | yes |  | Set log level (silent, errors, warnings, info, debug) |
| `--log-file` | `string` | yes |  | Write all log output to a file |
| `--strict` | `boolean` | yes |  | Enable strict mode (fail on unresolved references) |
| `--resolve-jobs` | `string` | yes |  | Number of parallel resolve workers (default: auto based on CPU and memory) |
| `--no-auto-start` | `boolean` | yes |  | Do not auto-start RFDB server (require manual start) |
| `--quickstart` | `boolean` | yes |  | Auto-initialize if no config exists (scan project, generate config) |

### Examples

**Full analysis**

```sh
grafema analyze
```

```
Discovering 547 source files (2 services)
Indexing                  ...  ✓ 547 modules
Parsing                   ...  ✓ 547 modules
Analyzing                 ...  ✓ 6 171 functions, 1 247 classes
Resolving                 ...  ✓ 8 905 cross-file edges
Enriching                 ...  ✓ 142 features, 119 behaviors, 112 contracts
Validating                ...  ✓ 0 critical, 14 warnings

Analysis complete in 84.2s
  Nodes: 434 363
  Edges: 796 076
  Library callbacks: 142 domain nodes (33 cli:command, 45 mcp:tool, 40 vscode:command, 24 package:export, 0 http:route)
  Contracts: 112 contracts (274 inputs, 34 outputs, 0 errors); 8 features lacked HANDLES edge
  Speced contracts: 112 (274 inputs); byCategory={"cli:command":35,"mcp:tool":40,"vscode:command":37}; missingExtractor=200, missingSpec=8
  Behaviors: 119 BEHAVIOR nodes, 0 SHARES_BEHAVIOR_WITH edges
  Manifest: .grafema/manifest.yaml
```
*Captured 2026-04-27.*

**Force rebuild (drops cache)**

```sh
grafema analyze --clear
```

### Behavior

- Effects: PURE
- Transitive calls: 1
- Depth: 10

### Gotchas

- Long-running on first run (~1 min per 1k files for JS/TS). Subsequent runs use the resolver cache and are dramatically faster.
- The Rust orchestrator must be installable for the host platform — `grafema doctor` confirms this.

### See also

- `cli:command:init`
- `cli:command:resolve`
- `cli:command:overview`

## `cli:command` `build`

**File**: `packages/cli/src/commands/registry.ts`
**Modality**: `cli:command`

### Contract — commander

Build manifest registry for npm dependencies

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | yes | `.` | Project path |
| `--packages` | `string` | yes |  | Comma-separated package names to build |
| `--all` | `boolean` | yes |  | Build all discovered dependencies |
| `--force` | `boolean` | yes |  | Rebuild even if manifest exists |
| `--verbose` | `boolean` | yes |  | Show detailed output |
| `--skip` | `string` | yes |  | Comma-separated package names to skip |
| `--timeout` | `string` | yes | `600000` | Max per-package timeout in ms (adaptive by default) |
| `--max-files` | `string` | yes | `5000` | Skip packages exceeding this file count |

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `cli:command` `check`

**File**: `packages/cli/src/commands/check.ts`
**Modality**: `cli:command`

### When to use

CI gate. Runs every guarantee declared in `.grafema/guarantees.yaml`
against the current graph and exits non-zero if any are violated.
Use as the final step in your pipeline to fail builds when an
architectural rule is broken (e.g., "no SQL inside HTTP handlers").

### Contract — commander

Check invariants/guarantees

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `rule` | `string` | yes |  | Specific rule ID to check (or "all" for all rules) |
| `--project` | `string` | yes | `.` | Project path |
| `--file` | `string` | yes |  | Path to guarantees YAML file |
| `--guarantee` | `string` | yes |  | Run a built-in guarantee validator |
| `--json` | `boolean` | yes |  | Output results as JSON |
| `--quiet` | `boolean` | yes |  | Only output failures |
| `--list-guarantees` | `boolean` | yes |  | List available built-in guarantees |
| `--list-categories` | `boolean` | yes |  | List available diagnostic categories |
| `--skip-reanalysis` | `boolean` | yes |  | Skip automatic reanalysis of stale modules |
| `--fail-on-stale` | `boolean` | yes |  | Exit with error if stale modules found (CI mode) |

### Examples

**Run all guarantees**

```sh
grafema check
```

```
Running 7 guarantees from .grafema/guarantees.yaml:

  ✓ no-sql-in-handlers          (0 violations)
  ✓ public-api-no-private-deps  (0 violations)
  ✗ effects-declared            (3 violations)
    - cli:command 'analyze'      declares no effects but PRODUCES_EFFECT FS_WRITE
    - mcp:tool   'add_knowledge' declares no effects but PRODUCES_EFFECT FS_WRITE
    - http:route 'POST /save'    declares no effects but PRODUCES_EFFECT DB_WRITE
  ✓ no-direct-fs-imports        (0 violations)
  ✓ test-coverage-gate          (84.2 %, threshold 80 %)
  ✓ no-circular-imports         (0 violations)
  ✓ all-features-have-contract  (0 violations)

Status: 1 guarantee failed (3 violations)
Exit code: 1
```
*Captured 2026-04-27.*

**List available diagnostic categories**

```sh
grafema check --list-categories
```

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Empty `.grafema/guarantees.yaml` → exits 0 with a no-op message. Add guarantees via the MCP tool `create_guarantee` or hand-edit.
- Each guarantee is a Datalog rule; if a predicate is unknown the rule is skipped with a warning rather than crashing.

### See also

- `mcp:tool:check_guarantees`
- `mcp:tool:create_guarantee`
- `mcp:tool:list_guarantees`

## `cli:command` `context`

**File**: `packages/cli/src/commands/context.ts`
**Modality**: `cli:command`

### Contract — commander

Show deep context for a graph node: source code + graph neighborhood

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `semanticId` | `string` | no |  | Semantic ID of the node (exact match) |
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON (full dump, no filtering) |
| `--lines` | `string` | yes | `3` | Context lines around each code reference |
| `--edge-type` | `string` | yes |  | <template> |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `cli:command` `coverage`

**File**: `packages/cli/src/commands/coverage.ts`
**Modality**: `cli:command`

### Contract — commander

Show analysis coverage statistics

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |
| `--verbose` | `boolean` | yes |  | Show detailed file lists |

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `cli:command` `describe`

**File**: `packages/cli/src/commands/describe.ts`
**Modality**: `cli:command`

### When to use

Deep-dive into a single node. Returns operator-shorthand DSL with
the node's relationships: imports, exports, calls, throws, reads,
writes. Use after `tldr` (file overview) or `who` (caller list)
zooms you in on a candidate node — `describe` is the next click.

### Contract — commander

Render compact DSL notation for a graph node

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `target` | `string` | no |  | Semantic ID, file path, or node name |
| `--project` | `string` | yes | `.` | Project path |
| `--depth` | `string` | yes | `1` | LOD: 0=names, 1=edges, 2=nested+fold, 3=nested (exact) |
| `--perspective` | `string` | yes |  | <template> |
| `--budget` | `string` | yes |  | Max items before summarization (default 7) |
| `--json` | `boolean` | yes |  | Output as JSON for scripting |
| `--locations` | `boolean` | yes |  | Include file:line locations |

### Examples

**Describe a single node**

```sh
grafema describe handleRequest
```

```
handleRequest
```
*Captured 2026-04-27.*

**With deeper expansion**

```sh
grafema describe handleRequest --depth 2
```

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Pass a semantic ID (e.g. `cli:command:'analyze'@packages/cli/...`) for precision. Bare names work via fuzzy resolution but may pick a sibling.

### See also

- `cli:command:tldr`
- `cli:command:get`
- `mcp:tool:describe`

## `cli:command` `doctor`

**File**: `packages/cli/src/commands/doctor.ts`
**Modality**: `cli:command`

### When to use

Health check before you start debugging. Reports: which analyzer
binaries are present (or downloadable), config file validity, RFDB
server reachability, schema version compatibility. Run when
`analyze` fails mysteriously or after upgrading Grafema.

### Contract — commander

Diagnose Grafema setup issues

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |
| `--quiet` | `boolean` | yes |  | Only show failures |
| `--verbose` | `boolean` | yes |  | Show detailed diagnostics |

### Examples

**Local environment health**

```sh
grafema doctor
```

```
Checking Grafema setup...

✓ Binaries: rfdb-server (monorepo (release)), grafema-orchestrator (monorepo (release))
✓ Config file: .grafema/config.yaml
✓ Entrypoints: 9 service(s) found
✓ Server: connected (RFDB 0.3.24)
✓ Database: .grafema/graph.rfdb
✓ Graph: 434 363 nodes, 796 076 edges
✓ Server freshness: graph last analyzed 2 minutes ago
✓ CLI 0.3.24, Core 0.3.24

Status: healthy
```
*Captured 2026-04-27.*

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

### Gotchas

- On a fresh install some analyzers download lazily on first `analyze` — `doctor` shows them as "downloadable", not missing. That's fine.

### See also

- `cli:command:analyze`
- `cli:command:overview`

## `cli:command` `explain`

**File**: `packages/cli/src/commands/explain.ts`
**Modality**: `cli:command`

### Contract — commander

Show what nodes exist in a file

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `file` | `string` | no |  | File path to explain |
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `cli:command` `export`

**File**: `packages/cli/src/commands/schema.ts`
**Modality**: `cli:command`

### When to use

Emit a documentation/spec artifact from the live graph. Replaces
hand-maintained Swagger/OpenAPI/MCP-tool-registry/docs files that
drift from reality. Pick a format with `--as` and a feature pattern
with `--feature`. Same data → many target formats.

### Contract — commander

Export interface or graph schema

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `--interface` | `string` | yes |  | Interface name to export |
| `--graph` | `boolean` | yes |  | Export graph node/edge type schema |
| `--all` | `boolean` | yes |  | Include all defined types, not just used ones (with --graph) |
| `--file` | `string` | yes |  | File path filter (for multiple interfaces with same name) |
| `--format` | `string` | yes | `json` | Output format: json, yaml, markdown |
| `--project` | `string` | yes | `.` | Project path |
| `--output` | `string` | yes |  | Output file (default: stdout) |

### Examples

**Single-feature documentation card**

```sh
grafema export --feature "cli:command:tldr" --as docs-md
```

```
## `cli:command` `tldr`

**File**: `packages/cli/src/commands/tldr.ts`
**Modality**: `cli:command`

### When to use

Reading a file from scratch is slow. Use `tldr` for a 30-second
structural overview before deciding whether to dive in. Returns
imports, exports, calls, and key relationships in operator-shorthand
notation — typically 10-20× shorter than the source. Especially
useful for AI agents that have a fixed context budget and humans
scanning unfamiliar code.

### Contract — commander

What's in this file? — compact DSL overview

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `file` | `string` | no |  | File path to describe |
| `--project` | `string` | yes | `.` | Project path |
| `--save` | `boolean` | yes |  | Save output to <file>.<ext> |
| `--ext` | `string` | yes | `.tldr` | File extension for --save |

... (truncated, 54 more lines)
```
*Captured 2026-04-27.*

**Full MCP tool registry as JSON**

```sh
grafema export --feature "mcp:tool" --as mcp-schema --output tools.json
```

**OpenAPI for HTTP routes**

```sh
grafema export --feature "http:route" --as openapi-3.1 --output api.yaml
```

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

### Gotchas

- `--as openapi-3.1` only emits HTTP routes; the renderer rejects unsupported categories with a clear error. `--as docs-md` accepts everything.
- Output files in `_ai/intents/<category>/<name>.md` add a "When to use" / "Examples" section to docs-md output. See `_ai/intents/cli-command/tldr.md` as a reference.

### See also

- `cli:command:features`
- `cli:command:describe`

## `cli:command` `features`

**File**: `packages/cli/src/commands/features.ts`
**Modality**: `cli:command`

### When to use

Surfaces FEATURE-level cross-modality insights. Today: `--duplicates`
lists groups of FEATUREs (CLI commands, MCP tools, HTTP routes,
vscode commands, package exports) that share an identical BEHAVIOR
hash — i.e., "this CLI command and this MCP tool are thin wrappers
around the same library function." Useful for finding consolidation
opportunities or confirming intentional cross-modality design.

### Contract — commander

List FEATURE-level cross-modality insights (e.g. duplicate behaviors)

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |
| `--duplicates` | `boolean` | yes |  | List clusters of FEATUREs that share a BEHAVIOR |
| `--min-cluster-size` | `string` | yes | `2` | Minimum features per cluster (default: 2) |
| `--limit` | `string` | yes | `100` | Maximum clusters to return (default: 100) |

### Examples

**Find duplicate behaviors**

```sh
grafema features --duplicates
```

```
No FEATUREs share a BEHAVIOR (each entry-point has a unique implementation).
```
*Captured 2026-04-27.*

**JSON output**

```sh
grafema features --duplicates --json
```

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Empty result on small projects with single-modality features — you need cross-modality to see anything. On Grafema itself: 0 clusters at the time of writing.

### See also

- `cli:command:export`
- `mcp:tool:find_shared_behaviors`

## `cli:command` `file`

**File**: `packages/cli/src/commands/file.ts`
**Modality**: `cli:command`

### Contract — commander

Show structured overview of a file: imports, exports, classes, functions with relationships

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | no |  | File path to analyze |
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |
| `--no-edges` | `boolean` | yes |  | Skip edge resolution (faster, just list entities) |

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `cli:command` `get`

**File**: `packages/cli/src/commands/get.ts`
**Modality**: `cli:command`

### When to use

Fetch a single node by its semantic ID. Use after `ls` or `query`
hand you back an ID — `get` returns its full attributes (file, line,
exports, imports, metadata). Cheaper than `describe` when you just
need fields, not relationships.

### Contract — commander

Retrieve a node by its semantic ID

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `semantic-id` | `string` | no |  | Semantic ID of the node (e.g., "file.js->scope->TYPE->name") |
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |

### Examples

**Get a node by semantic ID**

```sh
grafema get "packages/util/src/enrichers/specedContractEnricher.ts->FUNCTION->enrichSpecedContracts"
```

```
[exit code 1]
✗ Node not found

→ ID: packages/util/src/enrichers/specedContractEnricher.ts->FUNCTION->enrichSpecedContracts
→ Try: grafema query "<name>" to search for nodes
```
*Captured 2026-04-27.*

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Semantic IDs include `::`, `@`, `<…>` — quote the ID when passing as shell argument so the shell doesn't expand parts.

### See also

- `cli:command:describe`
- `cli:command:ls`
- `mcp:tool:get_node`

## `cli:command` `git-ingest`

**File**: `packages/cli/src/commands/git-ingest.ts`
**Modality**: `cli:command`

### Contract — commander

Ingest git history into the knowledge layer

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | yes | `.` | Repository path |
| `--full` | `boolean` | yes |  | Full re-ingest (rebuilds derived/) |
| `--since` | `string` | yes |  | Ingest from date (ISO format) |
| `--branch` | `string` | yes |  | Ingest specific branch |

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `cli:command` `graphql`

**File**: `packages/cli/src/commands/server.ts`
**Modality**: `cli:command`

### Contract — commander

Start GraphQL API server (requires RFDB server running)

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `--project` | `string` | yes | `.` | Project path |
| `--port` | `string` | yes | `4000` | Port to listen on |
| `--host` | `string` | yes | `localhost` | Hostname to bind to |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `cli:command` `impact`

**File**: `packages/cli/src/commands/impact.ts`
**Modality**: `cli:command`

### When to use

"If I change X, what else breaks?" Returns the downstream impact
set — every node reachable from X via CALLS / READS_FROM / IMPORTS_FROM.
Use before refactoring a hub function, before deprecating a public
API, before changing a protected method's signature.

### Contract — commander

Analyze change impact for a function or class

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `pattern` | `string` | no |  | Target: "function X" or "class Y" or just "X" |
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |
| `--depth` | `string` | yes | `10` | Max traversal depth |

### Examples

**Impact of changing a function**

```sh
grafema impact handleRequest
```

```
Analyzing impact of changing handleRequest...

No node "handleRequest" found
```
*Captured 2026-04-27.*

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Reports nodes, not callers — use `who` if you want the call-site list. `impact` is about "what data depends on this", `who` is "what code calls this".
- Default depth 5; pass `--depth 10` for deeper hubs.

### See also

- `cli:command:who`
- `mcp:tool:trace_dataflow`

## `cli:command` `init`

**File**: `packages/cli/src/commands/init.ts`
**Modality**: `cli:command`

### When to use

First command in a Grafema project. `init` scans the repo, detects
language(s) and entry points, and writes `.grafema/config.yaml` with
sensible defaults. Run once per project; afterwards just `analyze`.
For zero-config flow, skip and use `grafema analyze --quickstart`
which auto-init's on first run.

### Contract — commander

Initialize Grafema in current project

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | yes | `.` | Project path |
| `--force` | `boolean` | yes |  | Overwrite existing config |
| `--yes` | `boolean` | yes |  | Skip prompts (non-interactive mode) |

### Examples

**Initialize a project**

```sh
grafema init
```

```
Scanning packages/ (depth 3) ...
  Found 9 services:
    - @grafema/util  (TypeScript)
    - @grafema/cli   (TypeScript)
    - @grafema/mcp   (TypeScript)
    - @grafema/gui   (TypeScript)
    - rfdb-server    (Rust)
    - rfdb           (Rust)
    - js-analyzer    (Haskell)
    - python-analyzer (Haskell)
    - grafema-orchestrator (Rust)

Detected entry points: package.json#main, src/index.ts, Cargo.toml [bin]
Languages enabled: typescript, rust, haskell

Wrote .grafema/config.yaml
Updated .gitignore (added .grafema/graph.rfdb, .grafema/rfdb.sock)

Next: grafema analyze
```
*Captured 2026-04-27.*

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

### Gotchas

- Won't overwrite an existing `.grafema/config.yaml`. Delete or rename it first if you want to re-run from scratch.

### See also

- `cli:command:analyze`
- `cli:command:doctor`

## `cli:command` `list`

**File**: `packages/cli/src/commands/registry.ts`
**Modality**: `cli:command`

### Contract — commander

List packages in the local registry

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | yes | `.` | Project path |

### Behavior

- Effects: PURE
- Transitive calls: 1
- Depth: 10

## `cli:command` `ls`

**File**: `packages/cli/src/commands/ls.ts`
**Modality**: `cli:command`

### When to use

List nodes by type. Use when you want to enumerate "all functions in
this file", "every CLASS in the project", "all HTTP routes". Returns
bare names + locations — for full structure pass to `describe` or
`get`. Fastest way to scan a category.

### Contract — commander

List nodes by type

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `--type` | `string` | no |  | Node type to list (required) |
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |
| `--limit` | `string` | yes | `50` | Limit results (default: 50) |

### Examples

**Every CLASS in the project**

```sh
grafema ls --type CLASS
```

```
[CLASS] (50 of 90):

  KnowledgeBase  (packages/util/src/knowledge/KnowledgeBase.ts:27)
  GrafemaError  (packages/util/src/errors/GrafemaError.ts:46)
  SemanticAddressResolver  (packages/util/src/knowledge/SemanticAddressResolver.ts:57)
  ProgressRenderer  (packages/cli/src/utils/progressRenderer.ts:53)
  StrictModeFailure  (packages/util/src/errors/GrafemaError.ts:280)
  ValidationError  (packages/util/src/errors/GrafemaError.ts:194)
  GitIngest  (packages/util/src/knowledge/git-ingest.ts:153)
  ConfigError  (packages/util/src/errors/GrafemaError.ts:87)
  AnalysisError  (packages/util/src/errors/GrafemaError.ts:167)
  LanguageError  (packages/util/src/errors/GrafemaError.ts:119)
  PluginError  (packages/util/src/errors/GrafemaError.ts:151)
  DatabaseError  (packages/util/src/errors/GrafemaError.ts:135)
  Spinner  (packages/cli/src/utils/spinner.ts:17)
  StrictModeError  (packages/util/src/errors/GrafemaError.ts:227)
  FileAccessError  (packages/util/src/errors/GrafemaError.ts:103)
  DiagnosticReporter  (packages/util/src/diagnostics/DiagnosticReporter.ts:68)
  EffectsLookup  (packages/util/src/manifest/effects-lookup.ts:56)
  HexLayer  (packages/gui/src/three/HexLayer.ts:172)
  DiagnosticWriter  (packages/util/src/diagnostics/DiagnosticWriter.ts:23)
  HullLayer  (packages/gui/src/three/HullLayer.ts:59)
  ShardDiscovery  (packages/util/src/federation/ShardDiscovery.ts:32)
  FederatedRouter  (packages/util/src/federation/FederatedRouter.ts:108)
  ManifestResolver  (packages/util/src/manifest/resolver.ts:36)
... (truncated, 29 more lines)
```
*Captured 2026-04-27.*

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

### Gotchas

- Without `--type` it lists every node — usually not what you want. Default is FUNCTION.

### See also

- `cli:command:get`
- `cli:command:query`
- `mcp:tool:find_nodes`

## `cli:command` `overview`

**File**: `packages/cli/src/commands/overview.ts`
**Modality**: `cli:command`

### When to use

Project-level dashboard: file count, node-type counts, edge counts,
feature counts, ISSUE summary, METRIC summary. Use after `analyze`
to confirm the analysis covered what you expected — if `MODULE: 0`
appears, your config's `include` glob isn't matching anything.

### Contract — commander

Show project overview and statistics

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |

### Examples

**Project-wide overview**

```sh
grafema overview
```

```

📊 Project Overview

Code Structure:
├─ Modules: 567
├─ Functions: 6352
├─ Classes: 90
├─ Variables: 1056
└─ Call sites: 29505

External Interactions:
└─ External modules: 10

Graph Statistics:
├─ Total nodes: 261761
├─ Total edges: 519144
├─ Calls: 11053
├─ Contains: 237182
└─ Imports: 0

Next steps:
→ grafema query "function <name>"   Search for a function
→ grafema trace "<var> from <fn>"   Trace data flow
→ grafema impact "<target>"         Analyze change impact
→ grafema explore                   Interactive navigation
```
*Captured 2026-04-27.*

**JSON output for scripting**

```sh
grafema overview --json
```

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

### Gotchas

- Counts include diagnostic node types (METRIC, ISSUE) — not just code. Subtract them if you want a "pure code" total.

### See also

- `cli:command:stats`
- `cli:command:doctor`
- `mcp:tool:get_stats`

## `cli:command` `query`

**File**: `packages/cli/src/commands/query.ts`
**Modality**: `cli:command`

### When to use

Free-form search by name, type, route, or scope. Use for "I know
roughly what I'm looking for" cases when you don't have a precise
symbol. For Datalog-level queries, pass `--raw '<datalog>'`.

### Contract — commander

Search the code graph

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `pattern` | `string` | no |  | Search pattern: "function X", "class Y", or just "X" |
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |
| `--limit` | `string` | yes | `10` | Limit results |
| `--raw` | `boolean` | yes |  | <template> |
| `--cypher` | `boolean` | yes |  | <template> |
| `--explain` | `boolean` | yes |  | <template> |
| `--type` | `string` | yes |  | <template> |

### Examples

**Find by name**

```sh
grafema query authenticate
```

```
No results for "authenticate"
```
*Captured 2026-04-27.*

**Datalog raw query**

```sh
grafema query --raw 'violation(F) :- node(F, "FUNCTION"), \+ edge(_, F, "CALLS").'
```

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- The DSL parses your query — `function login` matches type=FUNCTION name=login, but ambiguous text falls back to substring search.
- Datalog `--raw` queries fail open with a helpful warning if predicates are unknown — typos won't crash.

### See also

- `cli:command:ls`
- `cli:command:get`
- `mcp:tool:query_graph`
- `mcp:tool:find_nodes`

## `cli:command` `resolve`

**File**: `packages/cli/src/commands/resolve.ts`
**Modality**: `cli:command`

### Contract — commander

Re-run resolution phase on an already-analyzed project

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | yes | `.` | Project path |
| `--quiet` | `boolean` | yes |  | Suppress progress output |
| `--verbose` | `boolean` | yes |  | Show verbose logging |
| `--debug` | `boolean` | yes |  | Enable debug mode |
| `--log-level` | `string` | yes |  | Set log level (silent, errors, warnings, info, debug) |
| `--log-file` | `string` | yes |  | Write all log output to a file |
| `--jobs` | `string` | yes |  | Number of parallel resolve workers (default: auto) |
| `--no-auto-start` | `boolean` | yes |  | Do not auto-start RFDB server (require manual start) |

### Behavior

- Effects: PURE
- Transitive calls: 1
- Depth: 10

## `cli:command` `restart`

**File**: `packages/cli/src/commands/server.ts`
**Modality**: `cli:command`

### Contract — commander

Restart the RFDB server (stop if running, then start)

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `--project` | `string` | yes | `.` | Project path |
| `--binary` | `string` | yes |  | Path to rfdb-server binary |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `cli:command` `setup-skill`

**File**: `packages/cli/src/commands/setup-skill.ts`
**Modality**: `cli:command`

### Contract — commander

Install Grafema Agent Skill into your project

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | yes | `.` | Project path |
| `--output-dir` | `string` | yes |  | Custom output directory (overrides --platform) |
| `--platform` | `string` | yes | `claude` | Target platform: claude, gemini, cursor |
| `--force` | `boolean` | yes |  | Overwrite existing skill |

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `cli:command` `start`

**File**: `packages/cli/src/commands/server.ts`
**Modality**: `cli:command`

### Contract — commander

Start the RFDB server

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `--project` | `string` | yes | `.` | Project path |
| `--binary` | `string` | yes |  | Path to rfdb-server binary |
| `--foreground` | `boolean` | yes |  | Run in foreground with request logging (Ctrl+C to stop) |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `cli:command` `stats`

**File**: `packages/cli/src/commands/stats.ts`
**Modality**: `cli:command`

### Contract — commander

Show project statistics

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |
| `--types` | `boolean` | yes |  | Show breakdown by type |

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `cli:command` `status`

**File**: `packages/cli/src/commands/registry.ts`
**Modality**: `cli:command`

### Contract — commander

Show registry build status vs installed dependencies

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `path` | `string` | yes | `.` | Project path |

### Behavior

- Effects: PURE
- Transitive calls: 1
- Depth: 10

## `cli:command` `stop`

**File**: `packages/cli/src/commands/server.ts`
**Modality**: `cli:command`

### Contract — commander

Stop the RFDB server

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `--project` | `string` | yes | `.` | Project path |

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

## `cli:command` `tldr`

**File**: `packages/cli/src/commands/tldr.ts`
**Modality**: `cli:command`

### When to use

Reading a file from scratch is slow. Use `tldr` for a 30-second
structural overview before deciding whether to dive in. Returns
imports, exports, calls, and key relationships in operator-shorthand
notation — typically 10-20× shorter than the source. Especially
useful for AI agents that have a fixed context budget and humans
scanning unfamiliar code.

### Contract — commander

What's in this file? — compact DSL overview

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `file` | `string` | no |  | File path to describe |
| `--project` | `string` | yes | `.` | Project path |
| `--save` | `boolean` | yes |  | Save output to <file>.<ext> |
| `--ext` | `string` | yes | `.tldr` | File extension for --save |

### Examples

**Compact overview of a single command file**

```sh
grafema tldr packages/cli/src/commands/doctor.ts
```

```
/Users/vadimr/grafema-worker-1/packages/cli/src/commands/doctor.ts  (packages/cli/src/commands/doctor.ts:1) {
  o- depends on /Users/vadimr/grafema-worker-1/packages/cli/src/commands/doctor/output.ts, /Users/vadimr/grafema-worker-1/packages/cli/src/commands/doctor/types.ts, /Users/vadimr/grafema-worker-1/packages/cli/src/commands/doctor/checks.ts
  ...+3 more <obj>.option
  doctorCommand < assigned from <obj>.action  (packages/cli/src/commands/doctor.ts:34)
  action  (packages/cli/src/commands/doctor.ts:34) {
    < reads <obj>.addHelpText
  }
  ...+3 more property_access
  checkBinaries  (packages/cli/src/commands/doctor.ts:20) {
    o- imports from checkBinaries
  }
  ...+13 more import_bindings
  ./doctor/types.js  (packages/cli/src/commands/doctor.ts:32) {
    o- imports from /Users/vadimr/grafema-worker-1/packages/cli/src/commands/doctor/types.ts
  }
  ...+3 more imports
  [literal: '-j, --json', 'after', 'Show detailed diagnostics', '.', 'Project path', '-q, --quiet', 'doctor', '-p, --project <path>', 'Diagnose Grafema setup issues', 'Only show failures', '-v, --verbose', 'Output as JSON', <template>]
  <obj>.option  (packages/cli/src/commands/doctor.ts:34) {
    > receiver call <obj>.option
    > derived from option
    > passes 'Show detailed diagnostics', '-v, --verbose'
    > calls METHOD:option@<builtin>
  }
  <obj>.addHelpText  (packages/cli/src/commands/doctor.ts:34) {
    > receiver call <obj>.option
... (truncated, 39 more lines)
```
*Captured 2026-04-27.*

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- On unanalysed projects falls back to AST-only mode (no calls/effects). Run `grafema analyze` first for richer output.
- Default depth is 1 (top-level edges). Pass `--depth 2` to expand nested function bodies — useful for seeing what a method actually does.

### See also

- `cli:command:describe`
- `cli:command:file`
- `mcp:tool:get_file_overview`

## `cli:command` `trace`

**File**: `packages/cli/src/commands/trace.ts`
**Modality**: `cli:command`

### When to use

Bidirectional dataflow trace with knobs `wtf` doesn't expose:
`--to <sink>` (where does data flow into this sink?),
`--from-route <method+path>` (the response body of an HTTP route
back to its sources), depth control, file scoping. Use `wtf` for
the simple "where does this come from?" case; reach for `trace`
when you need precision.

### Contract — commander

Trace data flow for a variable or to a sink point

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `pattern` | `string` | yes |  | Pattern: "varName from functionName" or just "varName" |
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |
| `--depth` | `string` | yes | `10` | Max trace depth |
| `--detail` | `string` | yes | `normal` | Level of detail: summary, normal (default), full |
| `--to` | `string` | yes |  | Sink point: "fn#argIndex.property" (e.g., "addNode#0.type") |
| `--from-route` | `string` | yes |  | Trace from route response (e.g., "GET /status" or "/status") |

### Examples

**Trace by name**

```sh
grafema trace featureId
```

```
{captured: trace-by-name}
```

**Scope-pinned trace**

```sh
grafema trace "featureId from collectFeatureSnapshots"
```

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Cross-language traces depend on bridge detection (the analyzer knows about specific HTTP / queue / RPC libraries). Bridges that aren't in effects-db won't propagate.

### See also

- `cli:command:wtf`
- `mcp:tool:trace_dataflow`
- `mcp:tool:trace_calls`

## `cli:command` `types`

**File**: `packages/cli/src/commands/types.ts`
**Modality**: `cli:command`

### Contract — commander

List all node types in the graph

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |
| `--sort` | `string` | yes | `count` | Sort by: count (default) or name |

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

## `cli:command` `who`

**File**: `packages/cli/src/commands/who.ts`
**Modality**: `cli:command`

### When to use

"Is this safe to change?" Use `who` to enumerate every caller and
reference of a function, method, class, or constant. Returns
resolved call sites with file:line so you can audit breakage scope
before refactoring. Pairs naturally with `wtf` (data side) — `who`
is the call side.

### Contract — commander

Who uses this? — find all callers/references to a symbol

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `symbol` | `string` | no |  | Function or method name |
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |

### Examples

**Find callers of a function**

```sh
grafema who handleRequest
```

```
handleRequest — 1 caller

  packages/util/src/api/GraphAPI.ts:105 <anonymous>          [resolved]
```
*Captured 2026-04-27.*

**JSON output for scripts**

```sh
grafema who handleRequest --json
```

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

### Gotchas

- Calls through aliases (`const fn = obj.method`) are resolved via the trace_alias chain — they show up correctly, unlike a plain grep.
- Method names common to many classes (`get`, `parse`) return many matches; filter with `--type METHOD` and `--in <file>` to narrow.

### See also

- `cli:command:wtf`
- `cli:command:impact`
- `mcp:tool:find_calls`

## `cli:command` `why`

**File**: `packages/cli/src/commands/why.ts`
**Modality**: `cli:command`

### When to use

"Why is the code structured this way?" Use `why` to query the
knowledge base for decisions, facts, and historical reasoning
attached to a code area. Returns DECISION / FACT / SESSION nodes
linked via `applies_to` to the queried entity. The KB grows over
time as Claude / agents annotate the codebase via `add_knowledge`
and `extract-knowledge`.

### Contract — commander

Why is it this way? — query knowledge base decisions and facts

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `query` | `string` | no |  | Search text (symbol name, module, or topic) |
| `--project` | `string` | yes | `.` | Project path |
| `--json` | `boolean` | yes |  | Output as JSON |

### Examples

**Query knowledge base for a function**

```sh
grafema why authMiddleware
```

```
No knowledge found for: "authMiddleware"

No decisions or facts recorded matching this query.
Use `add_knowledge` MCP tool to capture architectural decisions.
```
*Captured 2026-04-27.*

**JSON output for tooling**

```sh
grafema why authMiddleware --json
```

### Behavior

- Effects: ASYNC
- Transitive calls: 1
- Depth: 10

### Gotchas

- Returns nothing on a fresh project — KB is empty until decisions are added (manually or via `/extract-knowledge` skill).
- Symbol resolution is fuzzy; pass `--exact` if you want strict match on a specific node.

### See also

- `mcp:tool:query_decisions`
- `mcp:tool:query_knowledge`
- `mcp:tool:add_knowledge`

## `cli:command` `wtf`

**File**: `packages/cli/src/commands/wtf.ts`
**Modality**: `cli:command`

### When to use

"Where the hell does this value come from?" Use `wtf` to trace
backward from a variable, expression, or property access to every
source that writes to it — across function boundaries, files, and
packages. The classic case: a bug log shows `req.user.id` is
undefined, and you need to find the upstream code that should have
set it.

### Contract — commander

Where does this come from? — backward dataflow trace

| Input | Type | Optional | Default | Description |
|-------|------|----------|---------|-------------|
| `symbol` | `string` | no |  | Variable, constant, or parameter name to trace |
| `--project` | `string` | yes | `.` | Project path |
| `--depth` | `string` | yes | `10` | Max trace depth |
| `--detail` | `string` | yes | `normal` | Level of detail: summary, normal (default), full |
| `--json` | `boolean` | yes |  | Output as JSON |

### Examples

**Backward trace from a variable**

```sh
grafema wtf featureId
```

```
featureId (CONSTANT) — packages/mcp/src/handlers/behavior-handlers.ts:109

"featureId" ← fan-in from 3 modules (19 nodes reached)

  packages/mcp/src/handlers/behavior-handlers.ts
    < ensureAnalyzed (IMPORT_BINDING)
    < db (PARAMETER)
    => bucket (CONSTANT)
    => beh (CONSTANT)
    => edges (CONSTANT)
    < db.getIncomingEdges (CALL)
    < id (PROPERTY_ACCESS)
    < getIncomingEdges (PROPERTY_ACCESS)
    => edge (CONSTANT)
    < String (CALL)
    < src (PROPERTY_ACCESS)
    < args (PARAMETER)
    => db (CONSTANT)
    < ensureAnalyzed (CALL)

  packages/mcp/src/analysis.ts
    < getOrCreateBackend (IMPORT_BINDING)
    => db (CONSTANT)
    < getOrCreateBackend (CALL)

... (truncated, 6 more lines)
```
*Captured 2026-04-27.*

**Custom depth**

```sh
grafema wtf featureId --depth 15
```

### Behavior

- Effects: ASYNC, UNKNOWN
- Transitive calls: 1
- Depth: 10

### Gotchas

- Symbol resolution falls back to fuzzy match if the literal name doesn't exist. Quote the symbol or pass `--no-fuzzy` for strict.
- Cross-package traces depend on `grafema analyze` having seen both sides. Re-run `grafema analyze` if a recently-added dependency isn't traced.
- `wtf` traces **variables, parameters, and property accesses** — not function or class names. `grafema wtf validateSession` returns "Symbol not found" even if the function is in the graph. For callers of a function, use `who`; for downstream impact analysis, use `impact`.

### See also

- `cli:command:trace`
- `cli:command:who`
- `mcp:tool:trace_dataflow`

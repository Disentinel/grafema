# Changelog

All notable changes to this project will be documented in this file.

## [0.2.5-beta] - 2026-02-09

### Highlights

- **Declarative plugin ordering** — Replace magic priority numbers with `dependencies: [...]` (topological sort)
- **Batch IPC** — 10-17x speedup in analysis phase by eliminating N+1 graph calls
- **MCP onboarding** — AI agents get step-by-step instructions via MCP Prompts protocol
- **Plugin introspection** — Query `grafema:plugin` nodes to discover plugin capabilities without reading source

### Plugin Architecture

- **REG-367**: Replace `priority` with declarative `dependencies` for plugin ordering. Topological sort with cycle detection
- **REG-386**: Expose plugin metadata as `grafema:plugin` graph nodes — phase, dependencies, created types all queryable
- **REG-388**: Batch IPC optimization across all analysis plugins — collect nodes/edges, flush once instead of N+1 calls

### Data Flow

- **REG-270**: YIELDS/DELEGATES_TO edges for generator functions (`yield`, `yield*`)
- **REG-288**: Track UpdateExpression modifications (`i++`, `--count`) as first-class graph nodes
- **REG-392**: FLOWS_INTO edges for non-variable values in array mutations (literals, calls, expressions)

### CLI & DX

- **REG-199**: `--log-file` option for `grafema analyze` — write structured logs to file
- **REG-350**: Live progress UI during analysis — current phase and plugin name
- **REG-347**: Loading spinner for slow graph queries, auto-start server fix
- **REG-385**: Fix CLI failure in nvm environments — use `process.execPath` instead of `'node'`
- **REG-353**: VS Code "Copy Tree State" command for debugging
- **REG-348**: VS Code setting for custom rfdb-server binary path

### Onboarding

- **REG-173**: Instruction-driven onboarding via MCP Prompts — AI agents receive step-by-step setup guide

### Quality & Testing

- **REG-195**: Code coverage with c8 and CI integration
- **REG-149**: ESLint type safety — promote warn to error, fix all `as any` / `as unknown` casts
- **REG-198**: Enforce branded nodes in GraphBackend.addNode — no more raw object literals
- **REG-154**: Fix 4 skipped test files, migrate ExpressResponseAnalyzer to NodeFactory
- **REG-390**: Fix 293 test failures after multi-branch merge
- **REG-393**: Directory index resolution regression test

### Enrichment & Analysis

- **REG-306**: Extract shared expression handling in JSASTAnalyzer
- **REG-323**: Byte offset for HANDLED_BY edge matching (precision fix)
- **REG-351**: Reduce strict mode false positives — expand isExternalMethod detection
- **REG-354**: Library coverage tracking — report which libraries are called and suggest analyzers
- **REG-311**: Track async error patterns (Promise.reject, reject callback)

### Infrastructure

- **REG-67**: Release workflow with CI/CD — stable branch, semantic versioning, GitHub Actions
- **REG-76**: Multi-root workspace support
- **REG-349**: Fix esbuild CJS bundling (RustAnalyzer lazy load)
- **REG-243**: Deduplicate diagnostic category mappings
- **REG-320**: Extract shared `resolveModulePath` utility
- **REG-378**: Ensure `grafema analyze` exits cleanly

### Bug Fixes

- **REG-322**: HANDLED_BY edge finds correct handler (byte offset matching)
- **REG-385**: CLI init fails when Node.js not in PATH (nvm)

---

## [0.2.4-beta] - 2026-02-05

### Infrastructure

- **Shared binary finder**: Unified `findRfdbBinary()` utility across CLI, MCP, VS Code extension
- **Linux support**: Added `~/grafema` and `/home/vadimr/grafema` dev paths for Linux
- **Explicit server lifecycle**: `grafema server start/stop/status` commands
- **Binary path config**: Support `server.binaryPath` in config.yaml and `--binary` flag
- **Release skill**: Added `/release` skill for npm publishing workflow

### Known Issues

- VS Code extension build broken (REG-349: RustAnalyzer top-level await + CJS)

---

## [0.2.3-beta] - 2026-02-04

### Bug Fixes

- Fixed `--version` showing hardcoded 0.1.0 instead of actual version
- Ported custom plugin loading from MCP to CLI (`.grafema/plugins/`)
- Added `~/.local/bin/rfdb-server` fallback for user-built binaries

---

## [0.2.0-beta] - 2026-02-04

### Highlights

- **Cross-service tracing** - Click on a frontend fetch call, trace to backend handler
- **VS Code Extension** - Interactive graph navigation (Cmd+Shift+G)
- **Promise dataflow** - Track data through resolve() callbacks
- **Column-precise locations** - All nodes have exact column positions

### Data Flow

- **REG-252**: Cross-service value tracing (frontend <-> backend)
- **REG-334**: Promise dataflow tracking through resolve() calls
- **REG-333**: Support wrapper functions (asyncHandler, catchAsync)
- **REG-263**: Track return statements (RETURNS edge)
- **REG-229**: Argument-to-parameter binding
- **REG-225**: Cross-file imported function call resolution
- **REG-232**: Re-export chain resolution

### Control Flow

- **REG-267**: Control flow layer (BRANCH, LOOP, TRY_BLOCK nodes)
- **REG-272**: Loop variable declarations (for...of/for...in)
- **REG-268**: Dynamic imports with isDynamic flag
- **REG-274**: IfStatement tracking
- **REG-275**: SwitchStatement tracking

### Graph Improvements

- **REG-337/339**: Column location for all physical nodes
- **REG-313**: Nested paths in attr() predicate
- **REG-315**: attr_edge() predicate for edge metadata
- **REG-250**: Fixed attr() to return attribute values
- **REG-251**: Fixed edge() predicate

### Enrichment

- **REG-248**: Router mount prefix resolution
- **REG-226**: External package call resolution
- **REG-309**: Scope-aware variable lookup
- **REG-269**: Transitive closure captures
- **REG-262**: Method call usage edges

### Query UX

- **REG-307**: Natural language query support
- **REG-253**: Query by arbitrary node type
- **REG-249**: http:request nodes searchable

### Validation

- **REG-261**: Broken import detection
- **REG-227**: Updated CallResolverValidator

### Bug Fixes

- **REG-322**: HANDLED_BY edge finds correct handler
- **REG-321**: MAKES_REQUEST links to CALL node
- **REG-318**: MountPointResolver module matching
- **REG-308**: Server-side file filtering
- **REG-247**: WorkspaceDiscovery entrypoint passing

---

## [0.1.1-alpha] - 2025-01-25

### Features

- **REG-174**: Add `services` config field for explicit service definitions in monorepos
  - Bypass auto-discovery by specifying services manually in config.yaml
  - Support custom entrypoints per service
- **REG-152**: Add FLOWS_INTO edges for `this.prop = value` patterns
- **REG-153**: Use semantic IDs for PARAMETER nodes (breaking change for existing graphs)
- **REG-169**: Add `grafema coverage` command to CLI and MCP
- **REG-176**: Add `--entrypoint` option to analyze command
- **REG-189**: Add `grafema server start/stop/status` commands
- **REG-171**: Add WorkspaceDiscovery plugin for npm/pnpm/yarn/lerna workspaces
- **REG-170**: Unify config format from JSON to YAML
- **REG-111**: Add branded type system for NodeFactory (type safety improvement)

### Bug Fixes

- **REG-174**: Fix JSModuleIndexer to use `metadata.entrypoint` instead of `service.path`
  - This was causing 0 modules to be indexed for config-provided services
- **REG-181**: Preserve RFDB server between CLI and MCP sessions
  - No more "server not running" errors when switching between tools
- **REG-192**: Properly type RFDB query results
- **REG-194**: Remove type-unsafe `as any` casts for discovery config
- **REG-175**: Add discovery plugin support to CLI analyze command
- **REG-187**: Use semantic ID parsing for trace scope filtering
- **REG-180**: Correct trace_alias parameter name
- **REG-122**: Replace non-null loc assertions with defensive checks

### Improvements

- **REG-191**: Remove dead ServiceDetector code
- **REG-159**: Add concurrent safety to MCP analyze_project handler
- **REG-158**: Add E2E test for init → analyze → query workflow
- **REG-157**: Standardize error messages across CLI commands
- **REG-150/REG-151**: Implement reportIssue() for VALIDATION plugins
- **REG-140**: Remove deprecated stableId field from node types
- **REG-148**: Migrate all plugins from console.log to structured Logger
- **REG-139**: Centralize ID generation with IdGenerator service
- **REG-141**: Remove legacy scopeCtx parameter from analyzeFunctionBody
- **REG-144**: Add variable lookup cache in bufferArrayMutationEdges (performance)

### New Capabilities

- **REG-95**: Add ISSUE node type for plugin-detected problems
- **REG-117**: Track nested array mutations (`obj.arr.push`)
- **REG-134**: Create PARAMETER nodes for class constructor/method parameters
- **REG-135**: Resolve computed property names in `obj[key]` patterns
- **REG-145**: Pass Logger through PluginContext for controllable verbosity
- **REG-147**: Add error reporting for parse failures in JSModuleIndexer
- **REG-146**: Update GitPlugin to use GrafemaError

---

## [0.1.0-alpha.5] - 2025-01-20

Initial alpha release with core functionality.

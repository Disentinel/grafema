# Grafema Project Onboarding

## Goal
Study the target project and create a `.grafema/config.yaml` that correctly
describes its services, entry points, and analysis configuration.

## Prerequisites
- The project directory exists and contains source code
- `.grafema/` directory exists (run `grafema init` if not)

## Step 1: Initial Reconnaissance

Use `read_project_structure` to get the directory tree.

Look for:
- `package.json` in root and subdirectories (indicates JS/TS packages)
- `pnpm-workspace.yaml`, `lerna.json`, root `package.json` with `workspaces`
  field (workspace/monorepo indicators)
- `tsconfig.json` files (TypeScript project)
- `Dockerfile`, `docker-compose.yml`, `k8s/`, `apps.json` (deployment configs
  that may reveal service boundaries)
- Directories named `apps/`, `packages/`, `services/`, `pkg/`, `modules/`
  (common monorepo structures)

## Step 2: Identify Services

A "service" in Grafema is an independently analyzable unit of code with its
own entry point. Typically:
- A standalone application (API server, web app, CLI tool)
- A package in a monorepo that other packages depend on
- A microservice in a deployment configuration

For each potential service, determine:
1. **Name** — human-readable identifier (e.g., "backend", "dashboard")
2. **Path** — directory path relative to project root
3. **Entry point** — the main source file (prefer TypeScript source over
   compiled output)

### How to find entry points
Check in order:
1. `package.json` "source" field (TypeScript source entry)
2. `package.json` "main" field, but look for `.ts` equivalent in `src/`
3. Common patterns: `src/index.ts`, `src/main.ts`, `src/app.ts`,
   `src/server.ts`, `index.ts`
4. For React apps: `src/App.tsx`, `src/index.tsx`
5. Check `bin` field in package.json for CLI tools

### When to ask the user
- "I found [X] that looks like [description]. Should I include it as a
  service?"
- "This directory has multiple potential entry points: [list].
  Which should I use?"
- "I found deployment configuration mentioning services not visible in
  the code structure. Should I investigate?"

## Step 3: Run Auto-Discovery (Optional)

Use `discover_services` to see what Grafema's built-in detection finds.
Compare with your own findings from Steps 1-2. Note discrepancies —
auto-discovery may miss services or misidentify entry points.

## Step 4: Configure Plugins

Default plugins work for most JS/TS projects. Adjust if:
- Project uses specific frameworks (Express, React, Socket.IO) — ensure
  corresponding analyzers are enabled
- Project has Rust components — add `RustModuleIndexer` and `RustAnalyzer`
- Project has unusual file patterns — configure `include`/`exclude`

Default plugin list (reference only — omit from config to use defaults):
  indexing: [JSModuleIndexer]
  analysis: [JSASTAnalyzer, ExpressRouteAnalyzer, ExpressResponseAnalyzer,
    SocketIOAnalyzer, DatabaseAnalyzer, FetchAnalyzer, ServiceLayerAnalyzer]
  enrichment: [MethodCallResolver, ArgumentParameterLinker, AliasTracker,
    ClosureCaptureEnricher, RejectionPropagationEnricher, ValueDomainAnalyzer,
    MountPointResolver, ExpressHandlerLinker, PrefixEvaluator,
    ImportExportLinker, HTTPConnectionEnricher]
  validation: [GraphConnectivityValidator, DataFlowValidator, EvalBanValidator,
    CallResolverValidator, SQLInjectionValidator, ShadowingDetector,
    TypeScriptDeadCodeValidator, BrokenImportValidator]

## Step 5: Write Configuration

Use `write_config` to save the discovered configuration.

The config should include:
- `services` array with all confirmed services (name, path, optional entryPoint)
- `plugins` section (only if overriding defaults)
- `include`/`exclude` patterns (only if needed)
- `workspace.roots` (for multi-root workspaces only)

## Step 6: Verify

Run `analyze_project` to build the graph. Then check:
- `get_stats` — are node/edge counts reasonable for the project size?
- `get_coverage` — are the expected files analyzed?

If coverage is low or results are unexpected, iterate:
revisit services, entry points, or include/exclude patterns.

## Common Patterns

### Monorepo with workspaces
Look for `pnpm-workspace.yaml` or `workspaces` in root `package.json`.
Each workspace package is typically a service. Use `read_project_structure`
with depth=2 to see the package layout.

### Legacy project with multiple entry points
Look for `scripts` in `package.json`, `bin` field, or multiple files
in `src/` that look like entry points (contain `app.listen()`,
`createServer()`, `express()`).

### Microservices with shared deployment
Look for `docker-compose.yml`, Kubernetes configs, or similar
deployment manifests that list services. Cross-reference with
code directories.

### Single-package project
If there is only one `package.json` at the root and no monorepo
structure, the project is likely a single service. The service path
is `.` (root), and the entry point is determined from `package.json`.

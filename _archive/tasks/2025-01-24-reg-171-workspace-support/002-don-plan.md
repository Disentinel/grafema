# Don Melton: ServiceDetector Workspace Support Analysis

## Current Architecture

### Service Detection Flow

The service detection in Grafema follows a **5-phase pipeline** orchestrated by `Orchestrator`:

1. **DISCOVERY** - Find services/projects
2. **INDEXING** - Build module dependency trees
3. **ANALYSIS** - Parse AST and extract entities
4. **ENRICHMENT** - Resolve references
5. **VALIDATION** - Check invariants

Service detection happens in **DISCOVERY phase** via multiple plugins:

#### Plugin Hierarchy

```
Discovery Plugins (by priority):
├── MonorepoServiceDiscovery (priority: 100) - pkg/ pattern
├── SimpleProjectDiscovery   (priority: 50)  - root package.json fallback
└── ServiceDetector          (priority: 90)  - INDEXING phase, apps/packages/services patterns
```

**Critical observation:** There are TWO service detection mechanisms:

1. **ServiceDetector** (INDEXING phase, priority 90) - scans hardcoded directories:
   - `apps/`
   - `packages/`
   - `services/`

2. **Discovery plugins** (DISCOVERY phase) - pluggable architecture:
   - `MonorepoServiceDiscovery` - only looks in `pkg/`
   - `SimpleProjectDiscovery` - creates single service from root package.json

### ServiceDetector Implementation Analysis

Location: `/Users/vadimr/grafema/packages/core/src/plugins/indexing/ServiceDetector.ts`

```typescript
// Current detection strategy (lines 72-91):
const monorepoPatterns = ['apps', 'packages', 'services'];
for (const pattern of monorepoPatterns) {
  const monorepoDir = join(projectPath, pattern);
  if (existsSync(monorepoDir)) {
    const detected = this.detectServicesInDir(monorepoDir, projectPath, logger);
    services.push(...detected);
  }
}
// Fallback: if no services found, treat root as single service
if (services.length === 0) {
  const rootService = this.detectRootService(projectPath, logger);
}
```

**Key insight:** ServiceDetector is naive - it ONLY checks static directory patterns, not workspace configurations.

### The Gap: Workspaces Are Declarative, Not Structural

npm/pnpm/yarn workspaces use **glob patterns** in configuration files:

```json
// package.json (npm/yarn)
{ "workspaces": ["apps/frontend", "apps/backend", "packages/*"] }
```

```yaml
# pnpm-workspace.yaml
packages:
  - 'packages/*'
  - 'apps/**'
```

```json
// lerna.json
{ "packages": ["packages/*", "components/*"] }
```

Current ServiceDetector **ignores these configurations entirely**.

## Identified Gaps

### Gap 1: No Workspace Configuration Parsing
ServiceDetector doesn't read `package.json.workspaces`, `pnpm-workspace.yaml`, or `lerna.json`.

### Gap 2: Static Directory Patterns vs Dynamic Globs
Workspaces use glob patterns (`packages/*`, `apps/**`), but ServiceDetector uses static paths (`apps/`, `packages/`).

### Gap 3: Phase Mismatch
ServiceDetector runs in INDEXING phase but should be part of DISCOVERY (service detection is discovery, not indexing).

### Gap 4: No Nested Workspace Support
Workspaces can be nested (`apps/**/package.json`), but current implementation only scans immediate children.

### Gap 5: No Workspace Root vs Member Distinction
Root package.json in workspace is often just configuration, not a service. Current logic would incorrectly treat it as a service if no subdirectories match patterns.

## High-Level Plan

### Strategy: Create WorkspaceDiscovery Plugin

**WHY:** Instead of patching ServiceDetector, we should create a proper DISCOVERY-phase plugin that understands workspace semantics. This aligns with the plugin architecture and keeps concerns separate.

### Phase 1: Workspace Configuration Detection

1. **Create workspace config detector** - detect which workspace system is used:
   - `pnpm-workspace.yaml` present -> pnpm
   - `package.json.workspaces` present -> npm/yarn
   - `lerna.json` present -> lerna
   - None -> not a workspace

2. **Parse configuration files**:
   - pnpm: YAML parsing of `pnpm-workspace.yaml`
   - npm/yarn: JSON parsing of `package.json.workspaces`
   - lerna: JSON parsing of `lerna.json.packages`

### Phase 2: Glob Resolution

3. **Resolve workspace globs** to actual directories:
   - Use `glob` or `fast-glob` library (already common in Node ecosystem)
   - Handle negation patterns (`!packages/internal`)
   - Handle recursive patterns (`apps/**`)

4. **Filter valid packages** - only directories with `package.json`

### Phase 3: Service Creation

5. **Create SERVICE nodes** for each workspace member:
   - ID: based on relative path
   - Name: from workspace package.json name field
   - Metadata: workspace type (npm/pnpm/yarn/lerna), root workspace flag

6. **Do NOT create service for workspace root** (unless it has src/ or is explicitly a standalone app)

### Phase 4: Integration

7. **Export as WorkspaceDiscovery plugin** with high priority (100+) so it runs before fallback plugins

8. **Make ServiceDetector aware** - if WorkspaceDiscovery found services, skip ServiceDetector's naive patterns

### Implementation Files

```
packages/core/src/plugins/discovery/
├── WorkspaceDiscovery.ts       # Main plugin
├── workspaces/
│   ├── index.ts                # Re-exports
│   ├── detector.ts             # Detect workspace type
│   ├── npmWorkspace.ts         # npm/yarn workspace parsing
│   ├── pnpmWorkspace.ts        # pnpm workspace parsing
│   └── lernaWorkspace.ts       # lerna workspace parsing
```

### Test Plan

```
test/unit/plugins/discovery/
├── WorkspaceDiscovery.test.ts
├── workspaces/
│   ├── detector.test.ts
│   ├── npmWorkspace.test.ts
│   ├── pnpmWorkspace.test.ts
│   └── lernaWorkspace.test.ts

test/fixtures/workspaces/
├── npm-basic/                  # Simple npm workspace
├── pnpm-monorepo/             # pnpm workspace (like Grafema itself!)
├── yarn-nested/               # Yarn with nested workspaces
├── lerna-legacy/              # Lerna monorepo
└── mixed-setup/               # Multiple config files
```

## Alignment with Vision

### Grafema's Core Thesis: "AI should query the graph, not read code"

Workspace support **directly enables this vision** for monorepos:

1. **Without workspace support**: AI gets single "jammers-monorepo" service, misses 3 actual apps
2. **With workspace support**: AI queries `SERVICE` nodes, gets proper project structure

### Target Environment: Legacy Codebases

Many legacy JS codebases are monorepos that predate TypeScript adoption. They use:
- npm workspaces (simpler setup)
- Lerna (older monorepos)
- pnpm (performance-focused teams)

### AI-First Design

Workspace detection should be **automatic** - no configuration needed. AI agent runs `grafema analyze /path/to/repo` and gets correct service decomposition.

## Open Questions

### Q1: ServiceDetector Deprecation?
Should we deprecate `ServiceDetector` entirely in favor of `WorkspaceDiscovery` + `SimpleProjectDiscovery`?

**Recommendation:** Yes, eventually. ServiceDetector's static patterns are a subset of what WorkspaceDiscovery handles. Keep it for now with lower priority as fallback.

### Q2: Nested Workspaces
Some projects have workspaces within workspaces. How deep should we recurse?

**Recommendation:** Support one level of nesting. If a workspace member is itself a workspace, create a WORKSPACE_ROOT node type, not SERVICE.

### Q3: Private Packages
Workspace members marked `"private": true` - should they be services?

**Recommendation:** Yes. Private just means "don't publish to npm", doesn't mean "not a service". Tools, scripts, internal packages are all valid analysis targets.

### Q4: Workspace Root as Service?
Should the root package.json ever create a SERVICE node?

**Recommendation:** Only if it has actual source code (src/ or lib/ with code). Most workspace roots are just configuration holders.

### Q5: Dependency on External Libraries
Should we use `fast-glob` or implement our own glob resolution?

**Recommendation:** Use `fast-glob` - it's battle-tested, handles edge cases, and is already a common dependency in the JS ecosystem. Avoid NIH syndrome.

---

**Next Step:** Joel to expand this into detailed technical spec with specific interfaces, error handling, and test cases.

# Joel Spolsky: Technical Specification for Workspace Support

## Overview

Implement `WorkspaceDiscovery` plugin to detect and analyze npm/pnpm/yarn/lerna workspaces. This enables Grafema to correctly identify services in monorepo projects that use workspace configurations instead of relying on static directory patterns.

**Business Value:** Critical blocker for onboarding. Most modern JS/TS projects are monorepos using workspace configurations. Without this, Grafema sees "1 service" instead of the actual N services.

## Architecture Decision

### Why New Plugin, Not Patch ServiceDetector?

1. **Phase Mismatch:** ServiceDetector runs in INDEXING phase, but service detection is DISCOVERY responsibility
2. **Separation of Concerns:** Workspace semantics are different from static directory scanning
3. **Priority Control:** WorkspaceDiscovery should run before fallback plugins (higher priority)
4. **Backward Compatibility:** ServiceDetector continues working for non-workspace monorepos

### Plugin Priority Hierarchy (After Implementation)

```
DISCOVERY Phase:
1. WorkspaceDiscovery      (priority: 110) - workspace configurations
2. MonorepoServiceDiscovery (priority: 100) - pkg/ pattern
3. ServiceDetector         (priority: 90)  - apps/packages/services patterns (INDEXING)
4. SimpleProjectDiscovery  (priority: 50)  - root package.json fallback
```

## Implementation Steps

### Step 1: Create Workspace Type Detector

**Purpose:** Detect which workspace system is used in a project.

**Files:**
- Create: `packages/core/src/plugins/discovery/workspaces/detector.ts`

**Interface:**
```typescript
export type WorkspaceType = 'pnpm' | 'npm' | 'yarn' | 'lerna' | null;

export interface WorkspaceDetectionResult {
  type: WorkspaceType;
  configPath: string | null;  // Path to the config file
  rootPath: string;           // Project root
}

/**
 * Detect workspace type by checking for configuration files.
 * Priority: pnpm > npm/yarn > lerna (most specific first)
 */
export function detectWorkspaceType(projectPath: string): WorkspaceDetectionResult;
```

**Detection Logic:**
```typescript
// 1. pnpm-workspace.yaml -> pnpm
// 2. package.json.workspaces -> npm/yarn (both use same format)
// 3. lerna.json -> lerna
// 4. None -> null (not a workspace)
```

**Tests:**
- `test/unit/plugins/discovery/workspaces/detector.test.ts`
- Fixture: empty dir -> null
- Fixture: pnpm-workspace.yaml present -> 'pnpm'
- Fixture: package.json with workspaces -> 'npm'
- Fixture: lerna.json -> 'lerna'
- Fixture: multiple configs (pnpm + lerna) -> 'pnpm' (highest priority)

---

### Step 2: Create Workspace Config Parsers

**Purpose:** Parse workspace configuration files and extract glob patterns.

**Files:**
- Create: `packages/core/src/plugins/discovery/workspaces/parsers/pnpmParser.ts`
- Create: `packages/core/src/plugins/discovery/workspaces/parsers/npmParser.ts`
- Create: `packages/core/src/plugins/discovery/workspaces/parsers/lernaParser.ts`
- Create: `packages/core/src/plugins/discovery/workspaces/parsers/index.ts`

**Common Interface:**
```typescript
export interface WorkspaceConfig {
  patterns: string[];          // Glob patterns (e.g., ['packages/*', 'apps/**'])
  negativePatterns: string[];  // Exclusion patterns (e.g., ['!packages/internal'])
}

export interface WorkspaceParser {
  parse(configPath: string): WorkspaceConfig;
}
```

**pnpmParser.ts:**
```typescript
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';  // Already in dependencies

export function parsePnpmWorkspace(configPath: string): WorkspaceConfig {
  const content = readFileSync(configPath, 'utf-8');
  const config = parseYaml(content);

  // pnpm-workspace.yaml format:
  // packages:
  //   - 'packages/*'
  //   - 'apps/**'
  //   - '!packages/internal'

  const patterns: string[] = [];
  const negativePatterns: string[] = [];

  for (const pattern of config.packages || []) {
    if (pattern.startsWith('!')) {
      negativePatterns.push(pattern.slice(1));
    } else {
      patterns.push(pattern);
    }
  }

  return { patterns, negativePatterns };
}
```

**npmParser.ts:**
```typescript
import { readFileSync } from 'fs';

export function parseNpmWorkspace(packageJsonPath: string): WorkspaceConfig {
  const content = readFileSync(packageJsonPath, 'utf-8');
  const pkg = JSON.parse(content);

  // package.json format:
  // { "workspaces": ["packages/*", "apps/**"] }
  // OR (yarn)
  // { "workspaces": { "packages": ["packages/*"], "nohoist": ["**/react-native"] } }

  let workspaces: string[] = [];

  if (Array.isArray(pkg.workspaces)) {
    workspaces = pkg.workspaces;
  } else if (pkg.workspaces?.packages) {
    workspaces = pkg.workspaces.packages;
  }

  const patterns: string[] = [];
  const negativePatterns: string[] = [];

  for (const pattern of workspaces) {
    if (pattern.startsWith('!')) {
      negativePatterns.push(pattern.slice(1));
    } else {
      patterns.push(pattern);
    }
  }

  return { patterns, negativePatterns };
}
```

**lernaParser.ts:**
```typescript
import { readFileSync } from 'fs';

export function parseLernaConfig(lernaJsonPath: string): WorkspaceConfig {
  const content = readFileSync(lernaJsonPath, 'utf-8');
  const config = JSON.parse(content);

  // lerna.json format:
  // { "packages": ["packages/*", "components/*"] }

  const patterns = config.packages || ['packages/*'];  // Default lerna pattern
  const negativePatterns: string[] = [];

  return { patterns, negativePatterns };
}
```

**Tests:**
- `test/unit/plugins/discovery/workspaces/parsers/pnpmParser.test.ts`
- `test/unit/plugins/discovery/workspaces/parsers/npmParser.test.ts`
- `test/unit/plugins/discovery/workspaces/parsers/lernaParser.test.ts`

---

### Step 3: Create Glob Resolver

**Purpose:** Resolve glob patterns to actual directories containing package.json.

**Files:**
- Create: `packages/core/src/plugins/discovery/workspaces/globResolver.ts`

**Interface:**
```typescript
export interface WorkspacePackage {
  path: string;          // Absolute path to package directory
  name: string;          // Package name from package.json
  relativePath: string;  // Relative path from project root
  packageJson: PackageJson;
}

/**
 * Resolve workspace glob patterns to actual packages.
 * Only directories with package.json are considered valid packages.
 */
export function resolveWorkspacePackages(
  projectPath: string,
  config: WorkspaceConfig
): WorkspacePackage[];
```

**Implementation Notes:**
- Use `minimatch` (already a dependency) for glob matching
- Use `fs.readdirSync` with recursive directory traversal for `**` patterns
- Filter: only include directories that contain `package.json`
- Apply negative patterns as exclusions

**Algorithm:**
```typescript
import { minimatch } from 'minimatch';
import { readdirSync, statSync, existsSync, readFileSync } from 'fs';
import { join, relative } from 'path';

export function resolveWorkspacePackages(
  projectPath: string,
  config: WorkspaceConfig
): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  const seen = new Set<string>();  // Dedupe

  // 1. Expand all positive patterns
  for (const pattern of config.patterns) {
    const matches = expandGlob(projectPath, pattern);
    for (const dir of matches) {
      // Check for package.json
      const pkgJsonPath = join(dir, 'package.json');
      if (!existsSync(pkgJsonPath)) continue;

      // Check negative patterns
      const relPath = relative(projectPath, dir);
      if (config.negativePatterns.some(neg => minimatch(relPath, neg))) continue;

      // Avoid duplicates
      if (seen.has(dir)) continue;
      seen.add(dir);

      // Parse package.json
      const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));

      packages.push({
        path: dir,
        name: pkgJson.name || relPath.replace(/\//g, '-'),
        relativePath: relPath,
        packageJson: pkgJson
      });
    }
  }

  return packages;
}

function expandGlob(basePath: string, pattern: string): string[] {
  // Handle simple cases without recursion first
  if (!pattern.includes('*')) {
    // Literal path
    const fullPath = join(basePath, pattern);
    return existsSync(fullPath) && statSync(fullPath).isDirectory() ? [fullPath] : [];
  }

  if (pattern.includes('**')) {
    // Recursive glob - need to walk directory tree
    return expandRecursiveGlob(basePath, pattern);
  }

  // Simple glob like packages/*
  return expandSimpleGlob(basePath, pattern);
}

function expandSimpleGlob(basePath: string, pattern: string): string[] {
  // Pattern like "packages/*" -> list packages/, filter by minimatch
  const parts = pattern.split('/');
  const literalPrefix = parts.slice(0, -1).join('/');
  const globPart = parts[parts.length - 1];

  const searchDir = join(basePath, literalPrefix);
  if (!existsSync(searchDir)) return [];

  const entries = readdirSync(searchDir);
  return entries
    .filter(entry => minimatch(entry, globPart))
    .map(entry => join(searchDir, entry))
    .filter(path => statSync(path).isDirectory());
}

function expandRecursiveGlob(basePath: string, pattern: string): string[] {
  // Pattern like "apps/**" or "apps/**/packages/*"
  const results: string[] = [];

  function walk(dir: string, depth: number = 0) {
    if (depth > 10) return;  // Safety limit

    const relPath = relative(basePath, dir);
    if (relPath && minimatch(relPath, pattern)) {
      results.push(dir);
    }

    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const fullPath = join(dir, entry);
        if (statSync(fullPath).isDirectory()) {
          walk(fullPath, depth + 1);
        }
      }
    } catch {
      // Ignore permission errors
    }
  }

  walk(basePath);
  return results;
}
```

**Tests:**
- `test/unit/plugins/discovery/workspaces/globResolver.test.ts`
- Pattern `packages/*` with 3 packages -> returns 3 WorkspacePackage
- Pattern `apps/**` with nested structure -> returns all nested packages
- Negative pattern `!packages/internal` -> excludes that package
- Directories without package.json -> excluded
- Handles symlinks safely

---

### Step 4: Create WorkspaceDiscovery Plugin

**Purpose:** Main discovery plugin that orchestrates detection, parsing, and service creation.

**Files:**
- Create: `packages/core/src/plugins/discovery/WorkspaceDiscovery.ts`

**Implementation:**
```typescript
import { DiscoveryPlugin } from './DiscoveryPlugin.js';
import { createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import { detectWorkspaceType } from './workspaces/detector.js';
import { parsePnpmWorkspace, parseNpmWorkspace, parseLernaConfig } from './workspaces/parsers/index.js';
import { resolveWorkspacePackages, type WorkspacePackage } from './workspaces/globResolver.js';
import { NodeFactory } from '../../core/NodeFactory.js';
import { resolveSourceEntrypoint } from './resolveSourceEntrypoint.js';
import { join, existsSync } from 'path';

interface ServiceInfo {
  id: string;
  name: string;
  path: string;
  type: string;
  metadata: {
    workspaceType: string;
    relativePath: string;
    entrypoint: string | null;
    packageJson: Record<string, unknown>;
  };
}

export class WorkspaceDiscovery extends DiscoveryPlugin {
  get metadata(): PluginMetadata {
    return {
      name: 'WorkspaceDiscovery',
      phase: 'DISCOVERY',
      priority: 110,  // Higher than MonorepoServiceDiscovery (100)
      creates: {
        nodes: ['SERVICE'],
        edges: []
      },
      dependencies: []
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    const logger = this.log(context);
    const { projectPath, graph } = context;

    if (!projectPath) {
      return createErrorResult(new Error('projectPath is required'));
    }

    logger.debug('Detecting workspace type', { projectPath });

    // Step 1: Detect workspace type
    const detection = detectWorkspaceType(projectPath);

    if (!detection.type) {
      logger.debug('Not a workspace project, skipping');
      return createSuccessResult({ nodes: 0, edges: 0 }, {
        services: [],
        skipped: true,
        reason: 'No workspace configuration found'
      });
    }

    logger.info('Workspace detected', {
      type: detection.type,
      configPath: detection.configPath
    });

    // Step 2: Parse workspace configuration
    let config;
    try {
      switch (detection.type) {
        case 'pnpm':
          config = parsePnpmWorkspace(detection.configPath!);
          break;
        case 'npm':
        case 'yarn':
          config = parseNpmWorkspace(detection.configPath!);
          break;
        case 'lerna':
          config = parseLernaConfig(detection.configPath!);
          break;
        default:
          throw new Error(`Unknown workspace type: ${detection.type}`);
      }
    } catch (error) {
      return createErrorResult(error as Error);
    }

    logger.debug('Workspace config parsed', {
      patterns: config.patterns,
      negativePatterns: config.negativePatterns
    });

    // Step 3: Resolve patterns to packages
    const packages = resolveWorkspacePackages(projectPath, config);

    logger.info('Workspace packages resolved', { count: packages.length });

    // Step 4: Create SERVICE nodes
    const services: ServiceInfo[] = [];

    for (const pkg of packages) {
      // Resolve entrypoint (prefer TypeScript source)
      const entrypoint = resolveSourceEntrypoint(pkg.path, pkg.packageJson)
        ?? pkg.packageJson.main as string
        ?? null;

      const serviceNode = NodeFactory.createService(pkg.name, pkg.path, {
        discoveryMethod: 'workspace',
        workspaceType: detection.type,
        relativePath: pkg.relativePath,
        entrypoint,
        version: pkg.packageJson.version as string,
        description: pkg.packageJson.description as string,
        private: pkg.packageJson.private as boolean,
        dependencies: Object.keys(pkg.packageJson.dependencies || {}),
      });

      await graph.addNode(serviceNode);

      services.push({
        id: serviceNode.id,
        name: pkg.name,
        path: pkg.path,
        type: 'workspace-package',
        metadata: {
          workspaceType: detection.type,
          relativePath: pkg.relativePath,
          entrypoint,
          packageJson: pkg.packageJson
        }
      });
    }

    logger.info('Services created from workspace', {
      count: services.length,
      workspaceType: detection.type
    });

    return createSuccessResult(
      { nodes: services.length, edges: 0 },
      { services, workspaceType: detection.type }
    );
  }
}
```

**Tests:**
- `test/unit/plugins/discovery/WorkspaceDiscovery.test.ts`
- Integration with mock graph backend
- pnpm workspace detection
- npm workspace detection
- lerna workspace detection
- Non-workspace project returns empty services with skipped=true

---

### Step 5: Create Index and Export

**Files:**
- Create: `packages/core/src/plugins/discovery/workspaces/index.ts`
- Modify: `packages/core/src/index.ts`

**workspaces/index.ts:**
```typescript
export { detectWorkspaceType, type WorkspaceType, type WorkspaceDetectionResult } from './detector.js';
export { parsePnpmWorkspace, parseNpmWorkspace, parseLernaConfig, type WorkspaceConfig } from './parsers/index.js';
export { resolveWorkspacePackages, type WorkspacePackage } from './globResolver.js';
```

**index.ts additions:**
```typescript
// Discovery plugins (add after existing exports)
export { WorkspaceDiscovery } from './plugins/discovery/WorkspaceDiscovery.js';
export {
  detectWorkspaceType,
  type WorkspaceType,
  type WorkspaceDetectionResult,
  type WorkspaceConfig,
  type WorkspacePackage
} from './plugins/discovery/workspaces/index.js';
```

---

### Step 6: Update Orchestrator Default Plugins

**Files:**
- Modify: `packages/core/src/Orchestrator.ts`

**Change:**
```typescript
// In constructor, add WorkspaceDiscovery to default plugins:
import { WorkspaceDiscovery } from './plugins/discovery/WorkspaceDiscovery.js';

// In constructor():
const hasDiscovery = this.plugins.some(p => p.metadata?.phase === 'DISCOVERY');
if (!hasDiscovery) {
  // Add both workspace and simple discovery
  // Priority order: WorkspaceDiscovery (110) > SimpleProjectDiscovery (50)
  this.plugins.unshift(new WorkspaceDiscovery());
  this.plugins.push(new SimpleProjectDiscovery());
}
```

**Alternative (non-breaking):** Keep existing behavior, let users opt-in:
```typescript
// Optional: Add flag to OrchestratorOptions
export interface OrchestratorOptions {
  // ... existing
  enableWorkspaceDiscovery?: boolean;  // Default: true
}

// In constructor:
if (options.enableWorkspaceDiscovery !== false) {
  this.plugins.unshift(new WorkspaceDiscovery());
}
```

---

### Step 7: Create Test Fixtures

**Files:**
- Create: `test/fixtures/workspaces/npm-basic/`
- Create: `test/fixtures/workspaces/pnpm-monorepo/`
- Create: `test/fixtures/workspaces/yarn-nested/`
- Create: `test/fixtures/workspaces/lerna-legacy/`
- Create: `test/fixtures/workspaces/non-workspace/`

**npm-basic structure:**
```
npm-basic/
  package.json            # { "workspaces": ["apps/*", "packages/*"] }
  apps/
    frontend/
      package.json        # { "name": "frontend" }
      src/index.ts
    backend/
      package.json        # { "name": "backend" }
      src/index.ts
  packages/
    shared/
      package.json        # { "name": "shared" }
      src/index.ts
```

**pnpm-monorepo structure:**
```
pnpm-monorepo/
  pnpm-workspace.yaml     # packages: ['packages/*']
  packages/
    core/
      package.json
      src/index.ts
    cli/
      package.json
      src/index.ts
```

---

### Step 8: Integration Test

**Files:**
- Create: `test/integration/workspace-discovery.test.ts`

**Test Cases:**
1. Analyze npm workspace -> finds all 3 services
2. Analyze pnpm workspace -> finds all packages
3. Analyze non-workspace -> fallback to SimpleProjectDiscovery
4. Analyze workspace with private packages -> includes them
5. E2E: `grafema analyze /path/to/npm-workspace` outputs correct services

---

## Test Matrix

| Scenario | Input | Expected Output |
|----------|-------|-----------------|
| npm basic | package.json with workspaces | 3 services |
| npm array format | `"workspaces": ["a/*"]` | All packages in a/ |
| yarn object format | `"workspaces": { "packages": ["a/*"] }` | All packages in a/ |
| pnpm basic | pnpm-workspace.yaml | All matched packages |
| pnpm negation | `!packages/internal` | Excludes internal |
| lerna basic | lerna.json | All matched packages |
| lerna defaults | No packages field | packages/* |
| nested workspace | `apps/**` | All nested packages |
| no workspace | No config files | Empty (skip to next plugin) |
| empty patterns | `[]` | 0 services |
| missing package.json | Pattern matches dir without package.json | Exclude that dir |
| private packages | `"private": true` | Include (private is publishability, not analysis) |

## Edge Cases

### 1. Workspace Root Has Source Code
**Scenario:** Root package.json is also a workspace member (rare but valid)
**Handling:** WorkspaceDiscovery only creates services for workspace MEMBERS. Root is not a member unless explicitly listed in patterns.

### 2. Circular/Self-Reference
**Scenario:** `workspaces: [".", "packages/*"]`
**Handling:** `"."` resolves to project root. Filter it out - root should not be treated as a service.

### 3. Symlinks
**Scenario:** Workspace pattern matches a symlinked directory
**Handling:** Use `fs.realpathSync` to resolve, check if resolved path has package.json.

### 4. Deeply Nested
**Scenario:** `apps/**/packages/*` - 4+ levels deep
**Handling:** Depth limit of 10 in recursive glob to prevent infinite loops.

### 5. Non-Package Directories
**Scenario:** `packages/*` matches `packages/docs/` which has no package.json
**Handling:** Filter - only directories with package.json become services.

### 6. Unicode in Package Names
**Scenario:** `packages/кириллица/package.json` with `"name": "кириллица"`
**Handling:** Handle as-is. Node.js path functions handle unicode.

### 7. Conflicting Configs
**Scenario:** Project has both pnpm-workspace.yaml AND package.json.workspaces
**Handling:** Priority: pnpm > npm/yarn > lerna. Use highest priority, ignore others.

## API Design

### Public Exports (from @grafema/core)

```typescript
// Plugin
export { WorkspaceDiscovery } from './plugins/discovery/WorkspaceDiscovery.js';

// Types
export type WorkspaceType = 'pnpm' | 'npm' | 'yarn' | 'lerna' | null;

export interface WorkspaceDetectionResult {
  type: WorkspaceType;
  configPath: string | null;
  rootPath: string;
}

export interface WorkspaceConfig {
  patterns: string[];
  negativePatterns: string[];
}

export interface WorkspacePackage {
  path: string;
  name: string;
  relativePath: string;
  packageJson: Record<string, unknown>;
}

// Functions
export function detectWorkspaceType(projectPath: string): WorkspaceDetectionResult;
export function resolveWorkspacePackages(projectPath: string, config: WorkspaceConfig): WorkspacePackage[];
```

## Implementation Order

**Phase 1: Foundation (Can be parallelized)**
1. detector.ts + tests (1 hour)
2. parsers/*.ts + tests (2 hours)
3. globResolver.ts + tests (2 hours)

**Phase 2: Plugin**
4. WorkspaceDiscovery.ts + tests (2 hours)
5. index.ts exports (15 min)

**Phase 3: Integration**
6. Test fixtures (1 hour)
7. Orchestrator default plugin update (30 min)
8. Integration tests (1 hour)

**Total Estimate:** ~10 hours of implementation

## Dependencies

- `yaml` - Already in dependencies (for pnpm-workspace.yaml parsing)
- `minimatch` - Already in dependencies (for glob matching)
- No new dependencies required

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Performance on large monorepos | Medium | Medium | Add progress callbacks, consider caching |
| Glob edge cases | Medium | Low | Comprehensive test fixtures |
| Breaking existing behavior | Low | High | WorkspaceDiscovery returns empty on non-workspace, allowing fallback |

## Success Criteria

1. `grafema analyze /path/to/npm-workspace` correctly identifies all workspace packages as services
2. Existing non-workspace projects continue to work (no regression)
3. All workspace types supported: npm, pnpm, yarn, lerna
4. Tests pass for all scenarios in test matrix
5. Documentation updated in README

---

**Next Step:** Kent Beck to write tests based on this spec, starting with detector.test.ts.

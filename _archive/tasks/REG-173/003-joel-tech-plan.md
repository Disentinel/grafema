# Joel Spolsky -- Detailed Technical Specification for REG-173

## Overview

This spec expands Don Melton's high-level plan into implementation-level detail. The core idea: create a `ProjectScanner` in `@grafema/core` that reuses existing discovery infrastructure to produce structured scan results, then build an Ink-based interactive init flow in `@grafema/cli` that presents those results and writes confirmed selections to `config.yaml`.

---

## Phase 1: ProjectScanner (packages/core)

### 1.1 New Types in `@grafema/types`

**File:** `packages/types/src/discovery.ts` (NEW)

```typescript
/**
 * Result of scanning a project for services.
 * Used by ProjectScanner (core) and consumed by CLI init flow and MCP tools.
 */
export interface ScanResult {
  /** Project classification */
  projectType: 'single' | 'workspace' | 'monorepo';
  /** Workspace manager if detected */
  workspaceType?: 'pnpm' | 'npm' | 'yarn' | 'lerna';
  /** Detected services/packages */
  services: DetectedService[];
  /** Non-fatal warnings during scan */
  warnings: string[];
}

export interface DetectedService {
  /** Package name (from package.json name field or directory name) */
  name: string;
  /** Path relative to project root */
  path: string;
  /** Human-readable description ("React app", "Express API", "Node.js library") */
  description: string;
  /** Approximate JS/TS file count for context */
  fileCount: number;
  /** All discovered entry point candidates */
  entryPoints: DetectedEntryPoint[];
  /** Should this service be included by default? */
  recommended: boolean;
}

export interface DetectedEntryPoint {
  /** Path relative to service directory */
  path: string;
  /** Classification of this entry point */
  type: 'source' | 'compiled' | 'alternative';
  /** Human-readable explanation ("TypeScript source", "package.json main field") */
  reason: string;
  /** Is this the recommended entry point? */
  recommended: boolean;
}
```

**Modifications to `packages/types/src/index.ts`:** Add `export * from './discovery.js';`

### 1.2 ProjectScanner

**File:** `packages/core/src/discovery/ProjectScanner.ts` (NEW)

This is the central new class. It reuses existing infrastructure without creating graph nodes.

```typescript
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, basename } from 'path';
import { detectWorkspaceType } from '../plugins/discovery/workspaces/detector.js';
import { parsePnpmWorkspace, parseNpmWorkspace, parseLernaConfig } from '../plugins/discovery/workspaces/parsers.js';
import { resolveWorkspacePackages } from '../plugins/discovery/workspaces/globResolver.js';
import { resolveSourceEntrypoint } from '../plugins/discovery/resolveSourceEntrypoint.js';
import type { ScanResult, DetectedService, DetectedEntryPoint } from '@grafema/types';

export class ProjectScanner {
  /**
   * Scan a project directory and return structured detection results.
   * Pure function -- no graph nodes created, no side effects.
   *
   * @param projectPath - Absolute path to project root
   * @returns ScanResult with detected project type, services, and warnings
   */
  scan(projectPath: string): ScanResult { ... }
}
```

**Key methods (private):**

```typescript
/** Detect project type and enumerate services */
private scanWorkspace(projectPath: string): ScanResult

/** Scan a single-project (non-workspace) root */
private scanSingleProject(projectPath: string): ScanResult

/** Build DetectedService for a single package directory */
private buildDetectedService(
  packagePath: string,
  projectRoot: string,
  packageJson: PackageJson
): DetectedService

/** Enumerate ALL entry point candidates for a service */
private enumerateEntryPoints(
  servicePath: string,
  packageJson: PackageJson
): DetectedEntryPoint[]

/** Classify service type from package.json dependencies */
private classifyService(packageJson: PackageJson): string

/** Fast approximate file count (JS/TS files only) */
private estimateFileCount(dirPath: string): number

/** Determine if a service should be recommended by default */
private isRecommended(relativePath: string, packageJson: PackageJson): boolean
```

#### 1.2.1 Reuse Map

| Existing function | File:Line | Reused for |
|---|---|---|
| `detectWorkspaceType()` | `workspaces/detector.ts:26` | Detect pnpm/npm/yarn/lerna |
| `parsePnpmWorkspace()` | `workspaces/parsers.ts:25` | Parse pnpm-workspace.yaml patterns |
| `parseNpmWorkspace()` | `workspaces/parsers.ts:50` | Parse package.json workspaces |
| `parseLernaConfig()` | `workspaces/parsers.ts:86` | Parse lerna.json packages |
| `resolveWorkspacePackages()` | `workspaces/globResolver.ts:40` | Resolve glob patterns to package dirs |
| `resolveSourceEntrypoint()` | `resolveSourceEntrypoint.ts:75` | Find best TS source entry point |

All of these are pure functions that work on the filesystem. None require graph access. They can be called directly.

#### 1.2.2 New Logic: `enumerateEntryPoints()`

Unlike `resolveSourceEntrypoint()` which returns the FIRST match, this returns ALL candidates with classification.

**Candidate sources (in priority order):**

1. `package.json` `"source"` field -- type: `source`, reason: "package.json source field"
2. `TS_SOURCE_CANDIDATES` list from `resolveSourceEntrypoint.ts` (lines 37-50) -- check all, not just first match. Each gets type: `source`, reason: "TypeScript source"
3. `package.json` `"main"` field -- type: `compiled`, reason: "package.json main field"
4. `package.json` `"module"` field -- type: `compiled`, reason: "package.json module field (ESM)"
5. `package.json` `"exports"` field (`.` entry, `import` or `default`) -- type: `compiled`, reason: "package.json exports"
6. JS candidates: `index.js`, `src/index.js`, `lib/index.js` -- type: `alternative`, reason: "Standard JS entry"

The first entry point in `source` type is marked `recommended: true`. If no source candidates exist, the first `compiled` entry is recommended. If none, the first `alternative` is recommended.

**Reuse strategy:** Import `TS_SOURCE_CANDIDATES` from `resolveSourceEntrypoint.ts`. Currently this is a private `const`. We need to **export** it (minor modification to `resolveSourceEntrypoint.ts` line 37: change from unexported const to `export const`).

#### 1.2.3 New Logic: `classifyService()`

Inspect `package.json` `dependencies` and `devDependencies` to produce a human-readable label.

**Heuristic table (checked in order, first match wins):**

| Dependency match | Description |
|---|---|
| `next` | "Next.js app" |
| `nuxt` | "Nuxt.js app" |
| `@angular/core` | "Angular app" |
| `react` + `react-dom` | "React app" |
| `vue` | "Vue.js app" |
| `svelte` | "Svelte app" |
| `express` | "Express API" |
| `fastify` | "Fastify API" |
| `@nestjs/core` | "NestJS API" |
| `koa` | "Koa API" |
| `hono` | "Hono API" |
| `socket.io` | "Socket.IO server" |
| `electron` | "Electron app" |
| `react-native` | "React Native app" |
| `typescript` (in devDeps only) | "TypeScript library" |
| (default) | "Node.js package" |

This function is stateless, easily testable, and trivially extensible by adding rows.

#### 1.2.4 New Logic: `estimateFileCount()`

Fast approximation of JS/TS file count.

```typescript
private estimateFileCount(dirPath: string, maxDepth: number = 5): number {
  let count = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' ||
            entry.name === 'dist' || entry.name === 'build') continue;
        if (entry.isDirectory()) {
          walk(join(dir, entry.name), depth + 1);
        } else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(entry.name)) {
          count++;
        }
      }
    } catch { /* permission errors */ }
  };
  walk(dirPath, 0);
  return count;
}
```

**Complexity:** O(F) where F = total filesystem entries within depth limit. Skips `node_modules`, `dist`, `build`, hidden dirs. Max depth 5 limits worst case. On a typical package with 100 files, this takes <10ms.

#### 1.2.5 New Logic: `isRecommended()`

Determines if a service should be pre-selected.

**Rules:**
- NOT recommended if path contains `scripts/`, `tools/`, `fixtures/`, `test/`, `__tests__/`, `examples/`, `docs/`, `benchmarks/`
- NOT recommended if `package.json.private === true` AND name contains `internal` or `private`
- NOT recommended if name starts with `@types/`
- Otherwise: recommended

#### 1.2.6 `scan()` Implementation Flow

```
scan(projectPath):
  1. Validate projectPath exists and has package.json
  2. result = detectWorkspaceType(projectPath)
  3. IF result.type !== null:
       // Workspace project
       config = parse{Pnpm|Npm|Lerna}Workspace(result.configPath)
       packages = resolveWorkspacePackages(projectPath, config)
       FOR EACH package:
         service = buildDetectedService(package.path, projectPath, package.packageJson)
       RETURN { projectType: 'workspace', workspaceType: result.type, services, warnings }
  4. ELSE:
       // Single project
       service = buildDetectedService(projectPath, projectPath, rootPackageJson)
       RETURN { projectType: 'single', services: [service], warnings }
```

### 1.3 Export from `@grafema/core`

**File:** `packages/core/src/discovery/index.ts` (NEW)

```typescript
export { ProjectScanner } from './ProjectScanner.js';
```

**File:** `packages/core/src/index.ts` (MODIFY -- add near line 268, after workspace exports)

```typescript
// Project scanner (for init command and MCP)
export { ProjectScanner } from './discovery/index.js';
```

**File:** `packages/core/src/plugins/discovery/resolveSourceEntrypoint.ts` (MODIFY)

Line 37: Change `const TS_SOURCE_CANDIDATES` to `export const TS_SOURCE_CANDIDATES`

This is a one-word change. It allows `ProjectScanner.enumerateEntryPoints()` to reuse the exact same candidate list without duplication.

### 1.4 Complexity Analysis for Phase 1

| Operation | Complexity | Notes |
|---|---|---|
| `detectWorkspaceType()` | O(1) | Fixed set of file existence checks (4 files) |
| `parse*Workspace()` | O(1) | Parse single config file |
| `resolveWorkspacePackages()` | O(P * G) | P = glob patterns, G = matching dirs. Bounded by maxDepth=10 in recursive glob |
| `buildDetectedService()` per service | O(1) | Read package.json, check ~15 entry candidates |
| `enumerateEntryPoints()` per service | O(C) | C = candidate count (~20 fixed candidates) = O(1) |
| `classifyService()` per service | O(D) | D = dependency count. Single pass, ~15 checks = O(1) amortized |
| `estimateFileCount()` per service | O(F) | F = files in package dir (depth-limited to 5) |
| **Full scan (workspace)** | **O(S * F_avg)** | S = services, F_avg = avg files per service. For 200 packages with ~50 files each: ~10,000 fs ops. Takes <1s on SSD. |
| **Full scan (single project)** | **O(F)** | F = total JS/TS files in project |

**Performance target:** <2 seconds for a 200-package monorepo on SSD. The file count estimation is the bottleneck; everything else is O(1) per service.

---

## Phase 2: Interactive Init Flow (packages/cli)

### 2.1 Rewrite `init.ts` to `init.tsx`

**File:** `packages/cli/src/commands/init.ts` -> rename to `packages/cli/src/commands/init.tsx` (REWRITE)

The current `init.ts` is 199 lines with raw `readline`. The rewrite preserves existing behavior (config generation, .gitignore update) and adds the interactive service discovery flow.

**Command signature stays the same:**
```
grafema init [path] [--force] [--yes]
```

#### 2.1.1 Architecture

```
init.tsx
  |
  +-- InitApp (Ink component, root)
  |     |
  |     +-- ScanningStep (spinner while scanning)
  |     +-- ServiceSelectionStep (multi-select)
  |     +-- EntryPointSelectionStep (single-select, per service)
  |     +-- ConfigSummaryStep (show final config, confirm)
  |     +-- CompletionStep (success message, next steps)
  |
  +-- initCommand (Commander definition, preserved)
```

#### 2.1.2 InitApp Component

```typescript
interface InitAppProps {
  projectPath: string;
  options: InitOptions;
}

interface InitState {
  step: 'scanning' | 'services' | 'entrypoints' | 'summary' | 'complete' | 'error';
  scanResult: ScanResult | null;
  selectedServices: Map<string, boolean>;  // path -> selected
  entryPointChoices: Map<string, string>;  // service path -> chosen entry point path
  currentEntryPointService: number;  // index into services needing entry point selection
  error: string | null;
}
```

**Flow:**

1. **scanning**: Call `new ProjectScanner().scan(projectPath)`. Show Ink `<Spinner>` (from `ink-spinner`, already implicit in Ink). On complete, transition to `services`.

2. **services**: Show multi-select list of detected services. Pre-select recommended ones. User toggles with space, confirms with enter. If only 1 service, auto-select and skip.

3. **entrypoints**: For each selected service that has >1 entry point candidate, show single-select. If service has exactly 1 candidate, auto-select. Show only for services needing a choice.

4. **summary**: Show the config that will be written. Ask "Write this config? [Y/n]".

5. **complete**: Write config, update .gitignore, show next steps.

#### 2.1.3 Custom Selection Components

Since we do NOT have `ink-select-input` or `ink-multi-select` as dependencies, and adding them would be unnecessary (the `explore.tsx` proves we can build selection UI with `useInput`), we build minimal components.

**File:** `packages/cli/src/components/MultiSelect.tsx` (NEW, ~80 lines)

```typescript
interface MultiSelectProps<T> {
  items: Array<{ label: string; value: T; description?: string; selected: boolean }>;
  onSubmit: (selected: T[]) => void;
  header?: string;
}
```

Renders a list with `[x]`/`[ ]` toggles. Uses `useInput` for keyboard handling:
- Up/Down arrows: navigate
- Space: toggle selection
- Enter: confirm
- `a`: select all
- `n`: select none

**File:** `packages/cli/src/components/SingleSelect.tsx` (NEW, ~60 lines)

```typescript
interface SingleSelectProps<T> {
  items: Array<{ label: string; value: T; description?: string; recommended?: boolean }>;
  onSubmit: (selected: T) => void;
  header?: string;
}
```

Renders a list with `>` indicator. Up/Down to navigate, Enter to confirm.

Both components follow the exact pattern from `explore.tsx` (lines 189-337): `useInput` hook with arrow key handling and state management via `useState`.

#### 2.1.4 Config Generation

**Reuse:** `generateConfigYAML()` from current `init.ts` (lines 20-49) is preserved as a utility function but modified to accept a `services` parameter.

```typescript
function generateConfigYAML(services?: ServiceDefinition[]): string {
  const config: Record<string, unknown> = {
    plugins: DEFAULT_CONFIG.plugins,
  };

  if (services && services.length > 0) {
    config.services = services;
  }

  // ... rest same as current implementation
}
```

**Config writer:** Extracted to a separate function for testability:

```typescript
export function writeGrafemaConfig(
  projectPath: string,
  services: ServiceDefinition[],
  options: { force?: boolean }
): { configPath: string; created: boolean }
```

This function:
1. Creates `.grafema/` directory if needed
2. Generates YAML content with services
3. Writes to `config.yaml`
4. Updates `.gitignore` if exists
5. Returns the config path and whether it was created or updated

#### 2.1.5 Non-Interactive Mode (`--yes`)

When `--yes` is passed OR stdin is not TTY:

```typescript
async function runNonInteractive(projectPath: string): Promise<void> {
  const scanner = new ProjectScanner();
  const result = scanner.scan(projectPath);

  // Auto-select recommended services with recommended entry points
  const services: ServiceDefinition[] = result.services
    .filter(s => s.recommended)
    .map(s => {
      const recommended = s.entryPoints.find(ep => ep.recommended);
      return {
        name: s.name,
        path: s.path,
        ...(recommended ? { entryPoint: recommended.path } : {}),
      };
    });

  writeGrafemaConfig(projectPath, services, { force: false });

  // Print summary to stdout
  console.log(`Detected ${result.projectType} project`);
  if (result.workspaceType) console.log(`Workspace: ${result.workspaceType}`);
  console.log(`Services: ${services.length} selected (of ${result.services.length} detected)`);
  for (const svc of services) {
    console.log(`  - ${svc.name} (${svc.path})`);
  }
}
```

### 2.2 Preserving Existing Behavior

The following behaviors from current `init.ts` are **preserved**:

| Behavior | Current location | Preservation strategy |
|---|---|---|
| `package.json` existence check | `init.ts:129` | Moved to early validation in `initCommand.action()` before Ink renders |
| TypeScript detection message | `init.ts:143-148` | Shown in ScanningStep based on `scanResult.services[0].description` |
| Existing config check + `--force` | `init.ts:151-157` | Checked before Ink renders, same logic |
| `.grafema/` directory creation | `init.ts:160-162` | In `writeGrafemaConfig()` |
| `.gitignore` update | `init.ts:170-180` | In `writeGrafemaConfig()` |
| "Run analysis now?" prompt | `init.ts:185-197` | Final step in CompletionStep |
| `--yes` flag | `init.ts:100-102` | `runNonInteractive()` |

### 2.3 Complexity Analysis for Phase 2

| Operation | Complexity | Notes |
|---|---|---|
| Ink render cycle | O(S) | S = services displayed. React reconciliation. |
| Service selection toggle | O(1) | Map.set() |
| Config generation | O(S) | S = selected services. YAML serialization. |
| File write | O(1) | Single file write |
| **Full interactive flow** | **O(S)** | Dominated by scan (Phase 1) |

---

## Phase 3: Non-Interactive Mode & Edge Cases

### 3.1 Empty Project (no package.json)

**Current behavior preserved:** Error message with suggestions (lines 129-139 of current `init.ts`). This check happens BEFORE any scanning.

### 3.2 Single-File Project

`ProjectScanner.scan()` handles this: if only root `package.json` exists with no `src/` directory and no workspace, returns single service with whatever entry point is detected (or `index.js` fallback). `estimateFileCount()` returns the actual count (could be 1).

### 3.3 Nested Workspaces

`resolveWorkspacePackages()` already handles this via glob resolution with depth limit (10 levels in `expandRecursiveGlob`, line 165 of `globResolver.ts`). Nested workspaces that match patterns are included. The `seen` set (line 45) prevents duplicates.

### 3.4 Symlinks

`globResolver.ts` line 221-228: `isDirectory()` uses `lstatSync` and explicitly rejects symlinks (`stat.isSymbolicLink()` returns false). This is intentional to avoid infinite loops. ProjectScanner inherits this behavior.

### 3.5 Very Large Monorepos (200+ packages)

For 200+ services, the multi-select list becomes unwieldy. Mitigation:

**Phase 1 (this ticket):**
- Display all services but group by directory prefix (e.g., "packages/ (34)", "apps/ (3)", "libs/ (12)")
- When group has >20 items, show count and offer "select all in group" shortcut
- The `estimateFileCount()` depth limit prevents slowness

**Future (out of scope):**
- Search/filter within service list
- Pagination
- Collapsible groups

**Implementation detail:** In `ServiceSelectionStep`, if `services.length > 50`, render a grouped view instead of flat list. Grouping key = first path segment (e.g., `packages`, `apps`, `libs`).

```typescript
function groupServices(services: DetectedService[]): Map<string, DetectedService[]> {
  const groups = new Map<string, DetectedService[]>();
  for (const svc of services) {
    const group = svc.path.split('/')[0] || 'root';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(svc);
  }
  return groups;
}
```

### 3.6 Windows Path Handling

All path operations use `join()` and `relative()` from Node's `path` module, which handles separators correctly. The `matchesPattern()` in `globResolver.ts` (line 89-93) already normalizes `\` to `/` for glob matching. No additional Windows handling needed in ProjectScanner.

### 3.7 Non-JS Projects

Preserved from current `init.ts`: the `package.json` check at the very start of the command action (before any scanning) exits with a helpful error message. ProjectScanner itself does not validate language -- it only looks for `package.json` files within the project.

---

## Phase 4: Tests

### 4.1 Test Files

| Test file | Type | What it tests |
|---|---|---|
| `test/unit/discovery/ProjectScanner.test.ts` | Unit | ProjectScanner.scan() with fixture dirs |
| `test/unit/discovery/classifyService.test.ts` | Unit | Service classification heuristic |
| `test/unit/discovery/enumerateEntryPoints.test.ts` | Unit | Entry point enumeration |
| `test/unit/discovery/estimateFileCount.test.ts` | Unit | File count estimation |
| `test/integration/cli-init.test.ts` | Integration | Full init command (extend existing) |

### 4.2 Test Fixture Structure

```
test/fixtures/init-test/
  single-project/
    package.json          # { name: "my-app", dependencies: { express: "4" } }
    tsconfig.json
    src/
      index.ts
      server.ts
    dist/
      index.js

  pnpm-workspace/
    package.json          # { name: "workspace", private: true }
    pnpm-workspace.yaml   # packages: ["packages/*", "apps/*"]
    packages/
      core/
        package.json      # { name: "@test/core", dependencies: { typescript: "5" } }
        tsconfig.json
        src/index.ts
      utils/
        package.json      # { name: "@test/utils" }
        tsconfig.json
        src/index.ts
        lib/index.ts      # alternative entry
    apps/
      web/
        package.json      # { name: "@test/web", dependencies: { react: "19", react-dom: "19" } }
        tsconfig.json
        src/index.tsx
      api/
        package.json      # { name: "@test/api", dependencies: { express: "4" } }
        tsconfig.json
        src/index.ts
        src/server.ts     # alternative entry

  npm-workspace/
    package.json          # { name: "workspace", workspaces: ["packages/*"] }
    packages/
      foo/
        package.json
        src/index.ts
        tsconfig.json

  no-package-json/
    src/
      index.ts

  scripts-only/
    package.json
    scripts/
      build.js
      deploy.js
```

**Note:** Fixtures are created dynamically in `beforeEach` using `mkdtempSync` + `writeFileSync` (matching the pattern from `test/unit/plugins/discovery/WorkspaceDiscovery.test.ts` lines 101-144). No static fixture files needed.

### 4.3 Key Test Cases

#### ProjectScanner.test.ts

```typescript
describe('ProjectScanner', () => {
  describe('scan() -- single project', () => {
    it('detects single project with package.json');
    it('returns projectType "single"');
    it('classifies Express project correctly');
    it('detects TypeScript source entry point');
    it('enumerates multiple entry point candidates');
    it('marks source entry as recommended');
    it('returns approximate file count');
    it('marks service as recommended by default');
  });

  describe('scan() -- pnpm workspace', () => {
    it('detects pnpm workspace type');
    it('resolves all packages from glob patterns');
    it('returns projectType "workspace" with workspaceType "pnpm"');
    it('classifies each service independently');
    it('handles packages without entry points');
  });

  describe('scan() -- npm workspace', () => {
    it('detects npm/yarn workspace from package.json');
    it('resolves packages correctly');
  });

  describe('scan() -- edge cases', () => {
    it('returns error warning for missing package.json');
    it('handles empty workspace (no packages match pattern)');
    it('skips packages without package.json');
    it('handles malformed package.json gracefully');
    it('limits file count depth to prevent slowness');
  });

  describe('isRecommended()', () => {
    it('excludes paths containing "scripts/"');
    it('excludes paths containing "test/"');
    it('excludes paths containing "examples/"');
    it('includes standard packages by default');
    it('excludes @types/ packages');
  });
});
```

#### classifyService.test.ts

```typescript
describe('classifyService', () => {
  it('returns "React app" for react + react-dom deps');
  it('returns "Express API" for express dep');
  it('returns "Next.js app" for next dep');
  it('returns "TypeScript library" for TS devDep only');
  it('returns "Node.js package" for unknown deps');
  it('prioritizes framework over library (React > TS)');
  it('handles empty dependencies');
  it('handles undefined dependencies');
});
```

#### enumerateEntryPoints.test.ts

```typescript
describe('enumerateEntryPoints', () => {
  it('finds src/index.ts as source entry point');
  it('finds package.json main as compiled entry');
  it('finds package.json source field');
  it('finds multiple candidates and ranks them');
  it('marks first source entry as recommended');
  it('falls back to compiled when no source exists');
  it('handles package.json exports field');
  it('returns empty array when no candidates exist');
  it('does not include non-existent files');
});
```

#### cli-init.test.ts (extend existing)

```typescript
describe('grafema init -- service discovery', () => {
  it('--yes auto-selects recommended services');
  it('--yes writes services to config.yaml');
  it('--yes shows service count in output');
  it('--yes handles workspace projects');
  it('--force overwrites existing config with new services');
  it('generates valid YAML that loadConfig() can parse');
  it('generated services pass ConfigLoader validation');
});
```

### 4.4 Mocking Strategy

| What | Mock? | Rationale |
|---|---|---|
| Filesystem | **Real** (temp dirs) | Discovery relies heavily on fs. Mocking fs defeats the purpose. Use `mkdtempSync` + cleanup. |
| `ProjectScanner` in CLI tests | **Real** | It's a pure function on filesystem. Use real scanner with temp fixtures. |
| Ink rendering | **No interactive tests** | Ink components are tested via `--yes` mode (non-interactive). Interactive testing would require `ink-testing-library` which is out of scope. |
| `stdin`/`stdout` in integration | **Subprocess** | Run CLI as child process (existing pattern in `cli-init.test.ts` line 24-36). |

---

## Dependency Map

```
Phase 1 (ProjectScanner)
  |
  +-- types: new discovery.ts types
  |     (no dependencies, pure interfaces)
  |
  +-- core: ProjectScanner class
  |     depends on: existing discovery infrastructure
  |     one-line change to resolveSourceEntrypoint.ts (export const)
  |     new directory: packages/core/src/discovery/
  |
  +-- core/index.ts: add export
  |     depends on: ProjectScanner exists
  |
  v
Phase 2 (Interactive Init) -- BLOCKED by Phase 1
  |
  +-- cli: MultiSelect.tsx, SingleSelect.tsx components
  |     depends on: ink (already installed)
  |
  +-- cli: init.tsx rewrite
  |     depends on: ProjectScanner (from Phase 1), components
  |
  v
Phase 3 (Non-Interactive Mode) -- BLOCKED by Phase 2
  |
  +-- cli: --yes mode, edge case handling
  |     depends on: init.tsx structure
  |
  v
Phase 4 (Tests) -- PARTIALLY PARALLELIZABLE
  |
  +-- unit tests for ProjectScanner -- can start with Phase 1
  +-- unit tests for components -- can start with Phase 2
  +-- integration tests -- after Phase 3
```

**Critical path:** Types -> ProjectScanner -> init.tsx -> --yes mode -> integration tests

**Parallelizable:** Unit tests for each phase can be written alongside implementation (TDD).

---

## Files Summary

### New Files

| File | Package | Lines (est) | Purpose |
|---|---|---|---|
| `packages/types/src/discovery.ts` | types | ~50 | ScanResult, DetectedService, DetectedEntryPoint interfaces |
| `packages/core/src/discovery/ProjectScanner.ts` | core | ~250 | Main scanner class |
| `packages/core/src/discovery/index.ts` | core | ~3 | Barrel export |
| `packages/cli/src/components/MultiSelect.tsx` | cli | ~80 | Reusable multi-select Ink component |
| `packages/cli/src/components/SingleSelect.tsx` | cli | ~60 | Reusable single-select Ink component |
| `test/unit/discovery/ProjectScanner.test.ts` | test | ~300 | Unit tests for scanner |
| `test/unit/discovery/classifyService.test.ts` | test | ~80 | Unit tests for classifier |
| `test/unit/discovery/enumerateEntryPoints.test.ts` | test | ~120 | Unit tests for entry point enumeration |
| `test/unit/discovery/estimateFileCount.test.ts` | test | ~60 | Unit tests for file count |

### Modified Files

| File | Package | Change | Lines changed (est) |
|---|---|---|---|
| `packages/types/src/index.ts` | types | Add `export * from './discovery.js'` | +1 |
| `packages/core/src/index.ts` | core | Add ProjectScanner export | +3 |
| `packages/core/src/plugins/discovery/resolveSourceEntrypoint.ts` | core | Export `TS_SOURCE_CANDIDATES` | +1 word |
| `packages/cli/src/commands/init.ts` -> `init.tsx` | cli | Full rewrite with Ink | ~300 (replace ~200) |
| `test/integration/cli-init.test.ts` | test | Add service discovery tests | +50 |

### Unchanged Files

All existing discovery plugins (`SimpleProjectDiscovery.ts`, `WorkspaceDiscovery.ts`, `MonorepoServiceDiscovery.ts`), `ConfigLoader.ts`, `Orchestrator.ts` remain **unchanged**. ProjectScanner calls the same utility functions these plugins use, but does not modify them.

---

## Acceptance Criteria

### Phase 1: ProjectScanner
- [ ] `ScanResult`, `DetectedService`, `DetectedEntryPoint` types exist in `@grafema/types`
- [ ] `ProjectScanner` class exists in `@grafema/core`
- [ ] `ProjectScanner.scan()` correctly detects single projects
- [ ] `ProjectScanner.scan()` correctly detects pnpm workspaces
- [ ] `ProjectScanner.scan()` correctly detects npm/yarn workspaces
- [ ] `ProjectScanner.scan()` correctly detects lerna workspaces
- [ ] Entry point enumeration returns all candidates with correct classification
- [ ] Service classification produces human-readable labels
- [ ] File count estimation completes in <100ms per service
- [ ] `ProjectScanner` is exported from `@grafema/core`
- [ ] All unit tests pass

### Phase 2: Interactive Init Flow
- [ ] `grafema init` shows spinner during scan
- [ ] Detected services are shown in multi-select list
- [ ] Recommended services are pre-selected
- [ ] User can toggle service selection with space key
- [ ] Services with multiple entry points show entry point selection
- [ ] Config summary is shown before writing
- [ ] Config is written to `.grafema/config.yaml` with services array
- [ ] `.gitignore` is updated (preserved from current behavior)
- [ ] "Run analysis now?" prompt works (preserved from current behavior)

### Phase 3: Non-Interactive Mode
- [ ] `grafema init --yes` auto-selects recommended services
- [ ] `grafema init --yes` auto-selects recommended entry points
- [ ] `grafema init --yes` writes config silently with summary output
- [ ] Non-TTY stdin falls back to non-interactive mode
- [ ] Empty project (no package.json) shows existing error message

### Phase 4: Tests
- [ ] Unit tests cover ProjectScanner for all project types
- [ ] Unit tests cover service classification heuristic
- [ ] Unit tests cover entry point enumeration
- [ ] Integration tests verify `--yes` mode end-to-end
- [ ] Generated config passes `loadConfig()` validation
- [ ] All existing tests continue to pass (no regressions)

---

## Risk Register (from Don's plan, with mitigations specified)

### R1: Ink complexity for prompts
**Mitigation:** Build minimal MultiSelect/SingleSelect (~140 lines total) following `explore.tsx` patterns. The `useInput` hook + `useState` pattern is proven in this codebase. If Ink issues arise, fall back to raw `process.stdout.write` + `process.stdin` with ANSI escape codes (not readline -- that only supports line-by-line).

**Decision gate:** If the two selection components take more than 4 hours to build, fall back to stdout/stdin approach.

### R2: Service classification heuristics wrong
**Mitigation:** Labels are purely informational. No logic depends on them. Wrong label = user sees "Node.js package" instead of "Express API". They still select/deselect based on path and name. Easily fixable post-launch by adding rows to the heuristic table.

### R3: Entry point detection misses candidates
**Mitigation:** The enumeration checks ~20 well-known patterns covering 95%+ of JS/TS projects. For the remaining 5%, the user can edit `config.yaml` directly. The `enumerateEntryPoints()` function is pure and easily extensible.

### R4: Large monorepo performance
**Mitigation:** `estimateFileCount()` has depth=5 limit. `resolveWorkspacePackages()` has maxDepth=10 limit (in `expandRecursiveGlob`). For 200 packages, total scan should take <2s. Tested with fixture that creates 200 temp dirs.

---

## Implementation Order (for Kent and Rob)

1. **Start with types** (`discovery.ts`) -- this unblocks everything
2. **Export `TS_SOURCE_CANDIDATES`** -- one-word change, unblocks enumerateEntryPoints
3. **Build ProjectScanner with tests** (TDD: write test, implement, verify)
4. **Build MultiSelect + SingleSelect components**
5. **Rewrite init.tsx** using ProjectScanner + components
6. **Add --yes mode**
7. **Extend integration tests**
8. **Run full test suite, verify no regressions**

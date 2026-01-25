# Kent Beck: Test Report for WorkspaceDiscovery Plugin

## Summary

I have written comprehensive TDD tests for the WorkspaceDiscovery plugin. The tests are designed to fail until implementation exists - this is the intended TDD workflow.

## Test File

**Location:** `/Users/vadimr/grafema/test/unit/plugins/discovery/WorkspaceDiscovery.test.js`

## Test Coverage

### 1. WorkspaceTypeDetector (25 tests)

Tests for detecting workspace type from configuration files:

| Test Case | Description |
|-----------|-------------|
| pnpm from pnpm-workspace.yaml | Detects pnpm workspace from standard config file |
| pnpm from pnpm-workspace.yml | Handles .yml extension variant |
| npm from package.json workspaces array | Detects npm workspaces with array format |
| npm absent when no workspaces field | Returns null for non-workspace package.json |
| yarn from package.json workspaces object | Handles yarn's object format with packages/nohoist |
| lerna from lerna.json | Detects lerna configuration |
| lerna without packages field | Uses default packages/* pattern |
| non-workspace projects | Returns null type for simple projects |
| empty directory | Handles missing configuration gracefully |
| pnpm > npm priority | pnpm takes precedence when both exist |
| pnpm > lerna priority | pnpm takes precedence over lerna |
| npm > lerna priority | npm takes precedence over lerna |

### 2. Workspace Parsers (15 tests)

Tests for parsing configuration files:

**parsePnpmWorkspace:**
- Simple packages array
- Multiple patterns
- Negative patterns separation (! prefix)
- Empty packages array

**parseNpmWorkspace:**
- Array format (`workspaces: []`)
- Object format (`workspaces: { packages: [] }`)
- Negation patterns
- Missing workspaces field

**parseLernaConfig:**
- Packages array from lerna.json
- Default packages/* when field missing
- Empty packages array

### 3. Glob Resolution (18 tests)

Tests for resolving glob patterns to actual packages:

| Pattern Type | Test Cases |
|--------------|------------|
| Simple globs | `packages/*`, `apps/*`, multiple patterns |
| Nested globs | `apps/**`, deeply nested packages |
| Negation | Single exclusion, multiple exclusions |
| Edge cases | Missing package.json, non-matching patterns, empty patterns |
| Literal paths | Exact directory paths |
| Result format | Relative path, package.json content, fallback name |

### 4. WorkspaceDiscovery Plugin (25 tests)

Full plugin integration tests:

**Plugin Metadata:**
- Correct name, phase, priority (110)
- Creates SERVICE nodes

**Workspace Type Detection:**
- pnpm workspace packages
- npm workspace packages
- lerna packages
- Non-workspace projects (skipped)

**Service Metadata:**
- workspaceType field
- discoveryMethod field
- version, description, private, dependencies
- relativePath
- TypeScript source entrypoint resolution

**Error Handling:**
- Missing projectPath
- Malformed pnpm-workspace.yaml
- Malformed package.json in workspace member

**Advanced Scenarios:**
- Nested workspace patterns
- Negation patterns exclusion
- Result format for manifest

### 5. Integration Tests (3 tests)

Real-world workspace structure reproductions:

1. **jammers-style** - User issue reproduction (npm workspaces with literal paths)
2. **grafema-style** - pnpm workspace with packages/*
3. **turbo-style** - Mixed apps/* and packages/* patterns

## Test Patterns Used

Following existing codebase patterns from:
- `test/unit/plugins/discovery/resolveSourceEntrypoint.test.js`
- `test/unit/config/ConfigLoader.test.ts`
- `test/unit/plugins/indexing/JSModuleIndexer.test.ts`

### MockGraphBackend

Implemented mock based on JSModuleIndexer.test.ts pattern:

```javascript
class MockGraphBackend {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
  }
  async addNode(node) { ... }
  async addEdge(edge) { ... }
  async *queryNodes(filter) { ... }
  // ... all GraphBackend interface methods
}
```

### Test Helpers

- `createPluginContext(projectPath, graph)` - Creates plugin context
- `createPackageJson(name, options)` - Creates package.json content
- `createPnpmWorkspaceYaml(packages)` - Creates pnpm config
- `createLernaJson(packages)` - Creates lerna config
- `createWorkspacePackage(path, name, options)` - Creates full package directory

## Test Execution

To run tests:
```bash
node --test test/unit/plugins/discovery/WorkspaceDiscovery.test.js
```

**Current status:** Tests fail on import because exports don't exist yet.

```
SyntaxError: The requested module '@grafema/core' does not provide
an export named 'WorkspaceDiscovery'
```

This is expected - TDD workflow. Implementation will make tests pass.

## Required Exports from @grafema/core

The test file expects these exports:

```javascript
import {
  detectWorkspaceType,      // WorkspaceTypeDetector function
  parsePnpmWorkspace,       // pnpm parser function
  parseNpmWorkspace,        // npm/yarn parser function
  parseLernaConfig,         // lerna parser function
  resolveWorkspacePackages, // Glob resolver function
  WorkspaceDiscovery,       // Plugin class
} from '@grafema/core';
```

## Expected Types (from tech plan)

```typescript
type WorkspaceType = 'pnpm' | 'npm' | 'yarn' | 'lerna' | null;

interface WorkspaceDetectionResult {
  type: WorkspaceType;
  configPath: string | null;
  rootPath: string;
}

interface WorkspaceConfig {
  patterns: string[];
  negativePatterns: string[];
}

interface WorkspacePackage {
  path: string;
  name: string;
  relativePath: string;
  packageJson: Record<string, unknown>;
}
```

## Alignment with Tech Plan

Tests cover all scenarios from Joel's tech plan test matrix:

| Scenario | Covered |
|----------|---------|
| npm basic | Yes |
| npm array format | Yes |
| yarn object format | Yes |
| pnpm basic | Yes |
| pnpm negation | Yes |
| lerna basic | Yes |
| lerna defaults | Yes |
| nested workspace | Yes |
| no workspace | Yes |
| empty patterns | Yes |
| missing package.json | Yes |
| private packages | Yes |

## Next Steps

Implementation should:
1. Make all WorkspaceTypeDetector tests pass
2. Make all parser tests pass
3. Make all glob resolution tests pass
4. Make WorkspaceDiscovery plugin tests pass
5. Make integration tests pass

---

**Test Count:** 86 test cases across 5 describe blocks
**Status:** Written, failing (expected - TDD)
**Author:** Kent Beck (test discipline)

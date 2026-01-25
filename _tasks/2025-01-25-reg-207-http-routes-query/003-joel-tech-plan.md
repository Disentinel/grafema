# REG-207: HTTP Routes Query - Technical Implementation Plan

**Author:** Joel Spolsky (Implementation Planner)
**Date:** 2025-01-25
**Based on:** Don's Plan (002-don-plan.md)

## Executive Summary

Implement HTTP route searching in `grafema query` by:
1. Adding `http:route` to default search types
2. Adding type aliases (route, endpoint, http)
3. Implementing type-aware field matching for HTTP routes (search method + path, not name)
4. Formatting HTTP route display to show METHOD PATH prominently

---

## Implementation Details

### File: `/packages/cli/src/commands/query.ts`

#### Change 1: Add Type Aliases in `parsePattern()` (Lines 136-146)

**Current Code (Lines 136-146):**
```typescript
const typeMap: Record<string, string> = {
  function: 'FUNCTION',
  fn: 'FUNCTION',
  func: 'FUNCTION',
  class: 'CLASS',
  module: 'MODULE',
  variable: 'VARIABLE',
  var: 'VARIABLE',
  const: 'CONSTANT',
  constant: 'CONSTANT',
};
```

**New Code:**
```typescript
const typeMap: Record<string, string> = {
  function: 'FUNCTION',
  fn: 'FUNCTION',
  func: 'FUNCTION',
  class: 'CLASS',
  module: 'MODULE',
  variable: 'VARIABLE',
  var: 'VARIABLE',
  const: 'CONSTANT',
  constant: 'CONSTANT',
  // HTTP route aliases
  route: 'http:route',
  endpoint: 'http:route',
  http: 'http:route',
};
```

**Purpose:** Allows `grafema query "route /api"` and `grafema query "endpoint /users"`.

---

#### Change 2: Add `http:route` to Default Search Types in `findNodes()` (Lines 166-168)

**Current Code (Lines 166-168):**
```typescript
const searchTypes = type
  ? [type]
  : ['FUNCTION', 'CLASS', 'MODULE', 'VARIABLE', 'CONSTANT'];
```

**New Code:**
```typescript
const searchTypes = type
  ? [type]
  : ['FUNCTION', 'CLASS', 'MODULE', 'VARIABLE', 'CONSTANT', 'http:route'];
```

**Purpose:** When no type specified, also search HTTP routes.

---

#### Change 3: Implement Type-Aware Field Matching (Lines 170-188)

**Current Code (Lines 170-188):**
```typescript
for (const nodeType of searchTypes) {
  for await (const node of backend.queryNodes({ nodeType: nodeType as any })) {
    const nodeName = node.name || '';
    // Case-insensitive partial match
    if (nodeName.toLowerCase().includes(name.toLowerCase())) {
      results.push({
        id: node.id,
        type: node.type || nodeType,
        name: nodeName,
        file: node.file || '',
        line: node.line,
      });
      if (results.length >= limit) break;
    }
  }
  if (results.length >= limit) break;
}
```

**New Code:**
```typescript
for (const nodeType of searchTypes) {
  for await (const node of backend.queryNodes({ nodeType: nodeType as any })) {
    // Type-aware field matching
    const matches = matchesSearchPattern(node, nodeType, name);

    if (matches) {
      results.push({
        id: node.id,
        type: node.type || nodeType,
        name: node.name || '',
        file: node.file || '',
        line: node.line,
        // Include method and path for http:route nodes
        ...(nodeType === 'http:route' ? { method: node.method, path: node.path } : {}),
      });
      if (results.length >= limit) break;
    }
  }
  if (results.length >= limit) break;
}
```

---

#### Change 4: Add New Helper Function `matchesSearchPattern()` (After Line 154)

**New Function (Insert after `parsePattern()`, before `findNodes()`):**

```typescript
/**
 * Check if a node matches the search pattern based on its type.
 *
 * Different node types have different searchable fields:
 * - http:route: search method and path fields
 * - Default: search name field
 */
function matchesSearchPattern(
  node: { name?: string; method?: string; path?: string; [key: string]: unknown },
  nodeType: string,
  pattern: string
): boolean {
  const lowerPattern = pattern.toLowerCase();

  // HTTP routes: search method and path
  if (nodeType === 'http:route') {
    const method = (node.method || '').toLowerCase();
    const path = (node.path || '').toLowerCase();

    // Pattern could be: "POST", "/api/users", "POST /api", etc.
    const patternParts = pattern.trim().split(/\s+/);

    if (patternParts.length === 1) {
      // Single term: match method OR path
      const term = patternParts[0].toLowerCase();
      return method === term || path.includes(term);
    } else {
      // Multiple terms: first is method, rest is path pattern
      const methodPattern = patternParts[0].toLowerCase();
      const pathPattern = patternParts.slice(1).join(' ').toLowerCase();

      // Method must match exactly (GET, POST, etc.)
      const methodMatches = method === methodPattern;
      // Path must contain the pattern
      const pathMatches = path.includes(pathPattern);

      return methodMatches && pathMatches;
    }
  }

  // Default: search name field
  const nodeName = (node.name || '').toLowerCase();
  return nodeName.includes(lowerPattern);
}
```

**Purpose:**
- `grafema query "POST"` - finds all POST endpoints
- `grafema query "/api"` - finds routes containing /api in path
- `grafema query "GET /users"` - finds GET routes with /users in path

---

#### Change 5: Update `NodeInfo` Interface (Lines 26-33)

**Current Code:**
```typescript
interface NodeInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
  [key: string]: unknown;
}
```

**New Code:**
```typescript
interface NodeInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
  method?: string;  // For http:route
  path?: string;    // For http:route
  [key: string]: unknown;
}
```

---

#### Change 6: Update `displayNode()` for HTTP Routes (Lines 395-397)

**Current Code (Lines 395-397):**
```typescript
function displayNode(node: NodeInfo, projectPath: string): void {
  console.log(formatNodeDisplay(node, { projectPath }));
}
```

**New Code:**
```typescript
function displayNode(node: NodeInfo, projectPath: string): void {
  // Special formatting for HTTP routes
  if (node.type === 'http:route' && node.method && node.path) {
    console.log(formatHttpRouteDisplay(node, projectPath));
    return;
  }
  console.log(formatNodeDisplay(node, { projectPath }));
}

/**
 * Format HTTP route for display
 *
 * Output:
 *   [http:route] POST /api/users
 *     Location: src/routes/users.js:15
 */
function formatHttpRouteDisplay(node: NodeInfo, projectPath: string): string {
  const { relative } = require('path');
  const lines: string[] = [];

  // Line 1: [type] METHOD PATH
  lines.push(`[${node.type}] ${node.method} ${node.path}`);

  // Line 2: Location
  if (node.file) {
    const relPath = relative(projectPath, node.file);
    const loc = node.line ? `${relPath}:${node.line}` : relPath;
    lines.push(`  Location: ${loc}`);
  }

  return lines.join('\n');
}
```

**Purpose:** Display HTTP routes as `[http:route] POST /api/users` instead of showing the semantic ID.

---

### File: `/packages/cli/src/utils/formatNode.ts`

No changes required. The special HTTP route formatting is handled in `query.ts` directly because it's specific to the query command display. `formatNodeDisplay` remains the default formatter for other node types.

---

## Test Plan

### New Test File: `/packages/cli/test/query.test.ts`

Create comprehensive tests for HTTP route searching:

```typescript
/**
 * Tests for grafema query command - REG-207
 *
 * Tests HTTP route searching functionality:
 * - Type aliases (route, endpoint, http)
 * - Method matching (GET, POST, etc.)
 * - Path matching (/api/users, etc.)
 * - Combined method+path matching
 * - Display formatting
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, '../dist/cli.js');

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

describe('grafema query - HTTP routes', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-query-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function setupExpressProject(): Promise<void> {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    // Create Express app with routes
    writeFileSync(
      join(srcDir, 'app.js'),
      `
const express = require('express');
const app = express();

app.get('/api/users', (req, res) => {
  res.json([]);
});

app.post('/api/users', (req, res) => {
  res.json({ created: true });
});

app.get('/api/posts', (req, res) => {
  res.json([]);
});

app.delete('/api/users/:id', (req, res) => {
  res.json({ deleted: true });
});

module.exports = app;
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-express', version: '1.0.0', main: 'src/app.js' })
    );

    // Init and analyze
    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

    const analyzeResult = runCli(['analyze'], tempDir);
    assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
  }

  // Test: Type aliases work
  describe('type aliases', () => {
    it('should find routes with "route" alias', async () => {
      await setupExpressProject();
      const result = runCli(['query', 'route /api'], tempDir);
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('/api'), 'Should find routes');
    });

    it('should find routes with "endpoint" alias', async () => {
      await setupExpressProject();
      const result = runCli(['query', 'endpoint /api'], tempDir);
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('/api'), 'Should find routes');
    });

    it('should find routes with "http" alias', async () => {
      await setupExpressProject();
      const result = runCli(['query', 'http /users'], tempDir);
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('/users'), 'Should find routes');
    });
  });

  // Test: Method matching
  describe('method matching', () => {
    it('should find all POST endpoints', async () => {
      await setupExpressProject();
      const result = runCli(['query', 'POST'], tempDir);
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('POST'), 'Should find POST routes');
      assert.ok(!result.stdout.includes('GET /api/users'), 'Should not include GET routes');
    });

    it('should find all GET endpoints', async () => {
      await setupExpressProject();
      const result = runCli(['query', 'GET'], tempDir);
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('GET'), 'Should find GET routes');
    });

    it('should find DELETE endpoints', async () => {
      await setupExpressProject();
      const result = runCli(['query', 'DELETE'], tempDir);
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('DELETE'), 'Should find DELETE routes');
    });
  });

  // Test: Path matching
  describe('path matching', () => {
    it('should find routes by partial path', async () => {
      await setupExpressProject();
      const result = runCli(['query', '/users'], tempDir);
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('/users'), 'Should find /users routes');
    });

    it('should find routes by path prefix', async () => {
      await setupExpressProject();
      const result = runCli(['query', '/api'], tempDir);
      assert.strictEqual(result.status, 0);
      // Should find multiple routes under /api
      const matches = result.stdout.match(/\[http:route\]/g);
      assert.ok(matches && matches.length >= 2, 'Should find multiple /api routes');
    });
  });

  // Test: Combined method + path
  describe('combined method and path', () => {
    it('should find specific method+path combination', async () => {
      await setupExpressProject();
      const result = runCli(['query', 'GET /api/users'], tempDir);
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('GET'), 'Should show GET method');
      assert.ok(result.stdout.includes('/api/users'), 'Should show /api/users path');
      // Should NOT include POST /api/users
      const lines = result.stdout.split('\n');
      const routeLines = lines.filter(l => l.includes('[http:route]'));
      assert.strictEqual(routeLines.length, 1, 'Should find exactly one matching route');
    });

    it('should find POST /api/users specifically', async () => {
      await setupExpressProject();
      const result = runCli(['query', 'POST /api/users'], tempDir);
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('POST'), 'Should show POST method');
      assert.ok(result.stdout.includes('/api/users'), 'Should show path');
    });
  });

  // Test: Display formatting
  describe('display formatting', () => {
    it('should display routes as [http:route] METHOD PATH', async () => {
      await setupExpressProject();
      const result = runCli(['query', 'route /api/users'], tempDir);
      assert.strictEqual(result.status, 0);
      // Check format: [http:route] GET /api/users
      assert.ok(
        result.stdout.includes('[http:route] GET /api/users') ||
        result.stdout.includes('[http:route] POST /api/users'),
        'Should display as [http:route] METHOD PATH'
      );
    });

    it('should include location in route display', async () => {
      await setupExpressProject();
      const result = runCli(['query', 'route /api/users'], tempDir);
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('Location:'), 'Should show location');
      assert.ok(result.stdout.includes('src/app.js'), 'Should show file path');
    });
  });

  // Test: JSON output includes method and path
  describe('JSON output', () => {
    it('should include method and path in JSON output', async () => {
      await setupExpressProject();
      const result = runCli(['query', 'route /api/users', '--json'], tempDir);
      assert.strictEqual(result.status, 0);

      // Find JSON array in output
      const jsonStart = result.stdout.indexOf('[');
      const jsonEnd = result.stdout.lastIndexOf(']');
      assert.ok(jsonStart !== -1 && jsonEnd > jsonStart, 'Should have JSON array');

      const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
      assert.ok(Array.isArray(parsed), 'Should be array');
      assert.ok(parsed.length > 0, 'Should have results');

      const route = parsed[0];
      assert.ok(route.method, 'Should have method field');
      assert.ok(route.path, 'Should have path field');
      assert.ok(['GET', 'POST', 'DELETE'].includes(route.method), 'Method should be HTTP method');
    });
  });

  // Test: No results case
  describe('no results', () => {
    it('should handle no matching routes gracefully', async () => {
      await setupExpressProject();
      const result = runCli(['query', 'PUT /nonexistent'], tempDir);
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('No results'), 'Should show no results message');
    });
  });

  // Test: Routes included in general search
  describe('general search includes routes', () => {
    it('should find routes when searching without type', async () => {
      await setupExpressProject();
      const result = runCli(['query', '/api'], tempDir);
      assert.strictEqual(result.status, 0);
      // Should find http:route nodes
      assert.ok(result.stdout.includes('http:route'), 'Should find HTTP routes in general search');
    });
  });
});
```

### Test Execution Order

1. Run unit tests for `matchesSearchPattern()` helper
2. Run integration tests with Express fixture
3. Run E2E tests verifying the full flow

### Edge Cases to Cover

| Case | Expected Behavior |
|------|-------------------|
| `grafema query "POST"` | Find all POST endpoints |
| `grafema query "post"` | Case-insensitive, find POST endpoints |
| `grafema query "/api"` | Find all routes with /api in path |
| `grafema query "GET /api"` | Find only GET routes under /api |
| `grafema query "route /users"` | Type alias works |
| `grafema query "endpoint POST"` | Find POST endpoints (order doesn't matter for type alias) |
| `grafema query "authenticate"` | Still finds functions, not routes |
| Empty database | "No results" message |
| No HTTP routes in project | "No results" for route queries, still finds functions |

---

## Implementation Order

1. **Tests First (TDD):**
   - Create `/packages/cli/test/query.test.ts`
   - Write all test cases marked as pending
   - Verify tests fail (no implementation yet)

2. **Add Type Aliases (Change 1):**
   - Update `parsePattern()` with route/endpoint/http aliases
   - Tests for type aliases should now pass

3. **Add http:route to Search Types (Change 2):**
   - Update `findNodes()` searchTypes array
   - General search tests should now find routes

4. **Implement Field Matching (Changes 3, 4):**
   - Add `matchesSearchPattern()` helper
   - Update `findNodes()` to use new helper
   - Method/path matching tests should pass

5. **Update NodeInfo Interface (Change 5):**
   - Add method/path fields
   - JSON output tests should pass

6. **Implement Route Display (Change 6):**
   - Add `formatHttpRouteDisplay()` function
   - Update `displayNode()` to use it
   - Display formatting tests should pass

7. **Final Integration:**
   - Run full test suite
   - Manual verification with real Express project

---

## Acceptance Criteria Verification

| Criterion | Implementation |
|-----------|----------------|
| `grafema query "POST"` returns all POST endpoints | `matchesSearchPattern()` matches method |
| `grafema query "GET /api"` returns matching endpoints | Combined method+path matching |
| `grafema query "route /api"` works | Type alias 'route' -> 'http:route' |
| `grafema query "/api/users"` finds routes | Path-only matching in `matchesSearchPattern()` |
| Results display method + path prominently | `formatHttpRouteDisplay()` shows `[http:route] METHOD PATH` |

---

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Performance: Adding http:route to default search | RFDBServerBackend uses indexed queries by nodeType, should be fast |
| Conflict: "POST" might match function named "postMessage" | HTTP routes are searched with exact method match, functions with substring match - different behaviors per type |
| Breaking change: New results in general search | This is a fix, not breaking - previous behavior returned empty for routes |

---

## Effort Estimate

| Task | Time |
|------|------|
| Write tests | 1 hour |
| Type aliases | 15 min |
| Search types | 5 min |
| Field matching | 30 min |
| Display formatting | 30 min |
| Integration testing | 45 min |
| **Total** | ~3.5 hours |

---

## Dependencies

- ExpressAnalyzer creates `http:route` nodes with `method` and `path` properties (verified)
- RFDBServerBackend supports `queryNodes({ nodeType: 'http:route' })` (verified via overview.ts)
- No storage layer changes needed

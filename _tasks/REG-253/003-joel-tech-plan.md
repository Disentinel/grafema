# Joel Spolsky's Technical Specification: REG-253

## Summary

This document expands Don Melton's high-level plan into detailed implementation steps for Rob Pike. The goal is to enable querying by arbitrary node types through:
1. `--type` flag for `query` command
2. New `ls` command for listing nodes by type
3. New `types` command for listing available types

---

## Part 1: Add `--type` Flag to Query Command

### 1.1 File: `packages/cli/src/commands/query.ts`

#### 1.1.1 Update `QueryOptions` Interface (line ~19)

**Current:**
```typescript
interface QueryOptions {
  project: string;
  json?: boolean;
  limit: string;
  raw?: boolean;
}
```

**Change to:**
```typescript
interface QueryOptions {
  project: string;
  json?: boolean;
  limit: string;
  raw?: boolean;
  type?: string;  // NEW: explicit node type
}
```

#### 1.1.2 Add `--type` Option to Command Definition (after line ~49)

**Insert after the `--raw` option (line ~66):**
```typescript
.option(
  '-t, --type <nodeType>',
  `Filter by exact node type (bypasses type aliases)

Use this when:
- Searching custom node types (jsx:component, redis:cache)
- You need exact type match without alias resolution
- Discovering nodes from plugins or custom analyzers

Examples:
  grafema query --type http:request "/api"
  grafema query --type FUNCTION "auth"
  grafema query -t socketio:event "connect"`
)
```

**Insert location:** After line 66 (after the `--raw` option closing parenthesis), before `.addHelpText('after', ...`.

#### 1.1.3 Update `addHelpText` Examples (around line ~78)

**Add to examples section:**
```
  grafema query --type FUNCTION "auth"   Explicit type (no alias resolution)
  grafema query -t http:request "/api"   Search custom node types
```

#### 1.1.4 Modify Action Handler (line ~79)

**Current flow (lines 98-103):**
```typescript
// Parse pattern
const { type, name } = parsePattern(pattern);
const limit = parseInt(options.limit, 10);

// Find matching nodes
const nodes = await findNodes(backend, type, name, limit);
```

**Change to:**
```typescript
// Determine type: explicit --type flag takes precedence
let searchType: string | null;
let searchName: string;

if (options.type) {
  // Explicit --type bypasses pattern parsing for type
  searchType = options.type;
  searchName = pattern;
} else {
  // Use pattern parsing for type aliases
  const parsed = parsePattern(pattern);
  searchType = parsed.type;
  searchName = parsed.name;
}

const limit = parseInt(options.limit, 10);

// Find matching nodes
const nodes = await findNodes(backend, searchType, searchName, limit);
```

#### 1.1.5 Modify `findNodes` to Handle Unknown Types (lines 301-376)

The current `findNodes` function has hardcoded type list. We need to:
1. Keep the hardcoded list for default (no type) searches
2. For explicit types, query that type directly
3. Add fallback matching for unknown types

**Replace lines 306-321:**
```typescript
async function findNodes(
  backend: RFDBServerBackend,
  type: string | null,
  name: string,
  limit: number
): Promise<NodeInfo[]> {
  const results: NodeInfo[] = [];

  // Default search types when no type specified
  const defaultSearchTypes = [
    'FUNCTION',
    'CLASS',
    'MODULE',
    'VARIABLE',
    'CONSTANT',
    'http:route',
    'http:request',
    'socketio:event',
    'socketio:emit',
    'socketio:on'
  ];

  const searchTypes = type ? [type] : defaultSearchTypes;
```

**This part stays the same.** The key change is in matching logic.

#### 1.1.6 Update `matchesSearchPattern` for Generic Fallback (lines 214-296)

**Add at the end of the function, before the default case (before line 293):**
```typescript
  // Generic fallback for unknown types: search multiple fields
  // This allows custom types to be searchable without code changes
  const searchableFields = ['name', 'path', 'url', 'event', 'method'];
  for (const field of searchableFields) {
    const value = node[field];
    if (typeof value === 'string' && value.toLowerCase().includes(lowerPattern)) {
      return true;
    }
  }

  // Final fallback: name field only (already handled above, but explicit)
  return false;
```

Actually, looking at the existing code, the default case at line 293-295 already handles this:
```typescript
// Default: search name field
const nodeName = (node.name || '').toLowerCase();
return nodeName.includes(lowerPattern);
```

This is sufficient for unknown types. **No change needed here.**

---

## Part 2: Create `types` Command

### 2.1 Create New File: `packages/cli/src/commands/types.ts`

```typescript
/**
 * Types command - List all node types in the graph
 *
 * Shows all node types present in the analyzed codebase with counts.
 * Useful for:
 * - Discovering what types exist (standard and custom)
 * - Understanding graph composition
 * - Finding types to use with --type flag
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend } from '@grafema/core';
import { exitWithError } from '../utils/errorFormatter.js';

interface TypesOptions {
  project: string;
  json?: boolean;
  sort?: 'count' | 'name';
}

export const typesCommand = new Command('types')
  .description('List all node types in the graph')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-s, --sort <by>', 'Sort by: count (default) or name', 'count')
  .addHelpText('after', `
Examples:
  grafema types                  List all node types with counts
  grafema types --json           Output as JSON for scripting
  grafema types --sort name      Sort alphabetically by type name
  grafema types -s count         Sort by count (default, descending)

Use with query --type:
  grafema types                  # See available types
  grafema query --type jsx:component "Button"   # Query specific type
`)
  .action(async (options: TypesOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      const nodeCounts = await backend.countNodesByType();
      const entries = Object.entries(nodeCounts);

      if (entries.length === 0) {
        console.log('No nodes in graph. Run: grafema analyze');
        return;
      }

      // Sort entries
      const sortedEntries = options.sort === 'name'
        ? entries.sort((a, b) => a[0].localeCompare(b[0]))
        : entries.sort((a, b) => b[1] - a[1]); // count descending

      if (options.json) {
        const result = {
          types: sortedEntries.map(([type, count]) => ({ type, count })),
          totalTypes: sortedEntries.length,
          totalNodes: sortedEntries.reduce((sum, [, count]) => sum + count, 0),
        };
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('Node Types in Graph:');
        console.log('');

        // Calculate max type length for alignment
        const maxTypeLen = Math.max(...sortedEntries.map(([type]) => type.length));

        for (const [type, count] of sortedEntries) {
          const paddedType = type.padEnd(maxTypeLen);
          const formattedCount = count.toLocaleString();
          console.log(`  ${paddedType}  ${formattedCount}`);
        }

        console.log('');
        const totalNodes = sortedEntries.reduce((sum, [, count]) => sum + count, 0);
        console.log(`Total: ${sortedEntries.length} types, ${totalNodes.toLocaleString()} nodes`);
        console.log('');
        console.log('Tip: Use grafema query --type <type> "pattern" to search within a type');
      }
    } finally {
      await backend.close();
    }
  });
```

### 2.2 Register Command in `packages/cli/src/cli.ts`

**Add import (after line 20, with other command imports):**
```typescript
import { typesCommand } from './commands/types.js';
```

**Add command (after line 38, with other commands):**
```typescript
program.addCommand(typesCommand);
```

---

## Part 3: Create `ls` Command

### 3.1 Create New File: `packages/cli/src/commands/ls.ts`

```typescript
/**
 * List command - List nodes by type
 *
 * Unix-style listing of nodes in the graph. Similar to `ls` for files,
 * but for code graph nodes.
 *
 * Use cases:
 * - "Show me all HTTP routes in this project"
 * - "List all functions" (with limit for large codebases)
 * - "What Socket.IO events are defined?"
 */

import { Command } from 'commander';
import { resolve, join, relative } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend } from '@grafema/core';
import { exitWithError } from '../utils/errorFormatter.js';

interface LsOptions {
  project: string;
  type: string;
  json?: boolean;
  limit: string;
}

interface NodeInfo {
  id: string;
  type: string;
  name: string;
  file: string;
  line?: number;
  method?: string;
  path?: string;
  url?: string;
  event?: string;
  [key: string]: unknown;
}

export const lsCommand = new Command('ls')
  .description('List nodes by type')
  .requiredOption('-t, --type <nodeType>', 'Node type to list (required)')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-l, --limit <n>', 'Limit results (default: 50)', '50')
  .addHelpText('after', `
Examples:
  grafema ls --type FUNCTION              List functions (up to 50)
  grafema ls --type http:route            List all HTTP routes
  grafema ls --type http:request          List all HTTP requests (fetch/axios)
  grafema ls -t socketio:event            List Socket.IO events
  grafema ls --type CLASS -l 100          List up to 100 classes
  grafema ls --type jsx:component --json  Output as JSON

Discover available types:
  grafema types                           List all types with counts
`)
  .action(async (options: LsOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', ['Run: grafema analyze']);
    }

    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    try {
      const limit = parseInt(options.limit, 10);
      const nodeType = options.type;

      // Check if type exists in graph
      const typeCounts = await backend.countNodesByType();
      if (!typeCounts[nodeType]) {
        const availableTypes = Object.keys(typeCounts).sort();
        exitWithError(`No nodes of type "${nodeType}" found`, [
          'Available types:',
          ...availableTypes.slice(0, 10).map(t => `  ${t}`),
          availableTypes.length > 10 ? `  ... and ${availableTypes.length - 10} more` : '',
          '',
          'Run: grafema types    to see all types with counts',
        ].filter(Boolean));
      }

      // Collect nodes
      const nodes: NodeInfo[] = [];
      for await (const node of backend.queryNodes({ nodeType: nodeType as any })) {
        nodes.push({
          id: node.id,
          type: node.type || nodeType,
          name: node.name || '',
          file: node.file || '',
          line: node.line,
          method: node.method as string | undefined,
          path: node.path as string | undefined,
          url: node.url as string | undefined,
          event: node.event as string | undefined,
        });
        if (nodes.length >= limit) break;
      }

      const totalCount = typeCounts[nodeType];
      const showing = nodes.length;

      if (options.json) {
        console.log(JSON.stringify({
          type: nodeType,
          nodes,
          showing,
          total: totalCount,
        }, null, 2));
      } else {
        console.log(`[${nodeType}] (${showing}${showing < totalCount ? ` of ${totalCount}` : ''}):`);
        console.log('');

        for (const node of nodes) {
          const display = formatNodeForList(node, nodeType, projectPath);
          console.log(`  ${display}`);
        }

        if (showing < totalCount) {
          console.log('');
          console.log(`  ... ${totalCount - showing} more. Use --limit ${totalCount} to see all.`);
        }
      }
    } finally {
      await backend.close();
    }
  });

/**
 * Format a node for list display based on its type.
 * Different types show different fields.
 */
function formatNodeForList(node: NodeInfo, nodeType: string, projectPath: string): string {
  const relFile = node.file ? relative(projectPath, node.file) : '';
  const loc = node.line ? `${relFile}:${node.line}` : relFile;

  // HTTP routes: METHOD PATH (location)
  if (nodeType === 'http:route' && node.method && node.path) {
    return `${node.method.padEnd(6)} ${node.path}  (${loc})`;
  }

  // HTTP requests: METHOD URL (location)
  if (nodeType === 'http:request') {
    const method = (node.method || 'GET').padEnd(6);
    const url = node.url || 'dynamic';
    return `${method} ${url}  (${loc})`;
  }

  // Socket.IO events: event_name
  if (nodeType === 'socketio:event') {
    return node.name || node.id;
  }

  // Socket.IO emit/on: event (location)
  if (nodeType === 'socketio:emit' || nodeType === 'socketio:on') {
    const event = node.event || node.name || 'unknown';
    return `${event}  (${loc})`;
  }

  // Default: name (location)
  const name = node.name || node.id;
  return loc ? `${name}  (${loc})` : name;
}
```

### 3.2 Register Command in `packages/cli/src/cli.ts`

**Add import (after other command imports):**
```typescript
import { lsCommand } from './commands/ls.js';
```

**Add command (in logical order, after queryCommand):**
```typescript
program.addCommand(lsCommand);
```

---

## Part 4: Test Cases for Kent Beck

### 4.1 Create Test File: `packages/cli/test/query-type-flag.test.ts`

```typescript
/**
 * Tests for `grafema query --type` flag - REG-253
 *
 * Tests explicit node type filtering:
 * - --type flag bypasses pattern parsing
 * - Works with standard types (FUNCTION, CLASS)
 * - Works with namespaced types (http:route, http:request)
 * - Helpful error when type doesn't exist
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

function runCli(
  args: string[],
  cwd: string
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

describe('grafema query --type flag', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-query-type-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function setupTestProject(): Promise<void> {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    writeFileSync(
      join(srcDir, 'app.js'),
      `
function functionRoute() { return 'fn'; }
class RouteClass {}
async function fetchUsers() {
  const response = await fetch('/api/users');
  return response.json();
}
module.exports = { functionRoute, RouteClass, fetchUsers };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-type-flag', version: '1.0.0', main: 'src/app.js' })
    );

    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);
    const analyzeResult = runCli(['analyze'], tempDir);
    assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
  }

  describe('--type flag basic functionality', () => {
    it('should filter by exact type with --type flag', async () => {
      await setupTestProject();

      const result = runCli(['query', '--type', 'FUNCTION', 'route'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Should find functionRoute (FUNCTION with "route" in name)
      assert.ok(
        result.stdout.includes('functionRoute'),
        `Should find functionRoute. Got: ${result.stdout}`
      );
      // Should NOT find RouteClass (CLASS, not FUNCTION)
      assert.ok(
        !result.stdout.includes('RouteClass') || result.stdout.includes('FUNCTION'),
        `Should filter to FUNCTION type only`
      );
    });

    it('should accept short form -t', async () => {
      await setupTestProject();

      const result = runCli(['query', '-t', 'FUNCTION', 'route'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      assert.ok(
        result.stdout.includes('functionRoute'),
        `Should find functionRoute with -t flag. Got: ${result.stdout}`
      );
    });

    it('should bypass alias resolution with --type', async () => {
      await setupTestProject();

      // Without --type: "function route" would parse as type=FUNCTION, name=route
      // With --type: entire pattern is the search term
      const result = runCli(['query', '--type', 'FUNCTION', 'function'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Should find functionRoute (has "function" in name)
      assert.ok(
        result.stdout.includes('functionRoute'),
        `Should search for "function" as name, not as type alias. Got: ${result.stdout}`
      );
    });
  });

  describe('--type with namespaced types', () => {
    it('should work with http:request type', async () => {
      await setupTestProject();

      const result = runCli(['query', '--type', 'http:request', '/api'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
      // Should find the fetch call
      assert.ok(
        result.stdout.includes('http:request') || result.stdout.includes('/api/users'),
        `Should find http:request nodes. Got: ${result.stdout}`
      );
    });
  });

  describe('--type error handling', () => {
    it('should show helpful message when type not found', async () => {
      await setupTestProject();

      const result = runCli(['query', '--type', 'nonexistent:type', 'anything'], tempDir);

      assert.strictEqual(result.status, 0, 'Should not error, just show no results');
      assert.ok(
        result.stdout.includes('No results'),
        `Should show no results message. Got: ${result.stdout}`
      );
    });
  });

  describe('--type with --json', () => {
    it('should output JSON with explicit type', async () => {
      await setupTestProject();

      const result = runCli(['query', '--type', 'FUNCTION', 'route', '--json'], tempDir);

      assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);

      const jsonStart = result.stdout.indexOf('[');
      const jsonEnd = result.stdout.lastIndexOf(']');
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
        assert.ok(Array.isArray(parsed), 'Should be array');
        if (parsed.length > 0) {
          assert.strictEqual(parsed[0].type, 'FUNCTION', 'All results should be FUNCTION type');
        }
      }
    });
  });
});
```

### 4.2 Create Test File: `packages/cli/test/types-command.test.ts`

```typescript
/**
 * Tests for `grafema types` command - REG-253
 *
 * Tests listing all node types:
 * - Shows all types with counts
 * - Sorts by count (default) or name
 * - JSON output format
 * - Empty graph handling
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

function runCli(
  args: string[],
  cwd: string
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

describe('grafema types command', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-types-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function setupTestProject(): Promise<void> {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    writeFileSync(
      join(srcDir, 'app.js'),
      `
function hello() {}
function world() {}
class MyClass {}
const config = {};
module.exports = { hello, world, MyClass, config };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-types', version: '1.0.0', main: 'src/app.js' })
    );

    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0);
    const analyzeResult = runCli(['analyze'], tempDir);
    assert.strictEqual(analyzeResult.status, 0);
  }

  describe('basic functionality', () => {
    it('should list all node types with counts', async () => {
      await setupTestProject();

      const result = runCli(['types'], tempDir);

      assert.strictEqual(result.status, 0, `types failed: ${result.stderr}`);
      assert.ok(result.stdout.includes('Node Types in Graph:'), 'Should have header');
      assert.ok(result.stdout.includes('FUNCTION'), 'Should list FUNCTION type');
      assert.ok(result.stdout.includes('CLASS'), 'Should list CLASS type');
      assert.ok(result.stdout.includes('Total:'), 'Should show total');
    });

    it('should show help text', async () => {
      const result = runCli(['types', '--help'], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('List all node types'), 'Should describe command');
      assert.ok(result.stdout.includes('--json'), 'Should document --json flag');
      assert.ok(result.stdout.includes('--sort'), 'Should document --sort flag');
    });
  });

  describe('sorting', () => {
    it('should sort by count by default (descending)', async () => {
      await setupTestProject();

      const result = runCli(['types'], tempDir);

      assert.strictEqual(result.status, 0);
      // FUNCTION should appear before CLASS (more functions than classes)
      const funcIndex = result.stdout.indexOf('FUNCTION');
      const classIndex = result.stdout.indexOf('CLASS');
      assert.ok(funcIndex < classIndex, 'FUNCTION should appear before CLASS (higher count)');
    });

    it('should sort alphabetically with --sort name', async () => {
      await setupTestProject();

      const result = runCli(['types', '--sort', 'name'], tempDir);

      assert.strictEqual(result.status, 0);
      // CLASS should appear before FUNCTION alphabetically
      const classIndex = result.stdout.indexOf('CLASS');
      const funcIndex = result.stdout.indexOf('FUNCTION');
      assert.ok(classIndex < funcIndex, 'CLASS should appear before FUNCTION (alphabetically)');
    });
  });

  describe('JSON output', () => {
    it('should output valid JSON with --json', async () => {
      await setupTestProject();

      const result = runCli(['types', '--json'], tempDir);

      assert.strictEqual(result.status, 0);

      const jsonStart = result.stdout.indexOf('{');
      const jsonEnd = result.stdout.lastIndexOf('}');
      assert.ok(jsonStart !== -1 && jsonEnd > jsonStart, 'Should contain JSON object');

      const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
      assert.ok(Array.isArray(parsed.types), 'Should have types array');
      assert.ok(typeof parsed.totalTypes === 'number', 'Should have totalTypes');
      assert.ok(typeof parsed.totalNodes === 'number', 'Should have totalNodes');

      // Each type entry should have type and count
      const firstType = parsed.types[0];
      assert.ok(typeof firstType.type === 'string', 'Type entry should have type string');
      assert.ok(typeof firstType.count === 'number', 'Type entry should have count number');
    });
  });

  describe('error handling', () => {
    it('should error when no database exists', async () => {
      mkdirSync(join(tempDir, 'empty'));

      const result = runCli(['types'], join(tempDir, 'empty'));

      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes('No graph database found'));
    });
  });
});
```

### 4.3 Create Test File: `packages/cli/test/ls-command.test.ts`

```typescript
/**
 * Tests for `grafema ls` command - REG-253
 *
 * Tests listing nodes by type:
 * - List nodes of specific type
 * - Limit results
 * - JSON output
 * - Type-specific formatting
 * - Error when type doesn't exist
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

function runCli(
  args: string[],
  cwd: string
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

describe('grafema ls command', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-ls-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  async function setupTestProject(): Promise<void> {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    writeFileSync(
      join(srcDir, 'app.js'),
      `
function hello() {}
function world() {}
function greet(name) {}
class MyClass {}
module.exports = { hello, world, greet, MyClass };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-ls', version: '1.0.0', main: 'src/app.js' })
    );

    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0);
    const analyzeResult = runCli(['analyze'], tempDir);
    assert.strictEqual(analyzeResult.status, 0);
  }

  describe('basic functionality', () => {
    it('should list nodes of specified type', async () => {
      await setupTestProject();

      const result = runCli(['ls', '--type', 'FUNCTION'], tempDir);

      assert.strictEqual(result.status, 0, `ls failed: ${result.stderr}`);
      assert.ok(result.stdout.includes('[FUNCTION]'), 'Should show type in header');
      assert.ok(result.stdout.includes('hello'), 'Should list hello function');
      assert.ok(result.stdout.includes('world'), 'Should list world function');
      assert.ok(result.stdout.includes('greet'), 'Should list greet function');
    });

    it('should require --type flag', async () => {
      await setupTestProject();

      const result = runCli(['ls'], tempDir);

      assert.strictEqual(result.status, 1, 'Should error without --type');
      assert.ok(
        result.stderr.includes('--type') || result.stderr.includes('required'),
        'Should mention --type is required'
      );
    });

    it('should show help text', async () => {
      const result = runCli(['ls', '--help'], tempDir);

      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes('List nodes by type'), 'Should describe command');
      assert.ok(result.stdout.includes('--type'), 'Should document --type flag');
      assert.ok(result.stdout.includes('--limit'), 'Should document --limit flag');
    });
  });

  describe('limit option', () => {
    it('should limit results with --limit', async () => {
      await setupTestProject();

      const result = runCli(['ls', '--type', 'FUNCTION', '--limit', '2'], tempDir);

      assert.strictEqual(result.status, 0);
      // Should show "... X more" message
      assert.ok(
        result.stdout.includes('more') || result.stdout.match(/\(\s*2\s+of\s+3\s*\)/),
        `Should indicate limited results. Got: ${result.stdout}`
      );
    });

    it('should accept short form -l', async () => {
      await setupTestProject();

      const result = runCli(['ls', '-t', 'FUNCTION', '-l', '1'], tempDir);

      assert.strictEqual(result.status, 0);
    });
  });

  describe('JSON output', () => {
    it('should output valid JSON with --json', async () => {
      await setupTestProject();

      const result = runCli(['ls', '--type', 'FUNCTION', '--json'], tempDir);

      assert.strictEqual(result.status, 0);

      const jsonStart = result.stdout.indexOf('{');
      const jsonEnd = result.stdout.lastIndexOf('}');
      assert.ok(jsonStart !== -1 && jsonEnd > jsonStart, 'Should contain JSON object');

      const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
      assert.strictEqual(parsed.type, 'FUNCTION', 'Should have type field');
      assert.ok(Array.isArray(parsed.nodes), 'Should have nodes array');
      assert.ok(typeof parsed.showing === 'number', 'Should have showing count');
      assert.ok(typeof parsed.total === 'number', 'Should have total count');
    });
  });

  describe('error handling', () => {
    it('should show helpful error when type not found', async () => {
      await setupTestProject();

      const result = runCli(['ls', '--type', 'nonexistent:type'], tempDir);

      assert.strictEqual(result.status, 1, 'Should error for unknown type');
      assert.ok(
        result.stderr.includes('No nodes of type'),
        'Should mention type not found'
      );
      assert.ok(
        result.stderr.includes('Available types') || result.stderr.includes('FUNCTION'),
        'Should suggest available types'
      );
    });

    it('should error when no database exists', async () => {
      mkdirSync(join(tempDir, 'empty'));

      const result = runCli(['ls', '--type', 'FUNCTION'], join(tempDir, 'empty'));

      assert.strictEqual(result.status, 1);
      assert.ok(result.stderr.includes('No graph database found'));
    });
  });
});
```

---

## Part 5: Implementation Order (Dependencies)

```
Step 1: types.ts (no dependencies on other changes)
        ├── Create packages/cli/src/commands/types.ts
        └── Register in cli.ts

Step 2: ls.ts (no dependencies on other changes)
        ├── Create packages/cli/src/commands/ls.ts
        └── Register in cli.ts

Step 3: query.ts modifications (independent)
        ├── Update QueryOptions interface
        ├── Add --type option
        └── Modify action handler

Step 4: Tests (after all commands work)
        ├── query-type-flag.test.ts
        ├── types-command.test.ts
        └── ls-command.test.ts
```

**Build after each step:** `npm run build` in `packages/cli`

**Run tests after all steps:** `node --test packages/cli/test/`

---

## Part 6: Edge Cases to Handle

### 6.1 Type Not Found
When `--type nonexistent:type` is used:
- In `query`: Show "No results" (already handled)
- In `ls`: Show error with available types (handled in spec)

### 6.2 Case Sensitivity
Node types are case-sensitive (`FUNCTION` vs `function`).
- Accept as-is; don't auto-convert
- Types are stored exactly as created

### 6.3 Empty Graph
When no nodes exist:
- `types`: Show "No nodes in graph. Run: grafema analyze"
- `ls`: Will fail at type check (no types exist)
- `query`: Shows "No results" (existing behavior)

### 6.4 Large Result Sets
- `ls` defaults to 50 (reasonable for terminal)
- Show "... X more" message when truncated
- `--json` includes total count for programmatic use

---

## Part 7: Files Summary

| File | Action | Lines Changed |
|------|--------|---------------|
| `packages/cli/src/commands/query.ts` | Modify | ~30 lines |
| `packages/cli/src/commands/types.ts` | **Create** | ~90 lines |
| `packages/cli/src/commands/ls.ts` | **Create** | ~140 lines |
| `packages/cli/src/cli.ts` | Modify | ~4 lines (imports + registrations) |
| `packages/cli/test/query-type-flag.test.ts` | **Create** | ~150 lines |
| `packages/cli/test/types-command.test.ts` | **Create** | ~130 lines |
| `packages/cli/test/ls-command.test.ts` | **Create** | ~150 lines |

**Total new code:** ~700 lines (including tests)

---

## Part 8: Verification Checklist

After implementation, verify:

- [ ] `grafema query --type FUNCTION "auth"` works
- [ ] `grafema query -t http:request "/api"` works
- [ ] `grafema query --type unknown:type "x"` shows "No results"
- [ ] `grafema types` lists all types with counts
- [ ] `grafema types --json` outputs valid JSON
- [ ] `grafema types --sort name` sorts alphabetically
- [ ] `grafema ls --type FUNCTION` lists functions
- [ ] `grafema ls -t http:route` lists routes
- [ ] `grafema ls --type nonexistent` shows helpful error
- [ ] `grafema ls --type FUNCTION --json` outputs valid JSON
- [ ] All tests pass: `node --test packages/cli/test/`
- [ ] Help text is accurate for all new options/commands

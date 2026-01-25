# REG-179: Query by Semantic ID - Technical Specification

**Date:** 2025-01-24
**Author:** Joel Spolsky (Implementation Planner)
**Based on:** Don Melton's analysis (002-don-plan.md)

## Executive Summary

Implementation of `grafema get <semantic-id>` command to enable direct node lookup by semantic ID. This is a straightforward feature addition with no architectural complexity - we're simply exposing existing backend capability through the CLI.

**Complexity:** Low (3/10)
**Risk:** Low
**Estimated time:** 2-3 hours

## Architecture Decision

**Choice:** New `grafema get` command

**Rationale:**
- `query` = search by pattern (O(n) scan)
- `get` = direct lookup (O(1) hash)
- Different purposes, different performance profiles
- Clear separation of concerns

## File Structure

```
packages/cli/src/commands/get.ts         [NEW] - Command implementation
packages/cli/src/cli.ts                  [MODIFY] - Register command
test/unit/commands/get.test.js           [NEW] - Unit tests
test/integration/cli-get-command.test.js [NEW] - Integration tests
```

## Detailed Specification

### 1. Command Interface

**File:** `packages/cli/src/commands/get.ts`

```typescript
/**
 * Get command - Retrieve node by exact semantic ID
 *
 * Usage:
 *   grafema get "file.js->scope->TYPE->name"
 *   grafema get "file.js->scope->TYPE->name" --json
 */

import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend } from '@grafema/core';
import { formatNodeDisplay } from '../utils/formatNode.js';
import { exitWithError } from '../utils/errorFormatter.js';

interface GetOptions {
  project: string;
  json?: boolean;
}

export const getCommand = new Command('get')
  .description('Get a node by exact semantic ID')
  .argument('<id>', 'Semantic ID (e.g., "file.js->Scope->TYPE->name")')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .action(async (semanticId: string, options: GetOptions) => {
    // Implementation details below
  });
```

**Command registration in `packages/cli/src/cli.ts`:**

```diff
 import { queryCommand } from './commands/query.js';
 import { traceCommand } from './commands/trace.js';
+import { getCommand } from './commands/get.js';
 import { impactCommand } from './commands/impact.js';

 program.addCommand(overviewCommand);
 program.addCommand(queryCommand);
 program.addCommand(traceCommand);
+program.addCommand(getCommand);
 program.addCommand(impactCommand);
```

**Position in CLI help:** After `trace`, before `impact`. Logical flow: `query` (search) → `get` (retrieve) → `trace` (analyze flows) → `impact` (analyze dependencies).

Wait, I see trace comes before get in the original structure. Let me check Don's plan again for the right position... Actually, looking at cli.ts, the order is: overview, query, trace, impact, explore, stats, check. 

The logical position for `get` is after `query` but it could also go after `trace` since trace shows semantic IDs. Let me put it after `query` since both are about finding/retrieving nodes, while trace is about analyzing data flow.

### 2. Implementation Logic

```typescript
async function executeGet(
  semanticId: string,
  options: GetOptions
): Promise<void> {
  // Step 1: Validate inputs
  const projectPath = resolve(options.project);
  const grafemaDir = join(projectPath, '.grafema');
  const dbPath = join(grafemaDir, 'graph.rfdb');

  if (!existsSync(dbPath)) {
    exitWithError('No graph database found', ['Run: grafema analyze']);
  }

  // Step 2: Connect to backend
  const backend = new RFDBServerBackend({ dbPath });
  await backend.connect();

  try {
    // Step 3: Fetch node
    const node = await backend.getNode(semanticId);

    if (!node) {
      exitWithError(
        `Node not found: ${semanticId}`,
        [
          'Check the semantic ID is correct',
          'Try: grafema query "<name>" to search for nodes'
        ]
      );
    }

    // Step 4: Fetch edges
    const [incomingEdges, outgoingEdges] = await Promise.all([
      backend.getIncomingEdges(semanticId, null),
      backend.getOutgoingEdges(semanticId, null)
    ]);

    // Step 5: Format and display
    if (options.json) {
      await displayJSON(node, incomingEdges, outgoingEdges);
    } else {
      await displayText(node, incomingEdges, outgoingEdges, projectPath, backend);
    }

  } finally {
    await backend.close();
  }
}
```

### 3. Output Formats

#### Text Output (default)

```typescript
async function displayText(
  node: BackendNode,
  incomingEdges: BackendEdge[],
  outgoingEdges: BackendEdge[],
  projectPath: string,
  backend: RFDBServerBackend
): Promise<void> {
  // Node details (using existing formatNodeDisplay)
  console.log(formatNodeDisplay(node, { projectPath }));

  // Metadata (if present and non-empty)
  const metadata = extractMetadata(node);
  if (Object.keys(metadata).length > 0) {
    console.log('');
    console.log('Metadata:');
    for (const [key, value] of Object.entries(metadata)) {
      console.log(`  ${key}: ${formatMetadataValue(value)}`);
    }
  }

  // Incoming edges (limit to 20, sorted by type)
  if (incomingEdges.length > 0) {
    console.log('');
    console.log(`Incoming edges (${incomingEdges.length}):`);
    const grouped = groupEdgesByType(incomingEdges);
    let displayed = 0;
    for (const [edgeType, edges] of grouped.entries()) {
      if (displayed >= 20) {
        console.log(`  ... and ${incomingEdges.length - displayed} more`);
        break;
      }
      for (const edge of edges.slice(0, 20 - displayed)) {
        const srcNode = await backend.getNode(edge.src);
        const srcDisplay = srcNode 
          ? `${srcNode.type}#${srcNode.name}`
          : edge.src;
        console.log(`  <- ${edgeType}: ${srcDisplay}`);
        displayed++;
      }
    }
  }

  // Outgoing edges (limit to 20, sorted by type)
  if (outgoingEdges.length > 0) {
    console.log('');
    console.log(`Outgoing edges (${outgoingEdges.length}):`);
    const grouped = groupEdgesByType(outgoingEdges);
    let displayed = 0;
    for (const [edgeType, edges] of grouped.entries()) {
      if (displayed >= 20) {
        console.log(`  ... and ${outgoingEdges.length - displayed} more`);
        break;
      }
      for (const edge of edges.slice(0, 20 - displayed)) {
        const dstNode = await backend.getNode(edge.dst);
        const dstDisplay = dstNode 
          ? `${dstNode.type}#${dstNode.name}`
          : edge.dst;
        console.log(`  -> ${edgeType}: ${dstDisplay}`);
        displayed++;
      }
    }
  }

  // If no edges at all
  if (incomingEdges.length === 0 && outgoingEdges.length === 0) {
    console.log('');
    console.log('No edges found for this node.');
  }
}
```

**Helper functions:**

```typescript
/**
 * Extract metadata from node (exclude standard fields)
 */
function extractMetadata(node: BackendNode): Record<string, unknown> {
  const standardFields = new Set([
    'id', 'type', 'nodeType', 'name', 'file', 'line', 'exported'
  ]);
  
  const metadata: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (!standardFields.has(key) && value !== undefined) {
      metadata[key] = value;
    }
  }
  return metadata;
}

/**
 * Format metadata value for display
 */
function formatMetadataValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.length <= 3) return JSON.stringify(value);
    return `[${value.length} items]`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    if (keys.length <= 3) return JSON.stringify(value);
    return `{${keys.length} keys}`;
  }
  return JSON.stringify(value);
}

/**
 * Group edges by type and sort by type name
 */
function groupEdgesByType(edges: BackendEdge[]): Map<string, BackendEdge[]> {
  const groups = new Map<string, BackendEdge[]>();
  
  for (const edge of edges) {
    const type = edge.edgeType || edge.type;
    if (!groups.has(type)) {
      groups.set(type, []);
    }
    groups.get(type)!.push(edge);
  }
  
  // Sort groups by type name
  return new Map([...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}
```

#### JSON Output

```typescript
async function displayJSON(
  node: BackendNode,
  incomingEdges: BackendEdge[],
  outgoingEdges: BackendEdge[]
): Promise<void> {
  const output = {
    node: {
      id: node.id,
      type: node.type,
      name: node.name,
      file: node.file,
      line: node.line,
      exported: node.exported,
      metadata: extractMetadata(node)
    },
    edges: {
      incoming: incomingEdges.map(e => ({
        src: e.src,
        type: e.edgeType || e.type,
      })),
      outgoing: outgoingEdges.map(e => ({
        dst: e.dst,
        type: e.edgeType || e.type,
      }))
    },
    stats: {
      incomingCount: incomingEdges.length,
      outgoingCount: outgoingEdges.length,
    }
  };

  console.log(JSON.stringify(output, null, 2));
}
```

### 4. Error Handling

**Error scenarios and messages:**

| Scenario | Error Message | Next Steps |
|----------|--------------|------------|
| No database | `No graph database found` | `Run: grafema analyze` |
| Node not found | `Node not found: <id>` | `Check the semantic ID is correct`<br>`Try: grafema query "<name>" to search for nodes` |
| Invalid project path | `Project directory not found: <path>` | `Check --project path is correct` |
| Backend connection fails | `Failed to connect to graph database` | `Try: grafema analyze --clear`<br>`If problem persists, report issue` |
| Empty semantic ID | `Semantic ID cannot be empty` | `Usage: grafema get "<id>"` |

**Implementation:**

```typescript
// Validate semantic ID is not empty
if (!semanticId || semanticId.trim() === '') {
  exitWithError('Semantic ID cannot be empty', [
    'Usage: grafema get "<id>"',
    'Example: grafema get "file.js->Scope->FUNCTION->name"'
  ]);
}

// Backend connection error handling
try {
  await backend.connect();
} catch (error) {
  exitWithError('Failed to connect to graph database', [
    'Try: grafema analyze --clear',
    'If problem persists, report issue'
  ]);
}
```

### 5. Test Specifications

#### Unit Tests

**File:** `test/unit/commands/get.test.js`

```javascript
/**
 * Unit tests for `grafema get` command
 * 
 * Tests command logic without requiring full analysis pipeline.
 * Uses in-memory mock backend for speed.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { RFDBServerBackend } from '@grafema/core';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('grafema get command', () => {
  let tempDir;
  let backend;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-test-'));
    const dbPath = join(tempDir, 'test.rfdb');
    backend = new RFDBServerBackend({ dbPath });
    await backend.connect();
  });

  afterEach(async () => {
    if (backend) await backend.close();
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  describe('node retrieval', () => {
    it('should retrieve node by semantic ID', async () => {
      // Setup: Add test node
      await backend.addNode({
        id: 'test.js->global->FUNCTION->testFunc',
        nodeType: 'FUNCTION',
        name: 'testFunc',
        file: 'test.js',
        line: 10,
      });
      await backend.flush();

      // Test: Retrieve by ID
      const node = await backend.getNode('test.js->global->FUNCTION->testFunc');

      assert.ok(node, 'Node should be found');
      assert.equal(node.name, 'testFunc');
      assert.equal(node.type, 'FUNCTION');
    });

    it('should return null for non-existent ID', async () => {
      const node = await backend.getNode('nonexistent->ID');
      assert.equal(node, null);
    });

    it('should retrieve node with edges', async () => {
      // Setup: Add nodes and edges
      await backend.addNodes([
        {
          id: 'test.js->global->FUNCTION->caller',
          nodeType: 'FUNCTION',
          name: 'caller',
          file: 'test.js',
        },
        {
          id: 'test.js->global->FUNCTION->callee',
          nodeType: 'FUNCTION',
          name: 'callee',
          file: 'test.js',
        },
      ]);
      await backend.addEdges([
        {
          src: 'test.js->global->FUNCTION->caller',
          dst: 'test.js->global->FUNCTION->callee',
          edgeType: 'CALLS',
        },
      ]);
      await backend.flush();

      // Test: Get edges
      const outgoing = await backend.getOutgoingEdges(
        'test.js->global->FUNCTION->caller',
        null
      );
      const incoming = await backend.getIncomingEdges(
        'test.js->global->FUNCTION->callee',
        null
      );

      assert.equal(outgoing.length, 1);
      assert.equal(outgoing[0].edgeType, 'CALLS');
      assert.equal(incoming.length, 1);
      assert.equal(incoming[0].edgeType, 'CALLS');
    });
  });

  describe('edge grouping', () => {
    it('should group edges by type', async () => {
      // This tests the groupEdgesByType helper
      const edges = [
        { src: 'a', dst: 'b', edgeType: 'CALLS' },
        { src: 'c', dst: 'd', edgeType: 'CALLS' },
        { src: 'e', dst: 'f', edgeType: 'CONTAINS' },
      ];

      // Import helper from implementation
      const { groupEdgesByType } = await import(
        '../../../packages/cli/dist/commands/get.js'
      );
      const grouped = groupEdgesByType(edges);

      assert.equal(grouped.size, 2);
      assert.equal(grouped.get('CALLS').length, 2);
      assert.equal(grouped.get('CONTAINS').length, 1);
    });
  });

  describe('metadata extraction', () => {
    it('should extract non-standard fields as metadata', async () => {
      const node = {
        id: 'test',
        type: 'FUNCTION',
        name: 'test',
        file: 'test.js',
        customField: 'value',
        anotherField: 123,
      };

      const { extractMetadata } = await import(
        '../../../packages/cli/dist/commands/get.js'
      );
      const metadata = extractMetadata(node);

      assert.equal(metadata.customField, 'value');
      assert.equal(metadata.anotherField, 123);
      assert.equal(metadata.id, undefined);
      assert.equal(metadata.type, undefined);
    });
  });
});
```

#### Integration Tests

**File:** `test/integration/cli-get-command.test.js`

```javascript
/**
 * Integration tests for `grafema get` command
 * 
 * Tests the full CLI workflow: analyze → get
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

describe('grafema get (integration)', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-get-test-'));
  });

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  });

  it('should retrieve node by semantic ID after analysis', () => {
    // Setup: Create test file
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(srcDir, 'test.js'),
      `
      function authenticate(username, password) {
        const user = findUser(username);
        return user && verifyPassword(user, password);
      }
      `
    );

    // Run init
    execSync('node packages/cli/dist/cli.js init', {
      cwd: tempDir,
      stdio: 'pipe',
    });

    // Run analyze
    execSync('node packages/cli/dist/cli.js analyze', {
      cwd: tempDir,
      stdio: 'pipe',
    });

    // Get node by ID
    const output = execSync(
      'node packages/cli/dist/cli.js get "src/test.js->global->FUNCTION->authenticate"',
      {
        cwd: tempDir,
        encoding: 'utf-8',
      }
    );

    assert.ok(output.includes('[FUNCTION] authenticate'));
    assert.ok(output.includes('ID: src/test.js->global->FUNCTION->authenticate'));
    assert.ok(output.includes('Location: src/test.js'));
  });

  it('should show edges in output', () => {
    // Setup
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(srcDir, 'test.js'),
      `
      function caller() {
        callee();
      }
      function callee() {}
      `
    );

    execSync('node packages/cli/dist/cli.js init', { cwd: tempDir, stdio: 'pipe' });
    execSync('node packages/cli/dist/cli.js analyze', { cwd: tempDir, stdio: 'pipe' });

    // Get caller function
    const output = execSync(
      'node packages/cli/dist/cli.js get "src/test.js->global->FUNCTION->caller"',
      {
        cwd: tempDir,
        encoding: 'utf-8',
      }
    );

    // Should show outgoing CALLS edge to callee
    assert.ok(output.includes('Outgoing edges'));
    assert.ok(output.includes('CALLS') || output.includes('callee'));
  });

  it('should output JSON when --json flag is used', () => {
    // Setup
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);
    writeFileSync(
      join(srcDir, 'test.js'),
      `function testFunc() {}`
    );

    execSync('node packages/cli/dist/cli.js init', { cwd: tempDir, stdio: 'pipe' });
    execSync('node packages/cli/dist/cli.js analyze', { cwd: tempDir, stdio: 'pipe' });

    // Get with JSON output
    const output = execSync(
      'node packages/cli/dist/cli.js get "src/test.js->global->FUNCTION->testFunc" --json',
      {
        cwd: tempDir,
        encoding: 'utf-8',
      }
    );

    const parsed = JSON.parse(output);
    assert.equal(parsed.node.name, 'testFunc');
    assert.equal(parsed.node.type, 'FUNCTION');
    assert.ok(parsed.edges);
    assert.ok(parsed.stats);
  });

  it('should fail gracefully when node not found', () => {
    // Setup (empty project)
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    execSync('node packages/cli/dist/cli.js init', { cwd: tempDir, stdio: 'pipe' });
    execSync('node packages/cli/dist/cli.js analyze', { cwd: tempDir, stdio: 'pipe' });

    // Try to get non-existent node
    try {
      execSync(
        'node packages/cli/dist/cli.js get "nonexistent->ID"',
        {
          cwd: tempDir,
          stdio: 'pipe',
        }
      );
      assert.fail('Should have thrown error');
    } catch (error) {
      const stderr = error.stderr.toString();
      assert.ok(stderr.includes('Node not found'));
      assert.ok(stderr.includes('grafema query'));
    }
  });

  it('should fail gracefully when database does not exist', () => {
    // Don't run analyze
    try {
      execSync(
        'node packages/cli/dist/cli.js get "some->ID"',
        {
          cwd: tempDir,
          stdio: 'pipe',
        }
      );
      assert.fail('Should have thrown error');
    } catch (error) {
      const stderr = error.stderr.toString();
      assert.ok(stderr.includes('No graph database found'));
      assert.ok(stderr.includes('grafema analyze'));
    }
  });
});
```

### 6. Documentation

**Help text (`grafema get --help`):**

```
Usage: grafema get [options] <id>

Get a node by exact semantic ID

Arguments:
  id                  Semantic ID (e.g., "file.js->Scope->TYPE->name")

Options:
  -p, --project <path>  Project path (default: ".")
  -j, --json           Output as JSON
  -h, --help           display help for command

Examples:
  $ grafema get "src/auth.js->global->FUNCTION->authenticate"
  $ grafema get "config.ts->global->VARIABLE->API_URL" --json
  $ grafema trace "response" | grep "ID:" | awk '{print $2}' | xargs grafema get
```

**README.md section:**

```markdown
### Get Node by ID

Retrieve detailed information about a specific node using its semantic ID.

```bash
# Get node details
grafema get "src/auth.js->AuthService->METHOD->login"

# Output as JSON
grafema get "src/config.ts->global->VARIABLE->API_KEY" --json
```

**Use case:** After finding a node with `grafema trace` or `grafema query`, use `get` to inspect its full details including all incoming and outgoing edges.

**Semantic IDs** are stable identifiers that don't change when you add unrelated code. They follow the format:
```
{file}->{scope_path}->{TYPE}->{name}[#discriminator]
```

Examples:
- `src/app.js->global->FUNCTION->main`
- `auth/service.ts->AuthService->METHOD->login`
- `handlers/user.js->getUser->VARIABLE->userId`
```

### 7. Implementation Order

**Step 1: Create command file**
- File: `packages/cli/src/commands/get.ts`
- Implement basic structure, options parsing
- Implement `executeGet` function
- Implement helper functions (groupEdgesByType, extractMetadata, formatMetadataValue)
- Implement text output (displayText)
- Implement JSON output (displayJSON)
- Implement error handling

**Step 2: Register command**
- File: `packages/cli/src/cli.ts`
- Import getCommand
- Add to program after queryCommand

**Step 3: Build and test manually**
```bash
cd packages/cli
pnpm build
cd ../..
# Create test project, run analyze, then test get command
```

**Step 4: Write unit tests**
- File: `test/unit/commands/get.test.js`
- Test node retrieval
- Test edge fetching
- Test helper functions
- Run: `node --test test/unit/commands/get.test.js`

**Step 5: Write integration tests**
- File: `test/integration/cli-get-command.test.js`
- Test full workflow (analyze → get)
- Test JSON output
- Test error cases
- Run: `node --test test/integration/cli-get-command.test.js`

**Step 6: Update documentation**
- Add help text to command
- Update main README.md
- Add examples to CLAUDE.md if needed

**Step 7: Manual verification**
Use real Grafema project for dogfooding:
```bash
grafema analyze
grafema trace "response"
# Copy semantic ID from output
grafema get "<semantic-id>"
# Verify output is correct and helpful
```

### 8. Edge Cases and Considerations

**Edge case: Very long semantic IDs**
- Semantic IDs can be long for deeply nested scopes
- Solution: No truncation needed - users copy/paste from other commands
- Terminal will wrap naturally

**Edge case: Many edges (100+ incoming/outgoing)**
- Text output limits to 20 per direction
- Shows count: "Incoming edges (127):"
- Displays first 20, then "... and 107 more"
- JSON output includes ALL edges (no limit)
- Rationale: Text is for humans (scrolling fatigue), JSON is for scripts (completeness)

**Edge case: Special characters in semantic IDs**
- Semantic IDs may contain `->`, `#`, `:` characters
- Shell quoting required: `grafema get "id-with->special->chars"`
- Document in help text and README

**Edge case: Node with no name**
- Some nodes (SCOPE, CALL) may have empty names
- Display as: `[SCOPE] <anonymous>`
- Semantic ID still works for lookup

**Edge case: External/imported nodes**
- Nodes from `node_modules` or external files
- May have different file paths
- Display works normally, just shows full path

**Edge case: Backend already running**
- RFDBServerBackend handles this automatically
- Connects to existing server via socket
- No special handling needed

### 9. Performance Considerations

**Backend operations:**
- `getNode()`: O(1) hash lookup - fast
- `getIncomingEdges()`: O(E) where E = edge count for this node
- `getOutgoingEdges()`: O(E) where E = edge count for this node

**Typical performance:**
- Node with 10 edges: ~5ms
- Node with 100 edges: ~20ms
- Node with 1000 edges: ~100ms

**Bottleneck:** Fetching node details for each edge (for display names)
- Text output fetches up to 40 nodes (20 incoming + 20 outgoing)
- Each fetch is a separate backend call
- Could be optimized with batch fetch in future

**Optimization NOT needed for v1:**
- 40 sequential getNode calls = ~20ms on typical hardware
- User won't notice < 100ms latency
- Can optimize later if performance complaints arise

### 10. Future Enhancements (NOT in this PR)

**Multiple IDs:**
```bash
grafema get "id1" "id2" "id3"
```
- Would display all nodes in sequence
- Useful for batch inspection
- Not critical for MVP

**Edge filtering:**
```bash
grafema get "id" --edges CALLS,CONTAINS
```
- Show only specific edge types
- Reduces noise for large nodes
- Can add later if needed

**Depth traversal:**
```bash
grafema get "id" --depth 2
```
- Show nodes connected at distance N
- Basically a mini-trace
- Overlaps with `trace` command - may not be needed

**Interactive mode:**
```bash
grafema get "id" --interactive
```
- Press number to navigate to connected node
- Like a graph browser in terminal
- Nice-to-have, not essential

## Open Questions (for Don/Linus review)

1. **Edge display limit:** 20 per direction OK? Or should it be configurable?
   - Recommendation: Keep 20 for v1, add `--limit` flag later if needed

2. **Edge node names:** Fetch node details to show names, or just show IDs?
   - Current plan: Fetch names for better UX
   - Alternative: Just show IDs (faster, but less useful)

3. **Metadata display:** Show all non-standard fields, or filter some?
   - Current plan: Show all
   - Risk: Internal fields might clutter output

4. **Command position in help:** After `query` or after `trace`?
   - Current plan: After `query` (find → retrieve)
   - Alternative: After `trace` (since trace shows semantic IDs)

## Acceptance Criteria

✅ **Functional:**
1. `grafema get <id>` retrieves node by exact semantic ID
2. Displays node details (type, name, location)
3. Shows incoming and outgoing edges (limited to 20 each in text mode)
4. `--json` flag outputs structured JSON
5. Clear error when node not found
6. Clear error when database not initialized

✅ **Quality:**
7. Unit tests cover all helper functions
8. Integration tests cover happy path and error cases
9. Consistent formatting with other commands (uses formatNodeDisplay)
10. Error messages follow REG-157 standard (exitWithError)

✅ **Documentation:**
11. `--help` text is clear and includes examples
12. README.md documents the command
13. Works when called from real project (dogfooding)

✅ **Performance:**
14. Completes in < 100ms for typical node (< 50 edges)
15. No unnecessary backend calls

## Success Metrics

**User workflow that MUST work:**
```bash
$ grafema trace "response"
[VARIABLE] response
  ID: AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response
  ...

$ grafema get "AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response"
[VARIABLE] response
  ID: AdminSetlist.tsx->AdminSetlist->handleDragEnd->try#0->VARIABLE->response
  Location: apps/frontend/src/pages/AdminSetlist.tsx:671

Incoming edges (1):
  <- ASSIGNED_FROM: CALL#authFetch

Outgoing edges (2):
  -> USED_BY: EXPRESSION#...
  -> FLOWS_TO: VARIABLE#items
```

**This should work without errors, without surprises, without reading files.**

---

## Technical Debt

None. This is a clean additive feature with no architectural compromises.

## Related Issues

- REG-179: This issue
- REG-125: Semantic ID display format (dependency - already implemented)
- REG-157: Error message standardization (dependency - already implemented)

## Estimated Timeline

- Implementation: 2 hours
- Testing: 1 hour
- Review iterations: 30 min
- **Total: 3-4 hours**

Simple feature, well-defined scope, no surprises expected.

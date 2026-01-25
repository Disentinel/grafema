# Joel Spolsky - Detailed Technical Specification

## REG-204: Explore Command Batch Mode Support

---

## Executive Summary

The `explore` command crashes with "Raw mode is not supported" in non-interactive environments because ink's `render()` calls `process.stdin.setRawMode(true)`, which fails when stdin is not a TTY. This specification details the implementation of dual-mode support: interactive TUI when TTY is available, batch mode via command-line flags otherwise.

---

## 1. Architecture Overview

### Current State
```
explore.tsx
    └─ render(<Explorer/>) → ink → process.stdin.setRawMode(true) → CRASH in non-TTY
```

### Target State
```
explore.tsx
    ├─ [if batch flags] → runBatchExplore() → stdout/JSON
    └─ [else]
         ├─ [if isTTY] → render(<Explorer/>) → interactive TUI
         └─ [else] → exitWithError() with helpful suggestions
```

---

## 2. Detailed Implementation Steps

### Phase 1: TTY Detection and Graceful Error (Quick Win)

#### Step 1.1: Add TTY Detection Before render()

**File:** `packages/cli/src/commands/explore.tsx`

**Location:** Inside the `.action()` handler, after `findStartNode()` call but before `render()`

**Add:**
```typescript
// Check TTY before attempting interactive mode
const isTTY = process.stdin.isTTY && process.stdout.isTTY;

if (!isTTY) {
  exitWithError('Interactive mode requires a terminal', [
    'Batch mode: grafema explore --query "functionName"',
    'Alternative: grafema query "functionName"',
    'Alternative: grafema impact "functionName"',
  ]);
}
```

---

### Phase 2: Add Batch Mode Command-Line Options

#### Step 2.1: Define New Options Interface

**File:** `packages/cli/src/commands/explore.tsx`

**Location:** After imports, before interface definitions

**Add:**
```typescript
interface ExploreOptions {
  project: string;
  // Batch mode flags
  query?: string;
  callers?: string;
  callees?: string;
  depth?: string;
  json?: boolean;
  format?: 'json' | 'text';
}
```

#### Step 2.2: Add Commander Options

**Change from:**
```typescript
export const exploreCommand = new Command('explore')
  .description('Interactive graph navigation')
  .argument('[start]', 'Starting function name')
  .option('-p, --project <path>', 'Project path', '.')
  .action(async (start: string | undefined, options: { project: string }) => {
```

**Change to:**
```typescript
export const exploreCommand = new Command('explore')
  .description('Interactive graph navigation (TUI) or batch query mode')
  .argument('[start]', 'Starting function name (for interactive mode)')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-q, --query <name>', 'Batch: search for nodes by name')
  .option('--callers <name>', 'Batch: show callers of function')
  .option('--callees <name>', 'Batch: show callees of function')
  .option('-d, --depth <n>', 'Batch: traversal depth', '3')
  .option('-j, --json', 'Output as JSON (default for batch mode)')
  .option('--format <type>', 'Output format: json or text', 'json')
  .action(async (start: string | undefined, options: ExploreOptions) => {
```

#### Step 2.3: Add Batch Mode Detection and Routing

**Location:** Inside `.action()` handler, after backend connection, before `findStartNode()`

**Add:**
```typescript
// Detect batch mode
const isBatchMode = !!(options.query || options.callers || options.callees);

if (isBatchMode) {
  await runBatchExplore(backend, options, projectPath);
  return;
}

// Continue with interactive mode...
```

---

### Phase 3: Implement Batch Mode Handler

#### Step 3.1: Create runBatchExplore Function

**Add new function:**
```typescript
/**
 * Run explore in batch mode - for AI agents, CI, and scripts
 */
async function runBatchExplore(
  backend: RFDBServerBackend,
  options: ExploreOptions,
  projectPath: string
): Promise<void> {
  const depth = parseInt(options.depth || '3', 10);
  const useJson = options.json || options.format === 'json';

  try {
    if (options.query) {
      // Search mode
      const results = await searchNodes(backend, options.query, 20);
      outputResults(results, 'search', useJson, projectPath);
    } else if (options.callers) {
      // Callers mode
      const target = await searchNode(backend, options.callers);
      if (!target) {
        exitWithError(`Function "${options.callers}" not found`, [
          'Try: grafema query "partial-name"',
        ]);
      }
      const callers = await getCallersRecursive(backend, target.id, depth);
      outputResults(callers, 'callers', useJson, projectPath, target);
    } else if (options.callees) {
      // Callees mode
      const target = await searchNode(backend, options.callees);
      if (!target) {
        exitWithError(`Function "${options.callees}" not found`, [
          'Try: grafema query "partial-name"',
        ]);
      }
      const callees = await getCalleesRecursive(backend, target.id, depth);
      outputResults(callees, 'callees', useJson, projectPath, target);
    }
  } catch (err) {
    exitWithError(`Explore failed: ${(err as Error).message}`);
  }
}
```

#### Step 3.2: Create Output Formatting Function

```typescript
/**
 * Output results in JSON or text format
 */
function outputResults(
  nodes: NodeInfo[],
  mode: 'search' | 'callers' | 'callees',
  useJson: boolean,
  projectPath: string,
  target?: NodeInfo
): void {
  if (useJson) {
    const output = {
      mode,
      target: target ? formatNodeForJson(target, projectPath) : undefined,
      count: nodes.length,
      results: nodes.map(n => formatNodeForJson(n, projectPath)),
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    // Text format
    if (target) {
      console.log(`${mode === 'callers' ? 'Callers of' : 'Callees of'}: ${target.name}`);
      console.log(`File: ${relative(projectPath, target.file)}${target.line ? `:${target.line}` : ''}`);
      console.log('');
    }

    if (nodes.length === 0) {
      console.log(`  (no ${mode} found)`);
    } else {
      for (const node of nodes) {
        const loc = relative(projectPath, node.file);
        console.log(`  ${node.type} ${node.name} (${loc}${node.line ? `:${node.line}` : ''})`);
      }
    }

    console.log('');
    console.log(`Total: ${nodes.length}`);
  }
}

function formatNodeForJson(node: NodeInfo, projectPath: string): object {
  return {
    id: node.id,
    type: node.type,
    name: node.name,
    file: relative(projectPath, node.file),
    line: node.line,
    async: node.async,
    exported: node.exported,
  };
}
```

#### Step 3.3: Add Recursive Traversal Functions

```typescript
/**
 * Get callers recursively up to specified depth
 */
async function getCallersRecursive(
  backend: RFDBServerBackend,
  nodeId: string,
  maxDepth: number
): Promise<NodeInfo[]> {
  const results: NodeInfo[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    const callers = await getCallers(backend, id, 50);
    for (const caller of callers) {
      if (!visited.has(caller.id)) {
        results.push(caller);
        if (depth < maxDepth) {
          queue.push({ id: caller.id, depth: depth + 1 });
        }
      }
    }
  }

  return results;
}

/**
 * Get callees recursively up to specified depth
 */
async function getCalleesRecursive(
  backend: RFDBServerBackend,
  nodeId: string,
  maxDepth: number
): Promise<NodeInfo[]> {
  const results: NodeInfo[] = [];
  const visited = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [{ id: nodeId, depth: 0 }];

  while (queue.length > 0) {
    const { id, depth } = queue.shift()!;
    if (visited.has(id) || depth > maxDepth) continue;
    visited.add(id);

    const callees = await getCallees(backend, id, 50);
    for (const callee of callees) {
      if (!visited.has(callee.id)) {
        results.push(callee);
        if (depth < maxDepth) {
          queue.push({ id: callee.id, depth: depth + 1 });
        }
      }
    }
  }

  return results;
}
```

---

### Phase 4: Update Action Handler Logic

#### Complete Action Handler Restructure

```typescript
.action(async (start: string | undefined, options: ExploreOptions) => {
  const projectPath = resolve(options.project);
  const grafemaDir = join(projectPath, '.grafema');
  const dbPath = join(grafemaDir, 'graph.rfdb');

  if (!existsSync(dbPath)) {
    exitWithError('No graph database found', ['Run: grafema analyze']);
  }

  const backend = new RFDBServerBackend({ dbPath });

  try {
    await backend.connect();

    // Detect batch mode
    const isBatchMode = !!(options.query || options.callers || options.callees);

    if (isBatchMode) {
      await runBatchExplore(backend, options, projectPath);
      return;
    }

    // Interactive mode - check TTY
    const isTTY = process.stdin.isTTY && process.stdout.isTTY;

    if (!isTTY) {
      exitWithError('Interactive mode requires a terminal', [
        'Batch mode: grafema explore --query "functionName"',
        'Batch mode: grafema explore --callers "functionName"',
        'Batch mode: grafema explore --callees "functionName"',
        'Alternative: grafema query "functionName"',
        'Alternative: grafema impact "functionName"',
      ]);
    }

    const startNode = await findStartNode(backend, start || null);

    const { waitUntilExit } = render(
      <Explorer
        backend={backend}
        startNode={startNode}
        projectPath={projectPath}
      />
    );

    await waitUntilExit();
  } finally {
    await backend.close();
  }
});
```

---

## 3. Test Cases

### Test File Location
Create new file: `packages/cli/test/explore.test.ts`

### Test Cases to Implement

```typescript
describe('explore command', () => {
  describe('TTY detection', () => {
    it('should show error with suggestions when stdin is not TTY');
    it('should show error with suggestions when stdout is not TTY');
  });

  describe('batch mode --query', () => {
    it('should search and return JSON results');
    it('should search and return text results');
    it('should handle no results gracefully');
  });

  describe('batch mode --callers', () => {
    it('should show callers of a function');
    it('should respect --depth for recursive traversal');
    it('should error when function not found');
  });

  describe('batch mode --callees', () => {
    it('should show callees of a function');
  });

  describe('piped input', () => {
    it('should work with piped input in batch mode');
  });
});
```

---

## 4. Edge Cases and Error Handling

| Edge Case | Behavior |
|-----------|----------|
| Both start argument and batch flag | Batch mode takes precedence |
| Multiple batch flags | Process in order: query > callers > callees |
| Empty database | Return empty results, not error |
| Invalid depth | Fall back to default (3) |
| Very deep traversal (depth 100) | Allow but may be slow |

---

## 5. Output Format Specification

### JSON Output Schema
```typescript
interface ExploreJsonOutput {
  mode: 'search' | 'callers' | 'callees';
  target?: {
    id: string;
    type: string;
    name: string;
    file: string;  // relative path
    line?: number;
  };
  count: number;
  results: Array<{
    id: string;
    type: string;
    name: string;
    file: string;
    line?: number;
  }>;
}
```

### Text Output Format
```
Callers of: authenticate
File: src/auth/service.ts:42

  FUNCTION login (src/routes/login.ts:15)
  FUNCTION handleAuth (src/middleware/auth.ts:28)

Total: 2
```

---

## 6. Dependencies and Imports

Add `relative` import:
```typescript
import { resolve, join, relative } from 'path';
```

No new external dependencies needed.

---

## 7. Implementation Order

1. **Phase 1**: Add TTY detection and error message
2. **Phase 2**: Add Commander options
3. **Phase 3**: Implement `runBatchExplore()` and helpers
4. **Phase 4**: Restructure action handler
5. **Testing**: Write and run test cases

---

## 8. Backward Compatibility

- Interactive mode unchanged when TTY available
- New flags are optional, no breaking changes
- `start` argument still works for interactive mode
- `--json` flag consistent with other commands

---

## 9. Critical Files

- `packages/cli/src/commands/explore.tsx` - Main implementation
- `packages/cli/src/commands/query.ts` - Pattern reference
- `packages/cli/src/commands/impact.ts` - Traversal pattern reference
- `packages/cli/src/utils/errorFormatter.ts` - Error handling
- `packages/cli/test/cli.test.ts` - Test pattern reference

# Don's Implementation Plan v2: Socket Connection Analysis (REG-432)

## Executive Summary

Implement socket connection analysis following the proven HTTP analyzer/enricher pattern. This enables Grafema to detect and link Unix and TCP socket connections, starting with dogfooding: visualizing Grafema's own RFDB Unix socket communication.

**Pattern to follow:** FetchAnalyzer (ANALYSIS) → HTTPConnectionEnricher (ENRICHMENT)

**Critical fixes from v1:**
1. **Namespace correction:** Using `net:*` (not `socket:*`) to match existing `net:request`, `net:stdio`
2. **Enricher metadata:** Only creates `INTERACTS_WITH` edges (analyzer creates `CONTAINS`)
3. **Complexity verified:** Analyzer iterates M modules (bounded), enricher iterates C × S (small sets)
4. **Test fixture:** Using `10-socket-connections` (next available number)
5. **Scope:** V1 covers direct `net.*` calls only (documented limitation)

## Architecture Overview

### Two-Phase Pattern

**Phase 1: ANALYSIS** - SocketAnalyzer detects socket operations and creates nodes
**Phase 2: ENRICHMENT** - SocketConnectionEnricher links clients to servers by matching paths/ports

This matches the existing HTTP pattern:
- FetchAnalyzer creates `http:request` nodes
- HTTPConnectionEnricher creates `INTERACTS_WITH` edges between requests and routes

### Node Types

**`net:connection`** (client-side, outgoing connections)
- Protocol: `unix` | `tcp`
- For Unix: `path` (e.g., `/tmp/app.sock`, `.grafema/rfdb.sock`)
- For TCP: `host`, `port`
- Library: `net`, `ipc`, or custom wrapper

**`net:server`** (server-side listeners)
- Protocol: `unix` | `tcp`
- For Unix: `path`
- For TCP: `host`, `port`
- Server options extracted from AST

**Namespace rationale:** Using `net:` to match existing network node types (`net:request`, `net:stdio`). The `isSideEffectType()` helper already checks `ns === 'net'`, so no changes needed there.

### Edge Types

Use existing edge types:
- **`INTERACTS_WITH`**: `net:connection` → `net:server` (same as HTTP pattern)
- **`CONTAINS`**: `MODULE` → `net:connection` / `net:server` (created by analyzer)
- **`MAKES_REQUEST`**: `FUNCTION` → `net:connection`, `CALL` → `net:connection` (created by analyzer)

**Enricher creates ONLY:** `INTERACTS_WITH` edges (linking client to server)
**Analyzer creates:** nodes + `CONTAINS` + `MAKES_REQUEST` edges

## Prior Art & References

Based on web search, standard Node.js documentation shows common patterns but no existing AST analyzers for net module detection. We'll build on Babel AST fundamentals:

- [Babel AST Specification](https://github.com/babel/babel/blob/main/packages/babel-parser/ast/spec.md)
- [Understanding ASTs by Building Babel Plugin](https://www.sitepoint.com/understanding-asts-building-babel-plugin/)
- [Node.js Net Module Official Docs](https://nodejs.org/api/net.html)

Key insight: CallExpression detection pattern used in FetchAnalyzer applies directly to net module methods.

## Detection Patterns

### Unix Socket Client

```javascript
// Pattern 1: net.connect with options object
net.connect({ path: '/tmp/app.sock' })

// Pattern 2: net.createConnection with path string
net.createConnection('/var/run/rfdb.sock')

// Pattern 3: Socket instance
const socket = new net.Socket()
socket.connect({ path: '/tmp/app.sock' })
```

### TCP Socket Client

```javascript
// Pattern 1: net.connect with port/host
net.connect({ port: 3000, host: 'localhost' })
net.connect(3000, 'localhost')

// Pattern 2: Socket instance
new net.Socket().connect(3000, 'localhost')
```

### Socket Server

```javascript
// Pattern 1: Unix socket server
net.createServer((socket) => { ... }).listen('/tmp/app.sock')
net.createServer().listen({ path: '/tmp/app.sock' })

// Pattern 2: TCP server
net.createServer().listen(3000)
net.createServer().listen({ port: 3000, host: 'localhost' })
```

## Complexity Analysis (MANDATORY)

### Iteration Space Verification

**SocketAnalyzer (ANALYSIS phase):**
- **Iteration:** O(M) modules where M = number of modules in project
- **Same as:** FetchAnalyzer, DatabaseAnalyzer (all analyzers iterate modules)
- **Bounded:** Yes, M is project size (typically 100-10,000 modules)
- **Pattern:** Module-by-module iteration, NOT scanning all graph nodes
- **Verdict:** ✅ Acceptable

**SocketConnectionEnricher (ENRICHMENT phase):**
- **Iteration:** O(C × S) where:
  - C = number of `net:connection` nodes
  - S = number of `net:server` nodes
- **Expected size:** C and S are typically <100 in large projects (socket usage is sparse)
- **Worst case:** 100 × 100 = 10,000 comparisons (negligible)
- **Pattern:** Nested loop over two SMALL sets, NOT scanning all graph nodes
- **Verdict:** ✅ Acceptable

**No brute-force scanning:** Neither plugin iterates over all graph nodes. Analyzer extends existing module iteration (reuses JSModuleIndexer pass). Enricher queries only specific node types.

**Plugin Architecture Check:**
- ✅ Forward registration: Analyzer declares `creates: { nodes: ['net:connection', 'net:server'] }`
- ✅ Extends existing iteration: Reuses module iteration from JSModuleIndexer
- ✅ Extensible: Adding new socket libraries (e.g., IPC wrappers) requires only pattern updates in analyzer

## Implementation Plan

### Step 1: Define Node Types in Types Package

**File:** `/Users/vadim/grafema-worker-9/packages/types/src/nodes.ts`

Add to `NAMESPACED_TYPE` (around line 79):
```typescript
// Network - Sockets (TCP/Unix)
NET_CONNECTION: 'net:connection',
NET_SERVER: 'net:server',
```

Add node record interfaces (after existing net types):
```typescript
// Socket connection node (client)
export interface NetConnectionNodeRecord extends BaseNodeRecord {
  type: 'net:connection';
  protocol: 'unix' | 'tcp';
  path?: string;           // Unix socket path
  host?: string;           // TCP host
  port?: number;           // TCP port
  library: string;         // 'net', 'ipc', custom
}

// Socket server node
export interface NetServerNodeRecord extends BaseNodeRecord {
  type: 'net:server';
  protocol: 'unix' | 'tcp';
  path?: string;           // Unix socket path
  host?: string;           // TCP host
  port?: number;           // TCP port
  backlog?: number;        // Server backlog option
}
```

Add to `NodeRecord` union type at end of file:
```typescript
export type NodeRecord =
  // ... existing types
  | NetConnectionNodeRecord
  | NetServerNodeRecord
  // ... rest
```

**No changes to `isSideEffectType()`** - already checks `ns === 'net'` which covers our new types.

### Step 2: Create SocketAnalyzer (ANALYSIS Phase)

**File:** `/Users/vadim/grafema-worker-9/packages/core/src/plugins/analysis/SocketAnalyzer.ts`

**Structure:** Follow FetchAnalyzer pattern exactly.

```typescript
/**
 * SocketAnalyzer - detects socket connections (Unix/TCP) via Node.js net module
 *
 * Patterns:
 * - net.connect({ path: '/tmp/app.sock' })
 * - net.createConnection(port, host)
 * - net.createServer().listen(path)
 * - new net.Socket().connect(...)
 */

import { readFileSync } from 'fs';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';
import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';
import type { NodeRecord } from '@grafema/types';
import { getLine, getColumn } from './ast/utils/location.js';
import { resolveNodeFile } from '../../utils/resolveNodeFile.js';

export class SocketAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'SocketAnalyzer',
      phase: 'ANALYSIS',
      creates: {
        nodes: ['net:connection', 'net:server'],
        edges: ['CONTAINS', 'MAKES_REQUEST']
      },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    // Similar to FetchAnalyzer.execute()
    // 1. Get all MODULE nodes
    // 2. For each module, parse AST and detect patterns
    // 3. Batch create nodes and edges
  }

  private async analyzeModule(
    module: NodeRecord,
    graph: PluginContext['graph'],
    projectPath: string
  ): Promise<AnalysisResult> {
    // Parse with Babel
    // Traverse AST looking for CallExpression patterns:
    //   - net.connect()
    //   - net.createConnection()
    //   - net.createServer()
    //   - new net.Socket()
  }

  // Helper methods:
  private extractSocketPath(arg): string | null
  private extractPortHost(args): { port?: number; host?: string }
  private isUnixSocket(path): boolean
  private detectProtocol(args): 'unix' | 'tcp'
}
```

**AST Pattern Detection Logic:**

1. **Client connections** (CallExpression):
   - `callee.type === 'MemberExpression'`
   - `callee.object.name === 'net'`
   - `callee.property.name === 'connect' || 'createConnection'`

2. **Server listeners** (CallExpression):
   - Pattern: `net.createServer(...).listen(...)`
   - Detect chained method calls
   - Extract listen() argument (path or port)

3. **Socket constructor** (NewExpression):
   - `callee.type === 'Identifier'`
   - `callee.name === 'Socket'`
   - Check for `.connect()` call on result

**Metadata extraction:**
- For Unix: extract string literal path from first arg or `{ path: '...' }`
- For TCP: extract port (number), host (string) from args or options object
- Handle both positional args and options object: `net.connect(3000, 'localhost')` vs `net.connect({ port: 3000, host: 'localhost' })`

**Edge creation (in analyzer):**
- `CONTAINS`: `MODULE` → `net:connection` / `net:server`
- `MAKES_REQUEST`: `FUNCTION` → `net:connection`, `CALL` → `net:connection`

### Step 3: Create SocketConnectionEnricher (ENRICHMENT Phase)

**File:** `/Users/vadim/grafema-worker-9/packages/core/src/plugins/enrichment/SocketConnectionEnricher.ts`

**Structure:** Follow HTTPConnectionEnricher pattern exactly.

```typescript
/**
 * SocketConnectionEnricher - links net:connection (client) to net:server
 *
 * Creates INTERACTS_WITH edges by matching:
 * - Unix sockets: path equality
 * - TCP sockets: host + port equality
 */

import { Plugin, createSuccessResult, createErrorResult } from '../Plugin.js';
import type { PluginContext, PluginResult, PluginMetadata } from '../Plugin.js';

export class SocketConnectionEnricher extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'SocketConnectionEnricher',
      phase: 'ENRICHMENT',
      creates: {
        nodes: [],
        edges: ['INTERACTS_WITH']
      },
      dependencies: ['SocketAnalyzer']
    };
  }

  async execute(context: PluginContext): Promise<PluginResult> {
    // 1. Query all net:connection nodes
    // 2. Query all net:server nodes
    // 3. Match by protocol + path/port
    // 4. Create INTERACTS_WITH edges
  }

  private matchUnixSockets(client, server): boolean {
    // Normalize paths (resolve relative, strip trailing /)
    // Handle template literals: '.grafema/rfdb.sock' vs `${projectPath}/.grafema/rfdb.sock`
  }

  private matchTCPSockets(client, server): boolean {
    // Match port (required)
    // Match host (default 'localhost' if missing)
  }
}
```

**Matching logic:**

Unix sockets:
- Exact path match after normalization
- Handle relative vs absolute paths
- Consider path variables (template literals → mark as dynamic, skip matching)

TCP sockets:
- Port must match exactly
- Host defaults to 'localhost' if not specified
- Consider host='0.0.0.0' (all interfaces) → matches any client host

**Enricher creates ONLY `INTERACTS_WITH` edges** (no `CONTAINS`, no nodes)

### Step 4: Register Plugins in BUILTIN_PLUGINS

**File:** `/Users/vadim/grafema-worker-9/packages/cli/src/commands/analyze.ts`

Add imports:
```typescript
import {
  // ... existing imports
  SocketAnalyzer,  // NEW
} from '@grafema/core';

import {
  // ... existing enrichment imports
  SocketConnectionEnricher,  // NEW
} from '@grafema/core';
```

Add to `BUILTIN_PLUGINS` object:
```typescript
const BUILTIN_PLUGINS: Record<string, () => Plugin> = {
  // ... existing plugins
  SocketAnalyzer: () => new SocketAnalyzer() as Plugin,  // Analysis section
  // ... 
  SocketConnectionEnricher: () => new SocketConnectionEnricher() as Plugin,  // Enrichment section
};
```

**Export from core package:**

**File:** `/Users/vadim/grafema-worker-9/packages/core/src/index.ts`

Add exports:
```typescript
// Analysis plugins
export { SocketAnalyzer } from './plugins/analysis/SocketAnalyzer.js';

// Enrichment plugins  
export { SocketConnectionEnricher } from './plugins/enrichment/SocketConnectionEnricher.js';
```

### Step 5: Tests

**Create test file:** `/Users/vadim/grafema-worker-9/test/unit/SocketAnalyzer.test.js`

Follow pattern from `FetchAnalyzerCallEdge.test.js`:

```javascript
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createTestDatabase, cleanupAllTestDatabases } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

describe('SocketAnalyzer', () => {
  let db, backend;

  beforeEach(async () => {
    if (db) await db.cleanup();
    db = await createTestDatabase();
    backend = db.backend;
  });

  it('detects Unix socket client (net.connect with path)', async () => {
    // Setup test project with net.connect({ path: '/tmp/app.sock' })
    // Run analysis
    // Assert net:connection node exists with protocol='unix', path='/tmp/app.sock'
  });

  it('detects TCP socket client (net.connect with port/host)', async () => {
    // Setup test project with net.connect(3000, 'localhost')
    // Assert net:connection node exists with protocol='tcp', port=3000, host='localhost'
  });

  it('detects Unix socket server (net.createServer().listen(path))', async () => {
    // Setup test project with net.createServer().listen('/tmp/app.sock')
    // Assert net:server node exists with protocol='unix', path='/tmp/app.sock'
  });

  it('detects TCP socket server (net.createServer().listen(port))', async () => {
    // Assert net:server node exists with protocol='tcp', port=3000
  });

  it('creates MAKES_REQUEST edge from CALL to net:connection', async () => {
    // Verify edge exists: CALL (net.connect) → net:connection
  });

  it('creates MAKES_REQUEST edge from FUNCTION to net:connection', async () => {
    // Verify edge exists: FUNCTION → net:connection
  });
});
```

**Create enricher test:** `/Users/vadim/grafema-worker-9/test/unit/plugins/enrichment/SocketConnectionEnricher.test.js`

Follow pattern from `HTTPConnectionEnricher.test.js`:

```javascript
describe('SocketConnectionEnricher', () => {
  it('links Unix socket client to server by path', async () => {
    // Client: net.connect({ path: '/tmp/app.sock' })
    // Server: net.createServer().listen('/tmp/app.sock')
    // Assert: INTERACTS_WITH edge exists
  });

  it('links TCP socket client to server by port/host', async () => {
    // Client: net.connect(3000, 'localhost')
    // Server: net.createServer().listen(3000)
    // Assert: INTERACTS_WITH edge exists
  });

  it('normalizes relative Unix socket paths', async () => {
    // Client: '.grafema/rfdb.sock'
    // Server: '.grafema/rfdb.sock'
    // Assert: paths match after normalization
  });

  it('skips dynamic paths (template literals with variables)', async () => {
    // Client: `${projectPath}/app.sock`
    // Server: '/tmp/app.sock'
    // Assert: no INTERACTS_WITH edge (dynamic path)
  });
});
```

**Test fixtures:**

Create `/Users/vadim/grafema-worker-9/test/fixtures/10-socket-connections/`:

```
10-socket-connections/
├── package.json
├── unix-client.js        # net.connect({ path: '/tmp/app.sock' })
├── unix-server.js        # net.createServer().listen('/tmp/app.sock')
├── tcp-client.js         # net.connect(3000, 'localhost')
└── tcp-server.js         # net.createServer().listen(3000)
```

### Step 6: Dogfooding Validation

**Goal:** Grafema's own RFDB socket connection should appear in graph.

**Validation steps:**

1. Run analysis on Grafema project itself: `node packages/cli/dist/cli.js analyze`

2. Query for Grafema's RFDB socket connection:
   ```bash
   node packages/cli/dist/cli.js query -d "
     socket:connection(id, path, protocol, file) :-
       node(id, 'net:connection', _),
       attr(id, 'path', path),
       attr(id, 'protocol', protocol),
       attr(id, 'file', file),
       path ~ '.grafema/rfdb.sock'.
   "
   ```

3. Expected result:
   - `net:connection` node in `RFDBServerBackend.ts`
   - Path: `.grafema/rfdb.sock` (or absolute path)
   - Protocol: `unix`

4. Check for enrichment edge:
   ```bash
   # Find INTERACTS_WITH edge linking client to server (if server is in codebase)
   node packages/cli/dist/cli.js query -d "
     connection(client, server) :-
       edge(client, server, 'INTERACTS_WITH'),
       node(client, 'net:connection', _),
       node(server, 'net:server', _).
   "
   ```

**Note:** Grafema codebase contains the client side (RFDBServerBackend), but the RFDB server is a separate Rust process. We'll detect the client connection, but won't find a matching server in the JS codebase (expected).

## Edge Cases & Considerations

1. **Dynamic paths** (template literals with variables):
   - Mark as `dynamicPath: true` in metadata
   - Skip enrichment matching (can't resolve statically)

2. **IPC vs Unix domain sockets**:
   - Node.js uses same API for both
   - Treat uniformly as `protocol: 'unix'`

3. **IPv4 vs IPv6**:
   - Store host as-is, don't normalize
   - Match exactly (e.g., '127.0.0.1' !== 'localhost')

4. **Server wildcard host** (`0.0.0.0`):
   - Future: could match any client host
   - V1: require exact match, document limitation

5. **Multiple servers on same path/port**:
   - Create multiple `net:server` nodes (different files/lines)
   - Enricher creates edge to first match only (consistent with HTTP pattern)

## V1 Scope & Limitations

**In scope:**
- Direct `net.*` calls only: `net.connect()`, `net.createConnection()`, `net.createServer()`
- Static paths and ports (string literals, number literals)
- Options objects with resolvable properties

**Out of scope (documented limitations):**
- Custom wrappers around net module (e.g., library-specific socket classes)
- Dynamic paths/ports from variables/config
- Server wildcard host matching (`0.0.0.0` → any client)

**Limitation documentation:** Add to enricher JSDoc and error messages.

## Dependencies & Order

**Plugin execution order:**
1. JSModuleIndexer (provides MODULE nodes)
2. JSASTAnalyzer (provides FUNCTION, CALL nodes)
3. **SocketAnalyzer** (creates net:connection, net:server)
4. **SocketConnectionEnricher** (creates INTERACTS_WITH edges)

Declared in `metadata.dependencies`:
- SocketAnalyzer depends on: `['JSModuleIndexer', 'JSASTAnalyzer']`
- SocketConnectionEnricher depends on: `['SocketAnalyzer']`

## Risks & Mitigations

**Risk 1:** Template literal paths can't be resolved
- **Mitigation:** Mark as dynamic, skip enrichment, document limitation

**Risk 2:** Chained method calls are complex to parse (e.g., `net.createServer().listen()`)
- **Mitigation:** Use AST parent path traversal (same as Socket.IO analyzer)

**Risk 3:** Custom wrappers around net module won't be detected
- **Mitigation:** V1 covers only direct `net.*` calls, document as limitation

**Risk 4:** Performance on large codebases
- **Mitigation:** Same batch processing as FetchAnalyzer (proven pattern)

## Acceptance Criteria Validation

- [x] Node types defined in types package (using `net:*` namespace)
- [x] SocketAnalyzer detects all patterns from user requirements
- [x] SocketConnectionEnricher links client ↔ server
- [x] Tests cover Unix socket, TCP socket, server patterns
- [x] Dogfooding: Grafema's RFDB socket connection visible in graph
- [x] Plugin registration in BUILTIN_PLUGINS
- [x] Complexity analysis verified (M modules, C×S enrichment)
- [x] Enricher metadata correct (only INTERACTS_WITH, no CONTAINS)

## Files to Create/Modify Summary

**New files:**
1. `/Users/vadim/grafema-worker-9/packages/core/src/plugins/analysis/SocketAnalyzer.ts` (~400 lines, based on FetchAnalyzer)
2. `/Users/vadim/grafema-worker-9/packages/core/src/plugins/enrichment/SocketConnectionEnricher.ts` (~200 lines, based on HTTPConnectionEnricher)
3. `/Users/vadim/grafema-worker-9/test/unit/SocketAnalyzer.test.js` (~300 lines)
4. `/Users/vadim/grafema-worker-9/test/unit/plugins/enrichment/SocketConnectionEnricher.test.js` (~200 lines)
5. `/Users/vadim/grafema-worker-9/test/fixtures/10-socket-connections/` (5 files)

**Modified files:**
1. `/Users/vadim/grafema-worker-9/packages/types/src/nodes.ts` (+50 lines: node types using `net:*`, interfaces)
2. `/Users/vadim/grafema-worker-9/packages/cli/src/commands/analyze.ts` (+4 lines: imports, BUILTIN_PLUGINS entries)
3. `/Users/vadim/grafema-worker-9/packages/core/src/index.ts` (+2 lines: exports)

**Total LOC estimate:** ~1,200 lines (analyzer ~400, enricher ~200, tests ~500, types ~50, fixtures ~50)

## Timeline Estimate

- Step 1 (Types): 30 min
- Step 2 (SocketAnalyzer): 3 hours (based on FetchAnalyzer complexity)
- Step 3 (SocketConnectionEnricher): 2 hours (simpler than analyzer)
- Step 4 (Plugin registration): 15 min
- Step 5 (Tests): 2 hours (critical for correctness)
- Step 6 (Dogfooding validation): 30 min

**Total: 8-9 hours** (1 day of focused work)

## Next Steps

After plan approval:
1. Uncle Bob reviews this plan for file-level concerns
2. Kent writes tests (parallel with Rob)
3. Rob implements SocketAnalyzer and SocketConnectionEnricher
4. Validate dogfooding: Grafema's own socket connection visible in graph
5. Auto-review checks completeness

---

**Sources:**
- [Babel AST Specification](https://github.com/babel/babel/blob/main/packages/babel-parser/ast/spec.md)
- [Understanding ASTs by Building Your Own Babel Plugin](https://www.sitepoint.com/understanding-asts-building-babel-plugin/)
- [Node.js Net Module Documentation](https://nodejs.org/api/net.html)
- [Babel Types API](https://babeljs.io/docs/babel-types)

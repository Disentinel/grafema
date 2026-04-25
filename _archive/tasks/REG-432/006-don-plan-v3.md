# Don's Implementation Plan v3: Socket Connection Analysis with Namespace Split (REG-432)

## Executive Summary

Implement socket connection analysis following the proven HTTP analyzer/enricher pattern, with **separate namespaces for Unix and TCP sockets**. This enables Grafema to distinguish between OS-level IPC (Unix domain sockets) and network communication (TCP sockets), starting with dogfooding: visualizing Grafema's own RFDB Unix socket communication.

**Key change from v2:** Split `net:*` namespace into:
- `os:unix-socket` and `os:unix-server` (OS-level IPC)
- `net:tcp-connection` and `net:tcp-server` (network communication)

**Pattern to follow:** FetchAnalyzer (ANALYSIS) → HTTPConnectionEnricher (ENRICHMENT)

**Critical improvements from v2:**
1. **Semantic clarity:** Unix sockets are OS IPC, not network
2. **Namespace alignment:** `os:` for IPC, `net:` for TCP (follows existing `net:request`, `net:stdio` patterns)
3. **Side-effect tracking:** Must add `|| ns === 'os'` to `isSideEffectType()` helper
4. **Enricher metadata:** Only creates `INTERACTS_WITH` edges (analyzer creates `CONTAINS`)
5. **Complexity verified:** Analyzer iterates M modules (bounded), enricher iterates C × S (small sets)
6. **Test fixture:** Using `10-socket-connections` (next available number)
7. **Scope:** V1 covers direct `net.*` calls only (documented limitation)

## Architecture Overview

### Two-Phase Pattern

**Phase 1: ANALYSIS** - SocketAnalyzer detects socket operations and creates nodes
**Phase 2: ENRICHMENT** - SocketConnectionEnricher links clients to servers by matching paths/ports

This matches the existing HTTP pattern:
- FetchAnalyzer creates `http:request` nodes
- HTTPConnectionEnricher creates `INTERACTS_WITH` edges between requests and routes

### Node Types

**`os:unix-socket`** (Unix domain socket client, OS IPC)
- Protocol: `unix`
- Path: e.g., `/tmp/app.sock`, `.grafema/rfdb.sock`
- Library: `net`, `ipc`, or custom wrapper
- Side-effect: YES (performs IPC)

**`os:unix-server`** (Unix domain socket server, OS IPC listener)
- Protocol: `unix`
- Path: e.g., `/tmp/app.sock`
- Server options extracted from AST
- Side-effect: YES (creates listening socket)

**`net:tcp-connection`** (TCP socket client, network communication)
- Protocol: `tcp`
- Host: e.g., `localhost`, `127.0.0.1`
- Port: number
- Library: `net` or custom wrapper
- Side-effect: YES (performs network I/O)

**`net:tcp-server`** (TCP socket server, network listener)
- Protocol: `tcp`
- Host: e.g., `localhost`, `0.0.0.0`
- Port: number
- Backlog: optional server backlog option
- Side-effect: YES (creates listening socket)

**Namespace rationale:**
- `os:*` for Unix domain sockets: OS-level IPC mechanism, not network
- `net:*` for TCP sockets: network communication, matches existing `net:request`, `net:stdio`
- Both are side-effects (require `isSideEffectType()` update)

### Edge Types

Use existing edge types:
- **`INTERACTS_WITH`**: `os:unix-socket` → `os:unix-server` or `net:tcp-connection` → `net:tcp-server` (same as HTTP pattern)
- **`CONTAINS`**: `MODULE` → socket node (created by analyzer)
- **`MAKES_REQUEST`**: `FUNCTION` → socket node, `CALL` → socket node (created by analyzer)

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

Creates: `os:unix-socket` node

### TCP Socket Client

```javascript
// Pattern 1: net.connect with port/host
net.connect({ port: 3000, host: 'localhost' })
net.connect(3000, 'localhost')

// Pattern 2: Socket instance
new net.Socket().connect(3000, 'localhost')
```

Creates: `net:tcp-connection` node

### Unix Socket Server

```javascript
// Pattern 1: Unix socket server
net.createServer((socket) => { ... }).listen('/tmp/app.sock')
net.createServer().listen({ path: '/tmp/app.sock' })
```

Creates: `os:unix-server` node

### TCP Socket Server

```javascript
// Pattern 1: TCP server
net.createServer().listen(3000)
net.createServer().listen({ port: 3000, host: 'localhost' })
```

Creates: `net:tcp-server` node

## Complexity Analysis (MANDATORY)

### Iteration Space Verification

**SocketAnalyzer (ANALYSIS phase):**
- **Iteration:** O(M) modules where M = number of modules in project
- **Same as:** FetchAnalyzer, DatabaseAnalyzer (all analyzers iterate modules)
- **Bounded:** Yes, M is project size (typically 100-10,000 modules)
- **Pattern:** Module-by-module iteration, NOT scanning all graph nodes
- **Verdict:** ✅ Acceptable

**SocketConnectionEnricher (ENRICHMENT phase):**
- **Iteration:** O(U × U) + O(T × T) where:
  - U = number of `os:unix-socket` nodes matched with `os:unix-server` nodes
  - T = number of `net:tcp-connection` nodes matched with `net:tcp-server` nodes
- **Expected size:** U and T are typically <100 in large projects (socket usage is sparse)
- **Worst case:** (100 × 100) + (100 × 100) = 20,000 comparisons (negligible)
- **Pattern:** Separate matching passes for Unix and TCP, each iterating SMALL sets
- **Verdict:** ✅ Acceptable

**No brute-force scanning:** Neither plugin iterates over all graph nodes. Analyzer extends existing module iteration (reuses JSModuleIndexer pass). Enricher queries only specific node types.

**Plugin Architecture Check:**
- ✅ Forward registration: Analyzer declares `creates: { nodes: ['os:unix-socket', 'os:unix-server', 'net:tcp-connection', 'net:tcp-server'] }`
- ✅ Extends existing iteration: Reuses module iteration from JSModuleIndexer
- ✅ Extensible: Adding new socket libraries (e.g., IPC wrappers) requires only pattern updates in analyzer

## Implementation Plan

### Step 1: Define Node Types in Types Package

**File:** `/Users/vadim/grafema-worker-9/packages/types/src/nodes.ts`

Add to `NAMESPACED_TYPE` (around line 79):
```typescript
// OS-level IPC (Unix domain sockets)
OS_UNIX_SOCKET: 'os:unix-socket',
OS_UNIX_SERVER: 'os:unix-server',

// Network - TCP Sockets
NET_TCP_CONNECTION: 'net:tcp-connection',
NET_TCP_SERVER: 'net:tcp-server',
```

Add node record interfaces (after existing net types):
```typescript
// Unix domain socket client (OS IPC)
export interface OsUnixSocketNodeRecord extends BaseNodeRecord {
  type: 'os:unix-socket';
  protocol: 'unix';
  path: string;              // Unix socket path (required)
  library: string;           // 'net', 'ipc', custom
}

// Unix domain socket server (OS IPC listener)
export interface OsUnixServerNodeRecord extends BaseNodeRecord {
  type: 'os:unix-server';
  protocol: 'unix';
  path: string;              // Unix socket path (required)
  backlog?: number;          // Server backlog option
}

// TCP socket connection (network client)
export interface NetTcpConnectionNodeRecord extends BaseNodeRecord {
  type: 'net:tcp-connection';
  protocol: 'tcp';
  host?: string;             // TCP host (defaults to 'localhost')
  port: number;              // TCP port (required)
  library: string;           // 'net', custom wrapper
}

// TCP socket server (network listener)
export interface NetTcpServerNodeRecord extends BaseNodeRecord {
  type: 'net:tcp-server';
  protocol: 'tcp';
  host?: string;             // TCP host (defaults to 'localhost')
  port: number;              // TCP port (required)
  backlog?: number;          // Server backlog option
}
```

Add to `NodeRecord` union type at end of file:
```typescript
export type NodeRecord =
  // ... existing types
  | OsUnixSocketNodeRecord
  | OsUnixServerNodeRecord
  | NetTcpConnectionNodeRecord
  | NetTcpServerNodeRecord
  // ... rest
```

**Update `isSideEffectType()` helper:**

Find the function (typically around line 200) and add `os` namespace:
```typescript
export function isSideEffectType(ns: string): boolean {
  return ns === 'http' || ns === 'database' || ns === 'net' || ns === 'os';
}
```

Both `net:tcp-*` and `os:unix-*` nodes are side-effects (I/O operations).

### Step 2: Create SocketAnalyzer (ANALYSIS Phase)

**File:** `/Users/vadim/grafema-worker-9/packages/core/src/plugins/analysis/SocketAnalyzer.ts`

**Structure:** Follow FetchAnalyzer pattern exactly.

```typescript
/**
 * SocketAnalyzer - detects socket connections (Unix/TCP) via Node.js net module
 *
 * Patterns:
 * - net.connect({ path: '/tmp/app.sock' }) → os:unix-socket
 * - net.createConnection(port, host) → net:tcp-connection
 * - net.createServer().listen(path) → os:unix-server
 * - new net.Socket().connect(...) → os:unix-socket or net:tcp-connection
 *
 * Node type selection:
 * - Unix domain socket: path string → os:unix-socket or os:unix-server
 * - TCP socket: port number and host → net:tcp-connection or net:tcp-server
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
        nodes: ['os:unix-socket', 'os:unix-server', 'net:tcp-connection', 'net:tcp-server'],
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
    //   - net.connect() → determine Unix vs TCP based on args
    //   - net.createConnection() → determine Unix vs TCP based on args
    //   - net.createServer() → determine Unix vs TCP based on listen() args
    //   - new net.Socket() → determine Unix vs TCP based on connect() args
  }

  // Helper methods:
  private extractSocketPath(arg): string | null
  private extractPortHost(args): { port?: number; host?: string }
  private isUnixSocket(args): boolean
  private isTcpSocket(args): boolean
  private detectClientProtocol(args): 'unix' | 'tcp'
  private detectServerProtocol(listenArgs): 'unix' | 'tcp'
}
```

**AST Pattern Detection Logic:**

1. **Client connections** (CallExpression):
   - `callee.type === 'MemberExpression'`
   - `callee.object.name === 'net'`
   - `callee.property.name === 'connect' || 'createConnection'`
   - Determine protocol:
     - If `path` property exists or first arg is string → `os:unix-socket`
     - If `port` property exists or args include port/host → `net:tcp-connection`

2. **Server listeners** (CallExpression):
   - Pattern: `net.createServer(...).listen(...)`
   - Detect chained method calls
   - Extract listen() argument (path or port)
   - Determine protocol:
     - If path string → `os:unix-server`
     - If port number → `net:tcp-server`

3. **Socket constructor** (NewExpression):
   - `callee.type === 'Identifier'`
   - `callee.name === 'Socket'`
   - Check for `.connect()` call on result
   - Determine protocol based on connect args

**Metadata extraction:**
- For Unix: extract string literal path from first arg or `{ path: '...' }`
- For TCP: extract port (number), host (string) from args or options object
- Handle both positional args and options object: `net.connect(3000, 'localhost')` vs `net.connect({ port: 3000, host: 'localhost' })`

**Edge creation (in analyzer):**
- `CONTAINS`: `MODULE` → socket node (all types)
- `MAKES_REQUEST`: `FUNCTION` → socket node, `CALL` → socket node (all types)

### Step 3: Create SocketConnectionEnricher (ENRICHMENT Phase)

**File:** `/Users/vadim/grafema-worker-9/packages/core/src/plugins/enrichment/SocketConnectionEnricher.ts`

**Structure:** Follow HTTPConnectionEnricher pattern exactly, with separate matching for Unix and TCP.

```typescript
/**
 * SocketConnectionEnricher - links socket clients to servers
 *
 * Creates INTERACTS_WITH edges by matching:
 * - Unix sockets: os:unix-socket → os:unix-server by path equality
 * - TCP sockets: net:tcp-connection → net:tcp-server by port + host equality
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
    // 1. Query all os:unix-socket nodes and os:unix-server nodes
    // 2. Match Unix clients to servers by path
    // 3. Query all net:tcp-connection nodes and net:tcp-server nodes
    // 4. Match TCP clients to servers by port/host
    // 5. Create INTERACTS_WITH edges for all matches
  }

  private matchUnixSockets(client, server): boolean {
    // Normalize paths (resolve relative, strip trailing /)
    // Handle template literals: '.grafema/rfdb.sock' vs `${projectPath}/.grafema/rfdb.sock`
    // Exact path match after normalization
  }

  private matchTcpSockets(client, server): boolean {
    // Match port (required)
    // Match host (default 'localhost' if missing)
    // Handle wildcard host '0.0.0.0' (future version)
  }
}
```

**Matching logic:**

Unix sockets (`os:unix-socket` ↔ `os:unix-server`):
- Exact path match after normalization
- Handle relative vs absolute paths
- Consider path variables (template literals → mark as dynamic, skip matching)

TCP sockets (`net:tcp-connection` ↔ `net:tcp-server`):
- Port must match exactly
- Host defaults to 'localhost' if not specified
- Consider host='0.0.0.0' (all interfaces) → matches any client host (future version)

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
    // Assert os:unix-socket node exists with path='/tmp/app.sock'
  });

  it('detects TCP socket client (net.connect with port/host)', async () => {
    // Setup test project with net.connect(3000, 'localhost')
    // Assert net:tcp-connection node exists with port=3000, host='localhost'
  });

  it('detects Unix socket server (net.createServer().listen(path))', async () => {
    // Setup test project with net.createServer().listen('/tmp/app.sock')
    // Assert os:unix-server node exists with path='/tmp/app.sock'
  });

  it('detects TCP socket server (net.createServer().listen(port))', async () => {
    // Assert net:tcp-server node exists with port=3000
  });

  it('creates MAKES_REQUEST edge from CALL to os:unix-socket', async () => {
    // Verify edge exists: CALL (net.connect) → os:unix-socket
  });

  it('creates MAKES_REQUEST edge from FUNCTION to net:tcp-connection', async () => {
    // Verify edge exists: FUNCTION → net:tcp-connection
  });
});
```

**Create enricher test:** `/Users/vadim/grafema-worker-9/test/unit/plugins/enrichment/SocketConnectionEnricher.test.js`

Follow pattern from `HTTPConnectionEnricher.test.js`:

```javascript
describe('SocketConnectionEnricher', () => {
  it('links Unix socket client to server by path', async () => {
    // Client: net.connect({ path: '/tmp/app.sock' }) → os:unix-socket
    // Server: net.createServer().listen('/tmp/app.sock') → os:unix-server
    // Assert: INTERACTS_WITH edge exists
  });

  it('links TCP socket client to server by port/host', async () => {
    // Client: net.connect(3000, 'localhost') → net:tcp-connection
    // Server: net.createServer().listen(3000) → net:tcp-server
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

  it('matches TCP client to server with default host', async () => {
    // Client: net.connect(3000) (no host, defaults to 'localhost')
    // Server: net.createServer().listen(3000)
    // Assert: INTERACTS_WITH edge exists
  });
});
```

**Test fixtures:**

Create `/Users/vadim/grafema-worker-9/test/fixtures/10-socket-connections/`:

```
10-socket-connections/
├── package.json
├── unix-client.js        # net.connect({ path: '/tmp/app.sock' }) → os:unix-socket
├── unix-server.js        # net.createServer().listen('/tmp/app.sock') → os:unix-server
├── tcp-client.js         # net.connect(3000, 'localhost') → net:tcp-connection
└── tcp-server.js         # net.createServer().listen(3000) → net:tcp-server
```

### Step 6: Dogfooding Validation

**Goal:** Grafema's own RFDB socket connection should appear in graph with correct namespace.

**Validation steps:**

1. Run analysis on Grafema project itself: `node packages/cli/dist/cli.js analyze`

2. Query for Grafema's RFDB socket connection:
   ```bash
   node packages/cli/dist/cli.js query -d "
     unix_socket(id, path, file) :-
       node(id, 'os:unix-socket', _),
       attr(id, 'path', path),
       attr(id, 'file', file),
       path ~ '.grafema/rfdb.sock'.
   "
   ```

3. Expected result:
   - `os:unix-socket` node in `RFDBServerBackend.ts` (NOT `net:connection`)
   - Path: `.grafema/rfdb.sock` (or absolute path)
   - Type: `os:unix-socket` (OS namespace, not net)

4. Check for enrichment edge:
   ```bash
   # Find INTERACTS_WITH edge linking client to server (if server is in codebase)
   node packages/cli/dist/cli.js query -d "
     connection(client, server) :-
       edge(client, server, 'INTERACTS_WITH'),
       node(client, 'os:unix-socket', _),
       node(server, 'os:unix-server', _).
   "
   ```

**Note:** Grafema codebase contains the client side (RFDBServerBackend), but the RFDB server is a separate Rust process. We'll detect the client connection with the CORRECT namespace (`os:unix-socket`), but won't find a matching server in the JS codebase (expected).

## Edge Cases & Considerations

1. **Dynamic paths** (template literals with variables):
   - Mark as `dynamicPath: true` in metadata
   - Skip enrichment matching (can't resolve statically)

2. **IPC vs Unix domain sockets**:
   - Node.js uses same API for both
   - Treat uniformly as `protocol: 'unix'`, type `os:unix-socket` / `os:unix-server`

3. **IPv4 vs IPv6**:
   - Store host as-is, don't normalize
   - Match exactly (e.g., '127.0.0.1' !== 'localhost')

4. **Server wildcard host** (`0.0.0.0`):
   - Future: could match any client host
   - V1: require exact match, document limitation

5. **Multiple servers on same path/port**:
   - Create multiple socket server nodes (different files/lines)
   - Enricher creates edge to first match only (consistent with HTTP pattern)

## V1 Scope & Limitations

**In scope:**
- Direct `net.*` calls only: `net.connect()`, `net.createConnection()`, `net.createServer()`
- Static paths and ports (string literals, number literals)
- Options objects with resolvable properties
- Protocol detection: Unix domain sockets (OS namespace) vs TCP (net namespace)

**Out of scope (documented limitations):**
- Custom wrappers around net module (e.g., library-specific socket classes)
- Dynamic paths/ports from variables/config
- Server wildcard host matching (`0.0.0.0` → any client)

**Limitation documentation:** Add to enricher JSDoc and error messages.

## Dependencies & Order

**Plugin execution order:**
1. JSModuleIndexer (provides MODULE nodes)
2. JSASTAnalyzer (provides FUNCTION, CALL nodes)
3. **SocketAnalyzer** (creates os:unix-socket, os:unix-server, net:tcp-connection, net:tcp-server)
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

**Risk 5:** Namespace split adds complexity to analyzer
- **Mitigation:** Clear protocol detection logic, comprehensive tests cover both paths

## Acceptance Criteria Validation

- [x] Node types defined in types package (split into `os:*` and `net:*` namespaces)
- [x] `isSideEffectType()` updated to include `os` namespace
- [x] SocketAnalyzer detects all patterns and creates correct node types
- [x] SocketConnectionEnricher links client ↔ server (separate logic for Unix/TCP)
- [x] Tests cover Unix socket, TCP socket, server patterns, and protocol detection
- [x] Dogfooding: Grafema's RFDB socket connection visible with `os:unix-socket` type
- [x] Plugin registration in BUILTIN_PLUGINS
- [x] Complexity analysis verified (M modules, U×U + T×T enrichment)
- [x] Enricher metadata correct (only INTERACTS_WITH, no CONTAINS)

## Files to Create/Modify Summary

**New files:**
1. `/Users/vadim/grafema-worker-9/packages/core/src/plugins/analysis/SocketAnalyzer.ts` (~400 lines, based on FetchAnalyzer)
2. `/Users/vadim/grafema-worker-9/packages/core/src/plugins/enrichment/SocketConnectionEnricher.ts` (~200 lines, based on HTTPConnectionEnricher)
3. `/Users/vadim/grafema-worker-9/test/unit/SocketAnalyzer.test.js` (~300 lines)
4. `/Users/vadim/grafema-worker-9/test/unit/plugins/enrichment/SocketConnectionEnricher.test.js` (~200 lines)
5. `/Users/vadim/grafema-worker-9/test/fixtures/10-socket-connections/` (5 files)

**Modified files:**
1. `/Users/vadim/grafema-worker-9/packages/types/src/nodes.ts` (+80 lines: node types using `os:*` and `net:*`, interfaces, `isSideEffectType()` update)
2. `/Users/vadim/grafema-worker-9/packages/cli/src/commands/analyze.ts` (+4 lines: imports, BUILTIN_PLUGINS entries)
3. `/Users/vadim/grafema-worker-9/packages/core/src/index.ts` (+2 lines: exports)

**Total LOC estimate:** ~1,250 lines (analyzer ~400, enricher ~200, tests ~500, types ~80, fixtures ~70)

## Timeline Estimate

- Step 1 (Types): 30 min
- Step 2 (SocketAnalyzer): 3 hours (based on FetchAnalyzer complexity)
- Step 3 (SocketConnectionEnricher): 2 hours (simpler than analyzer)
- Step 4 (Plugin registration): 15 min
- Step 5 (Tests): 2 hours (critical for correctness)
- Step 6 (Dogfooding validation): 30 min

**Total: 8-9 hours** (1 day of focused work)

## Key Changes from v2 to v3

| Aspect | v2 | v3 |
|--------|----|----|
| **Unix socket type** | `net:connection` + protocol field | `os:unix-socket` (dedicated type) |
| **Unix server type** | `net:server` + protocol field | `os:unix-server` (dedicated type) |
| **TCP client type** | `net:connection` + protocol field | `net:tcp-connection` (dedicated type) |
| **TCP server type** | `net:server` + protocol field | `net:tcp-server` (dedicated type) |
| **Namespace semantics** | All sockets in `net:*` | OS IPC in `os:*`, TCP in `net:*` |
| **Side-effect check** | Only `net` namespace | `net` + `os` namespaces |
| **Enricher matching** | Unified by protocol field | Separate Unix/TCP matching logic |
| **Dogfooding validation** | Detects socket as `net:connection` | Detects socket as `os:unix-socket` |

This separation provides **semantic clarity**: Unix domain sockets are OS-level IPC, not network communication, and the graph now reflects this distinction.

## Next Steps

After plan approval:
1. Uncle Bob reviews this plan for file-level concerns
2. Kent writes tests (parallel with Rob)
3. Rob implements SocketAnalyzer and SocketConnectionEnricher with correct namespace split
4. Validate dogfooding: Grafema's own socket connection visible in graph with `os:unix-socket` type
5. Auto-review checks completeness and namespace correctness

---

**Sources:**
- [Babel AST Specification](https://github.com/babel/babel/blob/main/packages/babel-parser/ast/spec.md)
- [Understanding ASTs by Building Your Own Babel Plugin](https://www.sitepoint.com/understanding-asts-building-babel-plugin/)
- [Node.js Net Module Documentation](https://nodejs.org/api/net.html)
- [Babel Types API](https://babeljs.io/docs/babel-types)

# REG-109: NetworkRequestNode Factory - Add Singleton Node for net:request

**Tech Lead Analysis by Don Melton**
**Date:** 2025-01-22

---

## 1. Executive Summary

This task requires creating a **new singleton node factory class** (`NetworkRequestNode`) for the `net:request` node type. This is NOT the same as `HttpRequestNode`, which represents individual HTTP request call sites.

**Key Distinction:**
- `net:request` → Singleton node representing the external network as a system resource (like `net:stdio`)
- `http:request` (HTTP_REQUEST) → Individual HTTP request call sites (fetch, axios, etc.)

**Verdict: We need a NEW NetworkRequestNode class, following the ExternalStdioNode singleton pattern.**

---

## 2. Architecture Analysis: Two Different Node Types

### 2.1 Current State - Type Confusion

There are **TWO distinct node types** for network operations:

| Type | Purpose | Example ID | Cardinality | Existing Factory |
|------|---------|-----------|-------------|-----------------|
| `net:request` | External network singleton | `net:request#__network__` | 1 per graph | **MISSING** |
| `http:request` (HTTP_REQUEST) | Individual HTTP call sites | `{file}:HTTP_REQUEST:GET:42:0` | Many | HttpRequestNode ✓ |

### 2.2 HttpRequestNode - NOT for net:request

**Location:** `/packages/core/src/core/nodes/HttpRequestNode.ts`

```typescript
export class HttpRequestNode {
  static readonly TYPE = 'HTTP_REQUEST' as const;  // ← NOT 'net:request'

  static create(
    url: string | undefined,
    method: string | undefined,
    file: string,
    line: number,
    options: HttpRequestNodeOptions = {}
  ): HttpRequestNodeRecord {
    // Creates nodes like: /path/file.ts:HTTP_REQUEST:GET:42:0
    const id = `${file}:HTTP_REQUEST:${httpMethod}:${line}:${options.column || 0}${counter}`;
    return {
      id,
      type: 'HTTP_REQUEST',  // ← NOT 'net:request'
      name: `${httpMethod} ${url || 'dynamic'}`,
      url,
      method: httpMethod,
      file,
      line,
      parentScopeId: options.parentScopeId
    };
  }
}
```

**Purpose:** Represents individual HTTP request call sites in source code.
- Each fetch(), axios.get(), etc. creates one HttpRequestNode
- Has file, line, column, url, method
- Used for tracking which functions make which requests

### 2.3 net:request - Missing Singleton Node

**Purpose:** Represents the **external network** as a system resource (like net:stdio represents console I/O).

**Current inline creation** (GraphBuilder.ts:651-657):
```typescript
const networkId = 'net:request#__network__';

if (!this._createdSingletons.has(networkId)) {
  this._bufferNode({
    id: networkId,
    type: 'net:request',  // ← This is the singleton type
    name: '__network__'
  });
  this._createdSingletons.add(networkId);
}
```

**Graph structure:**
```
HTTP_REQUEST nodes → (CALLS edge) → net:request singleton → (represents) → External Network
```

**Analogy with net:stdio:**
- `net:stdio` = singleton for console.log/error (stdin/stdout/stderr)
- `net:request` = singleton for HTTP network (outbound requests)

Both are **external system resources**, not source code entities.

---

## 3. The RIGHT Pattern: ExternalStdioNode

### 3.1 Reference Implementation

**Location:** `/packages/core/src/core/nodes/ExternalStdioNode.ts`

```typescript
export class ExternalStdioNode {
  static readonly TYPE = 'EXTERNAL_STDIO' as const;
  static readonly SINGLETON_ID = 'EXTERNAL_STDIO:__stdio__';

  static readonly REQUIRED = ['name', 'file'] as const;
  static readonly OPTIONAL = [] as const;

  static create(): ExternalStdioNodeRecord {
    return {
      id: this.SINGLETON_ID,
      type: this.TYPE,
      name: '__stdio__',
      file: '__builtin__',
      line: 0
    };
  }

  static validate(node: ExternalStdioNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    if (node.id !== this.SINGLETON_ID) errors.push(`Invalid singleton ID`);
    return errors;
  }
}
```

**Key characteristics:**
1. **Singleton ID** - constant, no parameters
2. **No create parameters** - singleton is always the same
3. **Built-in file** - `__builtin__`, not a source file
4. **Type validation** - ensures singleton ID consistency

### 3.2 NodeKind.ts Type System

**Location:** `/packages/core/src/core/nodes/NodeKind.ts:81-82`

```typescript
export const NAMESPACED_TYPE = {
  // Network
  NET_REQUEST: 'net:request',
  NET_STDIO: 'net:stdio',
  // ...
} as const;
```

Both types are in the same category: **Network namespaced types**.

---

## 4. Critical Decision: New NetworkRequestNode vs Reuse HttpRequestNode

### Option A: Reuse HttpRequestNode (WRONG)

**Why this is wrong:**
1. **Type mismatch** - HttpRequestNode creates `type: 'HTTP_REQUEST'`, not `type: 'net:request'`
2. **Semantic mismatch** - HttpRequestNode is for call sites (file+line), not system resources
3. **ID format mismatch** - HttpRequestNode uses `{file}:HTTP_REQUEST:{method}:{line}`, not `net:request#__network__`
4. **Parameter mismatch** - HttpRequestNode requires url, method, file, line; singleton has none
5. **Breaks the graph model** - net:request is a DESTINATION for HTTP_REQUEST nodes, not another call site

### Option B: Create NetworkRequestNode (RIGHT)

**Why this is right:**
1. **Follows ExternalStdioNode pattern** - same semantic category (external system resource)
2. **Type correctness** - creates `type: 'net:request'` nodes
3. **Singleton pattern** - no parameters, always the same node
4. **Graph model alignment** - net:request and net:stdio are architectural peers
5. **Separation of concerns** - call sites (HTTP_REQUEST) vs system resources (net:request)

**Architectural alignment:**
```
Source Code Nodes          System Resource Singletons
─────────────────          ──────────────────────────
HTTP_REQUEST (many)   →    net:request (1)
console.log (many)    →    net:stdio (1)
db.query (many)       →    db:connection (1)
fs.readFile (many)    →    fs:operations (1)
```

---

## 5. Implementation Plan

### Phase 1: Create NetworkRequestNode (following ExternalStdioNode pattern)

**Create:** `/packages/core/src/core/nodes/NetworkRequestNode.ts`

```typescript
/**
 * NetworkRequestNode - contract for NET_REQUEST singleton node
 *
 * Represents the external network as a system resource.
 * All HTTP_REQUEST nodes connect to this singleton via CALLS edges.
 */

import type { BaseNodeRecord } from '@grafema/types';

interface NetworkRequestNodeRecord extends BaseNodeRecord {
  type: 'NET_REQUEST';
}

export class NetworkRequestNode {
  static readonly TYPE = 'NET_REQUEST' as const;
  static readonly SINGLETON_ID = 'net:request#__network__';

  static readonly REQUIRED = ['name', 'file'] as const;
  static readonly OPTIONAL = [] as const;

  /**
   * Create NET_REQUEST singleton node
   *
   * This node represents the external network as a system resource.
   * All HTTP_REQUEST nodes connect to this singleton via CALLS edges.
   *
   * @returns NetworkRequestNodeRecord - singleton node
   */
  static create(): NetworkRequestNodeRecord {
    return {
      id: this.SINGLETON_ID,
      type: this.TYPE,
      name: '__network__',
      file: '__builtin__',
      line: 0
    };
  }

  static validate(node: NetworkRequestNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) errors.push(`Expected type ${this.TYPE}`);
    if (node.id !== this.SINGLETON_ID) errors.push(`Invalid singleton ID`);
    return errors;
  }
}

export type { NetworkRequestNodeRecord };
```

**Key decisions:**
- ID: `net:request#__network__` (matches current inline creation)
- Type: `'NET_REQUEST'` (matches NodeKind.NET_REQUEST)
- No parameters (singleton)
- file: `__builtin__` (not a source file)
- line: 0 (not from source code)

### Phase 2: Update NodeFactory

**File:** `/packages/core/src/core/NodeFactory.ts`

**Changes:**
1. Import NetworkRequestNode
2. Add createNetworkRequest() method
3. Add to validators

```typescript
// Add to imports (line ~28)
import {
  // ...
  ExternalStdioNode,
  NetworkRequestNode,  // ← ADD
  // ...
} from './nodes/index.js';

// Add factory method (after createExternalStdio, line ~311)
/**
 * Create NET_REQUEST singleton node
 *
 * This node represents the external network as a system resource.
 * Should be created once per graph.
 */
static createNetworkRequest() {
  return NetworkRequestNode.create();
}

// Add to validators (line ~485)
const validators = {
  // ...
  'EXTERNAL_STDIO': ExternalStdioNode,
  'NET_REQUEST': NetworkRequestNode,  // ← ADD
  // ...
};
```

### Phase 3: Update nodes/index.ts

**File:** `/packages/core/src/core/nodes/index.ts`

```typescript
export { NetworkRequestNode, type NetworkRequestNodeRecord } from './NetworkRequestNode.js';
```

### Phase 4: Migrate GraphBuilder.bufferHttpRequests()

**File:** `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Current code (lines 647-658):**
```typescript
private bufferHttpRequests(httpRequests: HttpRequestInfo[], functions: FunctionInfo[]): void {
  if (httpRequests.length > 0) {
    const networkId = 'net:request#__network__';

    if (!this._createdSingletons.has(networkId)) {
      this._bufferNode({
        id: networkId,
        type: 'net:request',
        name: '__network__'
      });
      this._createdSingletons.add(networkId);
    }
    // ... rest of method
  }
}
```

**Migrated code:**
```typescript
// Add import at top of file
import { NetworkRequestNode } from '../../../core/nodes/NetworkRequestNode.js';

private bufferHttpRequests(httpRequests: HttpRequestInfo[], functions: FunctionInfo[]): void {
  if (httpRequests.length > 0) {
    // Create NET_REQUEST singleton using factory
    const networkNode = NetworkRequestNode.create();

    if (!this._createdSingletons.has(networkNode.id)) {
      this._bufferNode(networkNode as unknown as GraphNode);
      this._createdSingletons.add(networkNode.id);
    }

    // Use networkNode.id instead of hardcoded networkId
    for (const request of httpRequests) {
      const { parentScopeId, ...requestData } = request;

      this._bufferNode(requestData as GraphNode);

      this._bufferEdge({
        type: 'CALLS',
        src: request.id,
        dst: networkNode.id  // ← Use networkNode.id
      });

      // ... rest of loop
    }
  }
}
```

**Important:** This migration does NOT touch HttpRequestNode or HTTP_REQUEST nodes. Those are separate entities representing individual call sites.

### Phase 5: Update Other Inline Creations

**Search for other inline net:request creations:**

From grep results, found in:
- `/packages/core/src/plugins/analysis/ExpressAnalyzer.ts:84-90` - creates net:request inline

**File:** `/packages/core/src/plugins/analysis/ExpressAnalyzer.ts`

**Current code (lines 83-90):**
```typescript
// Создаём net:request ноду (дедупликация в GraphBackend)
const networkId = 'net:request#__network__';
await graph.addNode({
  id: networkId,
  type: 'net:request',
  name: '__network__',
  description: 'External HTTP network'
});
```

**Migrated code:**
```typescript
// Add import
import { NetworkRequestNode } from '../../core/nodes/NetworkRequestNode.js';

// Replace inline creation
const networkNode = NetworkRequestNode.create();
await graph.addNode(networkNode);
```

**Note:** The description field is NOT part of NetworkRequestNode contract. If needed, extend the node record.

---

## 6. Test Strategy (Kent Beck)

### 6.1 Unit Tests for NetworkRequestNode

**Create:** `/test/unit/NetworkRequestNode.test.js`

Tests:
1. **Singleton ID consistency** - NetworkRequestNode.SINGLETON_ID === 'net:request#__network__'
2. **Type correctness** - node.type === 'NET_REQUEST'
3. **Built-in file** - node.file === '__builtin__'
4. **No parameters** - create() takes no arguments
5. **Validation** - validate() rejects wrong type or ID

### 6.2 Integration Tests

**Create:** `/test/unit/NetworkRequestNodeMigration.test.js`

Tests:
1. **GraphBuilder creates singleton** - bufferHttpRequests creates one net:request node
2. **CALLS edges** - HTTP_REQUEST nodes connect to net:request singleton
3. **Singleton deduplication** - multiple HTTP requests share one net:request node
4. **ExpressAnalyzer creates singleton** - Express analysis creates net:request

### 6.3 Existing Tests

**Verify:** Existing HTTP request tests still pass
- HTTP_REQUEST nodes still created correctly
- Type remains 'HTTP_REQUEST', not 'NET_REQUEST'
- Individual call sites tracked properly

---

## 7. Architectural Concerns

### 7.1 Type System Clarity

**Problem:** The type system has overlapping names that could confuse:
- `net:request` (singleton system resource)
- `http:request` / `HTTP_REQUEST` (individual call sites)

**Resolution:** Documentation must clearly distinguish:
```
net:request    → External network (singleton, no source location)
HTTP_REQUEST   → HTTP call site (many, with file+line)
```

**Follow-up:** Consider renaming for clarity?
- `net:request` → `net:external` or `EXTERNAL_NETWORK`?
- Discuss with user if this causes confusion in queries

### 7.2 NodeKind Type Names

**Current:**
```typescript
export const NAMESPACED_TYPE = {
  NET_REQUEST: 'net:request',      // ← singleton
  // vs
  HTTP_REQUEST: 'http:request',    // ← call sites
} as const;
```

**Potential confusion:** The names suggest they're related, but they're architecturally different:
- `net:request` is in same category as `net:stdio` (system resources)
- `HTTP_REQUEST` is in same category as `METHOD_CALL` (source code call sites)

**Recommendation:** Accept this as-is. The namespace distinction (net: vs no namespace) provides enough separation. The node contracts enforce correct usage.

### 7.3 Description Field

**Issue:** ExpressAnalyzer adds a `description` field:
```typescript
description: 'External HTTP network'
```

But NetworkRequestNode contract doesn't include this field.

**Options:**
1. **Ignore description** - not part of contract, backends may drop it
2. **Add to contract** - extend NetworkRequestNodeRecord with optional description
3. **Remove from ExpressAnalyzer** - stick to minimal contract

**Decision:** Option 1 (Ignore) for now. Description is not query-critical. If needed later, extend the contract.

### 7.4 Storage Layer Validation

**File:** `/packages/core/src/storage/backends/typeValidation.ts:25`

```typescript
'net:request', 'net:stdio',
```

**File:** `/packages/core/src/validation/PathValidator.ts:205`

```typescript
'net:request', 'EXTERNAL_NETWORK',
```

**Action:** Verify these validators accept NetworkRequestNode output. No changes expected, but confirm in tests.

---

## 8. Files to Create/Modify

### Create:
1. `/packages/core/src/core/nodes/NetworkRequestNode.ts` - New singleton node factory
2. `/test/unit/NetworkRequestNode.test.js` - Unit tests
3. `/test/unit/NetworkRequestNodeMigration.test.js` - Integration tests

### Modify:
1. `/packages/core/src/core/nodes/index.ts` - Export NetworkRequestNode
2. `/packages/core/src/core/NodeFactory.ts` - Add createNetworkRequest() and validator
3. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Migrate bufferHttpRequests()
4. `/packages/core/src/plugins/analysis/ExpressAnalyzer.ts` - Migrate inline creation

### Verify (no changes expected):
1. `/packages/core/src/core/nodes/HttpRequestNode.ts` - Unchanged (different node type)
2. `/packages/core/src/storage/backends/typeValidation.ts` - Should accept new nodes
3. `/packages/core/src/validation/PathValidator.ts` - Should validate new IDs

---

## 9. Definition of Done

### Code Changes:
- [x] NetworkRequestNode class created following ExternalStdioNode pattern
- [x] NodeFactory.createNetworkRequest() added
- [x] GraphBuilder.bufferHttpRequests() migrated
- [x] ExpressAnalyzer migrated
- [x] No inline `type: 'net:request'` object literals remain

### Tests:
- [x] NetworkRequestNode.test.js passes (unit tests)
- [x] NetworkRequestNodeMigration.test.js passes (integration tests)
- [x] All existing HTTP request tests pass
- [x] `npm test` passes (full suite)

### Documentation:
- [x] NetworkRequestNode has clear JSDoc explaining singleton purpose
- [x] Distinction between NET_REQUEST and HTTP_REQUEST documented in code

### Graph Integrity:
- [x] net:request singleton created once per graph
- [x] HTTP_REQUEST nodes connect to net:request via CALLS edges
- [x] Storage layer accepts new nodes
- [x] Validation layer accepts new IDs

---

## 10. Verdict

**GO.** This is the RIGHT approach:

1. **Architecturally correct** - net:request is a system resource singleton, like net:stdio
2. **Type system alignment** - NET_REQUEST vs HTTP_REQUEST distinction preserved
3. **Pattern consistency** - follows ExternalStdioNode singleton pattern exactly
4. **Graph model integrity** - maintains separation between call sites and system resources
5. **No breaking changes** - HttpRequestNode unchanged, existing HTTP_REQUEST nodes unaffected

**The graph structure will be RIGHT, not just working.**

---

## 11. Technical Debt / Future Considerations

### TD-1: Type Name Clarity

**Issue:** `net:request` and `http:request` names suggest they're related, but they're architecturally different.

**Potential improvement:** Rename for clarity?
- `net:request` → `net:external` or `EXTERNAL_NETWORK`
- Would require migration of existing graphs and queries

**Priority:** Low - current naming works, just needs documentation

### TD-2: Description Field Inconsistency

**Issue:** ExpressAnalyzer adds `description` field, but NetworkRequestNode contract doesn't include it.

**Potential improvement:** Either:
1. Extend NetworkRequestNode contract with optional description
2. Remove description from ExpressAnalyzer

**Priority:** Low - description not query-critical

### TD-3: Legacy ID Format in TypeScriptVisitor

**Issue:** TypeScriptVisitor generates legacy IDs with `#` separators for many node types. Once all migrations are complete, clean up the legacy ID generation.

**Priority:** Medium - tech debt from gradual migration

### TD-4: Singleton Deduplication Pattern

**Issue:** GraphBuilder uses `_createdSingletons` Set to track singletons. This pattern is repeated across multiple methods.

**Potential improvement:** Extract singleton creation to helper method:
```typescript
private ensureSingleton(nodeRecord: GraphNode): void {
  if (!this._createdSingletons.has(nodeRecord.id)) {
    this._bufferNode(nodeRecord);
    this._createdSingletons.add(nodeRecord.id);
  }
}
```

**Priority:** Low - DRY improvement, not urgent

---

*"I don't care if it works, is it RIGHT?"* - In this case, creating NetworkRequestNode is the RIGHT solution. It maintains architectural integrity, follows established patterns, and keeps the graph model clean. HttpRequestNode is for a different purpose entirely.

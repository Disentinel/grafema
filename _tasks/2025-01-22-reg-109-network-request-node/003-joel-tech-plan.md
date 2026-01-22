# REG-109: NetworkRequestNode Factory - Technical Implementation Plan

**Implementation Planner: Joel Spolsky**
**Date:** 2025-01-22

---

## Overview

This document provides step-by-step implementation instructions for creating NetworkRequestNode following the ExternalStdioNode singleton pattern. Don's analysis is solid — this is the RIGHT approach. Now let's make it concrete.

---

## Phase 1: Create NetworkRequestNode Class

### File: `/packages/core/src/core/nodes/NetworkRequestNode.ts`

**Action:** Create new file.

**Complete file content:**

```typescript
/**
 * NetworkRequestNode - contract for NET_REQUEST singleton node
 *
 * Represents the external network as a system resource.
 * All HTTP_REQUEST nodes connect to this singleton via CALLS edges.
 *
 * This is NOT the same as HttpRequestNode (type: HTTP_REQUEST), which represents
 * individual HTTP request call sites in source code.
 *
 * Architectural role:
 * - net:request is a singleton representing external network (like net:stdio for console I/O)
 * - HTTP_REQUEST nodes are call sites that connect to this singleton via CALLS edges
 *
 * Example graph structure:
 * ```
 * /app/api.ts:HTTP_REQUEST:GET:15:0 --CALLS--> net:request#__network__
 * /app/service.ts:HTTP_REQUEST:POST:42:0 --CALLS--> net:request#__network__
 * ```
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
   * Should be created once per graph. GraphBuilder and ExpressAnalyzer
   * use singleton deduplication to ensure only one instance exists.
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

  /**
   * Validate NET_REQUEST node structure
   *
   * Ensures:
   * - type is NET_REQUEST
   * - id matches SINGLETON_ID
   *
   * @param node - Node to validate
   * @returns Array of error messages (empty if valid)
   */
  static validate(node: NetworkRequestNodeRecord): string[] {
    const errors: string[] = [];
    if (node.type !== this.TYPE) {
      errors.push(`Expected type ${this.TYPE}, got ${node.type}`);
    }
    if (node.id !== this.SINGLETON_ID) {
      errors.push(`Invalid singleton ID: expected ${this.SINGLETON_ID}, got ${node.id}`);
    }
    return errors;
  }
}

export type { NetworkRequestNodeRecord };
```

**Key implementation notes:**
- TYPE is `'NET_REQUEST'` (string literal, not type reference)
- SINGLETON_ID is `'net:request#__network__'` (matches current inline creation in GraphBuilder.ts:650 and ExpressAnalyzer.ts:84)
- file: `'__builtin__'` (not a source file)
- line: `0` (not from source code)
- No parameters to create() — singleton is always the same

---

## Phase 2: Export NetworkRequestNode

### File: `/packages/core/src/core/nodes/index.ts`

**Action:** Add export statement.

**Location:** After line 39 (after ExternalStdioNode export).

**Add this line:**

```typescript
export { NetworkRequestNode, type NetworkRequestNodeRecord } from './NetworkRequestNode.js';
```

**Result after edit:**
```typescript
// Line 39
export { ExternalStdioNode, type ExternalStdioNodeRecord } from './ExternalStdioNode.js';
export { NetworkRequestNode, type NetworkRequestNodeRecord } from './NetworkRequestNode.js';  // ← ADD
export { EventListenerNode, type EventListenerNodeRecord } from './EventListenerNode.js';
```

---

## Phase 3: Update NodeFactory

### File: `/packages/core/src/core/NodeFactory.ts`

**Action 1:** Add import.

**Location:** Line 28 (after ExternalStdioNode import).

**Change from:**
```typescript
import {
  // ... other imports
  ExternalStdioNode,
  EventListenerNode,
  // ... rest
} from './nodes/index.js';
```

**Change to:**
```typescript
import {
  // ... other imports
  ExternalStdioNode,
  NetworkRequestNode,  // ← ADD
  EventListenerNode,
  // ... rest
} from './nodes/index.js';
```

**Action 2:** Add factory method.

**Location:** After line 312 (after `createExternalStdio()` method).

**Add this method:**

```typescript
  /**
   * Create NET_REQUEST singleton node
   *
   * This node represents the external network as a system resource.
   * Should be created once per graph.
   *
   * All HTTP_REQUEST nodes connect to this singleton via CALLS edges.
   *
   * @returns NetworkRequestNodeRecord - singleton node
   */
  static createNetworkRequest() {
    return NetworkRequestNode.create();
  }
```

**Action 3:** Add validator.

**Location:** Line 484 (inside validators object, after EXTERNAL_STDIO).

**Change from:**
```typescript
    const validators: Record<string, NodeValidator> = {
      // ... other validators
      'EXTERNAL_STDIO': ExternalStdioNode,
      'EVENT_LISTENER': EventListenerNode,
      // ... rest
    };
```

**Change to:**
```typescript
    const validators: Record<string, NodeValidator> = {
      // ... other validators
      'EXTERNAL_STDIO': ExternalStdioNode,
      'NET_REQUEST': NetworkRequestNode,  // ← ADD
      'EVENT_LISTENER': EventListenerNode,
      // ... rest
    };
```

---

## Phase 4: Migrate GraphBuilder

### File: `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

**Action 1:** Add import.

**Location:** Top of file, with other imports from core/nodes.

Find the imports section and add:

```typescript
import { NetworkRequestNode } from '../../../core/nodes/NetworkRequestNode.js';
```

**Action 2:** Replace inline creation with NetworkRequestNode.create().

**Location:** Lines 648-670 (bufferHttpRequests method).

**Current code (lines 648-670):**
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

      for (const request of httpRequests) {
        const { parentScopeId, ...requestData } = request;

        this._bufferNode(requestData as GraphNode);

        this._bufferEdge({
          type: 'CALLS',
          src: request.id,
          dst: networkId
        });

        // ... rest of loop
      }
    }
  }
```

**Replace with:**
```typescript
  private bufferHttpRequests(httpRequests: HttpRequestInfo[], functions: FunctionInfo[]): void {
    if (httpRequests.length > 0) {
      // Create NET_REQUEST singleton using factory
      const networkNode = NetworkRequestNode.create();

      if (!this._createdSingletons.has(networkNode.id)) {
        this._bufferNode(networkNode as unknown as GraphNode);
        this._createdSingletons.add(networkNode.id);
      }

      for (const request of httpRequests) {
        const { parentScopeId, ...requestData } = request;

        this._bufferNode(requestData as GraphNode);

        this._bufferEdge({
          type: 'CALLS',
          src: request.id,
          dst: networkNode.id  // ← Use networkNode.id
        });

        // ... rest of loop (unchanged)
      }
    }
  }
```

**Changes explained:**
1. Replace `const networkId = 'net:request#__network__'` with `const networkNode = NetworkRequestNode.create()`
2. Replace inline object literal with `networkNode as unknown as GraphNode`
3. Replace `networkId` with `networkNode.id` (3 occurrences in this method)

**Note:** The `as unknown as GraphNode` cast is necessary because GraphNode type might not include all BaseNodeRecord fields. This matches the pattern used elsewhere in GraphBuilder.

---

## Phase 5: Migrate ExpressAnalyzer

### File: `/packages/core/src/plugins/analysis/ExpressAnalyzer.ts`

**Action 1:** Add import.

**Location:** Top of file, with other imports.

Add:
```typescript
import { NetworkRequestNode } from '../../core/nodes/NetworkRequestNode.js';
```

**Action 2:** Replace inline creation.

**Location:** Lines 83-90.

**Current code:**
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

**Replace with:**
```typescript
      // Create NET_REQUEST singleton (GraphBackend handles deduplication)
      const networkNode = NetworkRequestNode.create();
      await graph.addNode(networkNode);
```

**Changes explained:**
1. Replace inline object literal with `NetworkRequestNode.create()`
2. Remove `description` field (not part of NetworkRequestNode contract)
3. Use `networkNode` instead of `networkId`

**Important:** The `description` field is dropped because:
- It's not part of BaseNodeRecord required fields
- NetworkRequestNode contract doesn't include it
- Backends may ignore extra fields
- If needed later, extend NetworkRequestNodeRecord

**Action 3:** Update method signature and parameter passing.

**Location:** Lines 101 and 128-131.

**Change 1 - Method call (line 101):**

**Current:**
```typescript
        const result = await this.analyzeModule(module, graph, networkId);
```

**Replace with:**
```typescript
        const result = await this.analyzeModule(module, graph, networkNode.id);
```

**Change 2 - Method signature (lines 128-132):**

**Current:**
```typescript
  private async analyzeModule(
    module: NodeRecord,
    graph: PluginContext['graph'],
    networkId: string
  ): Promise<AnalysisResult> {
```

**Keep as-is** — parameter name `networkId: string` is internal to the method, can stay the same.

**Action 4:** Update edge creation.

**Location:** Line 316.

**Current:**
```typescript
        // ENDPOINT --INTERACTS_WITH--> EXTERNAL_NETWORK
        await graph.addEdge({
          type: 'INTERACTS_WITH',
          src: endpoint.id,
          dst: networkId
        });
```

**Keep as-is** — uses parameter `networkId` which receives `networkNode.id` from caller.

**Summary of all changes in ExpressAnalyzer.ts:**

1. Add import: `import { NetworkRequestNode } from '../../core/nodes/NetworkRequestNode.js';`
2. Line 83-90: Replace inline creation with `const networkNode = NetworkRequestNode.create(); await graph.addNode(networkNode);`
3. Line 101: Replace `networkId` with `networkNode.id` in method call
4. Lines 131, 316: No changes needed (internal parameter name)

---

## Phase 6: Verification Checklist

### Code Verification

**Run these grep commands to verify no inline creation remains:**

```bash
# Should find NO matches (except in comments/tests)
grep -r "type: 'net:request'" packages/core/src/plugins/analysis/

# Should find NO matches (except in comments/tests)
grep -r "'net:request#__network__'" packages/core/src/plugins/analysis/

# Should find matches only in NetworkRequestNode.ts and tests
grep -r "NetworkRequestNode.create()" packages/core/src/
```

### Type System Verification

**Verify NodeKind.ts has NET_REQUEST constant:**

```bash
# Should output: NET_REQUEST: 'net:request',
grep "NET_REQUEST:" packages/core/src/core/nodes/NodeKind.ts
```

Expected output:
```typescript
NET_REQUEST: 'net:request',
```

**Location:** `/packages/core/src/core/nodes/NodeKind.ts:81`

No changes needed — NET_REQUEST constant already exists.

---

## Phase 7: Testing Requirements

### Test File 1: Unit Tests

**Create:** `/test/unit/NetworkRequestNode.test.js`

**Purpose:** Test NetworkRequestNode.create() contract.

**Test cases to implement:**

1. **Singleton ID consistency**
   - `NetworkRequestNode.SINGLETON_ID === 'net:request#__network__'`

2. **Type correctness**
   - `node.type === 'NET_REQUEST'`

3. **Built-in file**
   - `node.file === '__builtin__'`
   - `node.line === 0`

4. **No parameters**
   - `create()` takes zero arguments

5. **Required fields present**
   - Node has id, type, name, file, line

6. **Validation rejects wrong type**
   - `validate({ ...node, type: 'WRONG' })` returns errors

7. **Validation rejects wrong ID**
   - `validate({ ...node, id: 'wrong-id' })` returns errors

8. **NodeFactory.createNetworkRequest compatibility**
   - `NodeFactory.createNetworkRequest()` produces same result as `NetworkRequestNode.create()`

9. **NodeFactory.validate passes**
   - `NodeFactory.validate(NetworkRequestNode.create())` returns no errors

**Pattern to follow:** See `/test/unit/EnumNodeMigration.test.js` for test structure.

**Key imports:**
```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { NetworkRequestNode, NodeFactory } from '@grafema/core';
```

### Test File 2: Integration Tests

**Create:** `/test/unit/NetworkRequestNodeMigration.test.js`

**Purpose:** Test GraphBuilder and ExpressAnalyzer use NetworkRequestNode.

**Test cases to implement:**

1. **GraphBuilder creates singleton**
   - Analyze file with HTTP request
   - Verify one net:request node exists
   - Verify node ID is `'net:request#__network__'`
   - Verify node type is `'NET_REQUEST'`

2. **HTTP_REQUEST connects to singleton**
   - Analyze file with fetch() call
   - Verify HTTP_REQUEST node exists
   - Verify CALLS edge from HTTP_REQUEST to net:request

3. **Singleton deduplication**
   - Analyze file with multiple HTTP requests
   - Verify only ONE net:request node exists
   - Verify multiple HTTP_REQUEST nodes all connect to same singleton

4. **No inline object literals**
   - Verify net:request node has all fields from NetworkRequestNode.create()
   - Verify file is '__builtin__'
   - Verify line is 0

**Pattern to follow:** See `/test/unit/EnumNodeMigration.test.js` lines 220-413 for integration test structure.

**Key imports:**
```javascript
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { NetworkRequestNode } from '@grafema/core';
import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
```

### Test Execution Plan

**Step 1:** Write unit tests first.

**Step 2:** Run unit tests — should PASS after Phase 1-3 complete.

```bash
node --test test/unit/NetworkRequestNode.test.js
```

**Step 3:** Write integration tests.

**Step 4:** Run integration tests — should PASS after Phase 4-5 complete.

```bash
node --test test/unit/NetworkRequestNodeMigration.test.js
```

**Step 5:** Run full test suite.

```bash
npm test
```

All tests must pass before proceeding to review phase.

---

## Implementation Order

**CRITICAL: Follow this exact order:**

1. **Phase 1** — Create NetworkRequestNode.ts
2. **Phase 2** — Export from index.ts
3. **Phase 3** — Update NodeFactory
4. **CHECKPOINT:** Write and run unit tests (NetworkRequestNode.test.js)
5. **Phase 4** — Migrate GraphBuilder
6. **Phase 5** — Migrate ExpressAnalyzer
7. **CHECKPOINT:** Write and run integration tests (NetworkRequestNodeMigration.test.js)
8. **Phase 6** — Verify with grep commands
9. **Phase 7** — Run full test suite

**DO NOT proceed to next phase until current phase is complete and verified.**

---

## Edge Cases and Gotchas

### 1. Type vs. type

**Issue:** TypeScript const `TYPE = 'NET_REQUEST'` vs. node property `type: 'NET_REQUEST'`.

**Solution:** They match. TYPE is a string literal constant, type is the property value. Both must be `'NET_REQUEST'`.

### 2. GraphNode type cast

**Issue:** GraphBuilder uses `as unknown as GraphNode` cast.

**Reason:** GraphNode type in GraphBuilder.ts might not match BaseNodeRecord exactly.

**Solution:** Use the same cast pattern as existing singleton creation code. This is safe because:
- NetworkRequestNode.create() returns valid BaseNodeRecord
- GraphBackend accepts all BaseNodeRecord fields
- Cast is only for TypeScript compiler

### 3. Description field in ExpressAnalyzer

**Issue:** Current code adds `description: 'External HTTP network'`.

**Decision:** Drop it. Not part of NetworkRequestNode contract.

**Rationale:**
- BaseNodeRecord has `metadata?: Record<string, unknown>` for arbitrary data
- If description is needed, add to metadata: `metadata: { description: '...' }`
- But Don's analysis says it's not query-critical, so we drop it for now
- If user needs it later, extend NetworkRequestNodeRecord

### 4. Singleton deduplication

**Pattern:** Both GraphBuilder and ExpressAnalyzer use singleton tracking:

```typescript
if (!this._createdSingletons.has(networkNode.id)) {
  // create node
  this._createdSingletons.add(networkNode.id);
}
```

**Important:** Don't remove this pattern. Backend also deduplicates, but this pattern prevents redundant buffer operations.

### 5. NET_REQUEST vs. HTTP_REQUEST confusion

**Critical distinction:**
- `NET_REQUEST` (type for net:request singleton) — external network resource
- `HTTP_REQUEST` (type for individual call sites) — source code locations

**DO NOT confuse these types.** They are architecturally different:
- NET_REQUEST: 1 per graph, no source location
- HTTP_REQUEST: many per graph, each has file+line

### 6. Import path for GraphBuilder

**Correct import:**
```typescript
import { NetworkRequestNode } from '../../../core/nodes/NetworkRequestNode.js';
```

**Why triple `../`?**
- GraphBuilder is in: `packages/core/src/plugins/analysis/ast/`
- NetworkRequestNode is in: `packages/core/src/core/nodes/`
- Path: `../` (exit ast) → `../` (exit analysis) → `../` (exit plugins) → `core/nodes/`

### 7. Import path for ExpressAnalyzer

**Correct import:**
```typescript
import { NetworkRequestNode } from '../../core/nodes/NetworkRequestNode.js';
```

**Why double `../`?**
- ExpressAnalyzer is in: `packages/core/src/plugins/analysis/`
- NetworkRequestNode is in: `packages/core/src/core/nodes/`
- Path: `../` (exit analysis) → `../` (exit plugins) → `core/nodes/`

---

## Definition of Done

**Code complete when:**

- [ ] NetworkRequestNode.ts created with create() and validate()
- [ ] Exported from nodes/index.ts
- [ ] NodeFactory.createNetworkRequest() added
- [ ] NodeFactory validators includes NET_REQUEST
- [ ] GraphBuilder.bufferHttpRequests() uses NetworkRequestNode.create()
- [ ] ExpressAnalyzer uses NetworkRequestNode.create()
- [ ] No grep matches for inline `type: 'net:request'` object literals
- [ ] No grep matches for hardcoded `'net:request#__network__'` strings (except in NetworkRequestNode.ts)

**Tests complete when:**

- [ ] NetworkRequestNode.test.js created with 9 unit tests
- [ ] NetworkRequestNodeMigration.test.js created with 4 integration tests
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Existing HTTP request tests still pass
- [ ] `npm test` passes (full suite)

**Documentation complete when:**

- [ ] NetworkRequestNode has JSDoc explaining singleton purpose
- [ ] JSDoc distinguishes NET_REQUEST vs HTTP_REQUEST
- [ ] Comments in GraphBuilder and ExpressAnalyzer reference NetworkRequestNode

**Review ready when:**

- [ ] All of the above checkboxes checked
- [ ] Code compiles without TypeScript errors
- [ ] No ESLint warnings in modified files
- [ ] Git diff shows only expected changes (no accidental reformatting)

---

## Files Modified Summary

**New files (3):**
1. `/packages/core/src/core/nodes/NetworkRequestNode.ts`
2. `/test/unit/NetworkRequestNode.test.js`
3. `/test/unit/NetworkRequestNodeMigration.test.js`

**Modified files (4):**
1. `/packages/core/src/core/nodes/index.ts` — Add export
2. `/packages/core/src/core/NodeFactory.ts` — Add factory method and validator
3. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` — Migrate bufferHttpRequests()
4. `/packages/core/src/plugins/analysis/ExpressAnalyzer.ts` — Migrate inline creation

**Unchanged files (verified):**
1. `/packages/core/src/core/nodes/HttpRequestNode.ts` — Different node type
2. `/packages/core/src/core/nodes/NodeKind.ts` — NET_REQUEST constant already exists
3. `/packages/core/src/storage/backends/typeValidation.ts` — Should accept new nodes
4. `/packages/core/src/validation/PathValidator.ts` — Should validate new IDs

---

## Questions for Rob (Pre-implementation)

**Before starting, verify:**

1. **GraphNode type location:** Where is GraphNode type defined? Confirm it's compatible with BaseNodeRecord.
   - Likely in: `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
   - Check if cast is necessary or if we can avoid it

2. **ExpressAnalyzer references:** Are there other places in ExpressAnalyzer.ts that reference `networkId` besides line 84?
   - Use grep to find all occurrences
   - Update all to use `networkNode.id`

3. **Test helpers availability:** Confirm these helpers exist:
   - `createTestBackend` from `../helpers/TestRFDB.js`
   - `createTestOrchestrator` from `../helpers/createTestOrchestrator.js`
   - If missing, check actual paths in existing test files

4. **TypeScript config:** What's the module resolution strategy?
   - If import paths fail, might need to adjust `.js` extensions
   - Check tsconfig.json `moduleResolution` setting

---

## Risk Assessment

**Low risk:**
- Creating new NetworkRequestNode class (follows proven pattern)
- Adding to NodeFactory (standard operation)
- Unit tests (isolated from system)

**Medium risk:**
- GraphBuilder migration (bufferHttpRequests is critical path)
- Integration tests (depend on orchestrator and backend)

**Mitigation:**
- Follow exact pattern from ExternalStdioNode
- Test each phase independently
- Keep GraphBuilder changes minimal (only replace inline creation)
- No changes to edge creation logic (CALLS edges unchanged)

**Rollback plan:**
- Git commit after each phase
- If integration tests fail, revert GraphBuilder/ExpressAnalyzer changes
- Core classes (NetworkRequestNode, NodeFactory) are safe to keep

---

## Success Criteria

**Functional:**
- net:request singleton created once per graph
- HTTP_REQUEST nodes connect to singleton via CALLS edges
- No behavior change in graph structure (same nodes, same edges)
- All existing tests pass

**Code Quality:**
- No inline object literals for net:request nodes
- Consistent ID format (net:request#__network__)
- Clear separation: NET_REQUEST (singleton) vs. HTTP_REQUEST (call sites)
- Follows ExternalStdioNode pattern exactly

**Maintainability:**
- Single source of truth for net:request node creation
- Easy to extend (add fields to NetworkRequestNodeRecord)
- Clear documentation (JSDoc explains purpose)
- Tests lock behavior for future refactoring

---

## Next Steps After Implementation

**For Kevlin & Linus (Review):**
- Verify NetworkRequestNode follows ExternalStdioNode pattern
- Check test quality and coverage
- Confirm no behavioral changes in graph structure
- Verify JSDoc clarity

**For Andy Grove (Tech Debt):**
- Add follow-up issue: "Consider renaming net:request to net:external for clarity" (Low priority)
- Add follow-up issue: "Extract singleton creation helper in GraphBuilder" (Low priority)

**For Steve Jobs (Demo):**
- Show graph query: "Find all nodes that call net:request"
- Show singleton deduplication: "Multiple HTTP requests → one network node"
- Verify: "Can we query this better than reading code?"

---

## Final Notes for Rob

**Rob, this should be straightforward:**

1. **Start with Phase 1** — Create NetworkRequestNode.ts. Copy ExternalStdioNode.ts and adapt.
2. **Write unit tests immediately** — Before moving to integration work.
3. **Follow import paths exactly** — Triple `../` for GraphBuilder, double `../` for ExpressAnalyzer.
4. **Don't overthink the cast** — `as unknown as GraphNode` is necessary, matches existing pattern.
5. **Drop the description field** — Not part of contract, not needed for now.

**If you hit blockers:**
- Check that NetworkRequestNode.SINGLETON_ID matches hardcoded strings exactly
- Verify imports resolve correctly (`.js` extensions required)
- Run TypeScript compiler after each phase: `npm run build`
- Run tests atomically: `node --test test/unit/NetworkRequestNode.test.js`

**The pattern is proven (ExternalStdioNode), the changes are minimal, the tests will guide you.**

Let's ship this. 🚀

---

*"Make it work, make it right, make it fast. We're at step 2."*
— Kent Beck (paraphrased)

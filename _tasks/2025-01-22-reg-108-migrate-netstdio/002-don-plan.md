# REG-108: NodeFactory - Migrate net:stdio to use ExternalStdioNode

**Tech Lead Analysis by Don Melton**
**Date:** 2025-01-22

---

## 1. Executive Summary

**STOP. This task requires architectural decision before implementation.**

The issue REG-108 requests migrating `net:stdio` to use `ExternalStdioNode`. However, there is a **fundamental type mismatch** between the current implementation and the ExternalStdioNode factory:

| Aspect | Current GraphBuilder | ExternalStdioNode Factory |
|--------|---------------------|---------------------------|
| Type | `net:stdio` | `EXTERNAL_STDIO` |
| ID | `net:stdio#__stdio__` | `EXTERNAL_STDIO:__stdio__` |

This is NOT a simple migration like REG-105 (ENUM). This requires a **design decision** about whether:
1. We keep namespaced types (`net:stdio`) as the canonical form
2. We migrate to base types (`EXTERNAL_STDIO`) with legacy mapping

---

## 2. Current State Analysis

### 2.1 GraphBuilder.bufferStdioNodes() (Lines 367-394)

```typescript
private bufferStdioNodes(methodCalls: MethodCallInfo[]): void {
  const consoleIOMethods = methodCalls.filter(mc =>
    (mc.object === 'console' && (mc.method === 'log' || mc.method === 'error'))
  );

  if (consoleIOMethods.length > 0) {
    const stdioId = 'net:stdio#__stdio__';
    if (!this._createdSingletons.has(stdioId)) {
      this._bufferNode({
        id: stdioId,
        type: 'net:stdio',            // <-- Namespaced type
        name: '__stdio__',
        description: 'Standard input/output stream'
      });
      this._createdSingletons.add(stdioId);
    }
    // ... WRITES_TO edges ...
  }
}
```

**Current behavior:**
- Type: `net:stdio` (namespaced)
- ID: `net:stdio#__stdio__`
- Has `description` field

### 2.2 ExternalStdioNode Factory

```typescript
export class ExternalStdioNode {
  static readonly TYPE = 'EXTERNAL_STDIO' as const;
  static readonly SINGLETON_ID = 'EXTERNAL_STDIO:__stdio__';

  static create(): ExternalStdioNodeRecord {
    return {
      id: this.SINGLETON_ID,          // EXTERNAL_STDIO:__stdio__
      type: this.TYPE,                // EXTERNAL_STDIO (not net:stdio!)
      name: '__stdio__',
      file: '__builtin__',
      line: 0
    };
  }
}
```

**Factory behavior:**
- Type: `EXTERNAL_STDIO` (base type, not namespaced)
- ID: `EXTERNAL_STDIO:__stdio__`
- Has `file` and `line` fields
- Missing `description` field

### 2.3 NodeKind.ts defines net:stdio as canonical

```typescript
export const NAMESPACED_TYPE = {
  // Network
  NET_REQUEST: 'net:request',
  NET_STDIO: 'net:stdio',     // <-- This is the canonical type
  // ...
};
```

### 2.4 Tests expect net:stdio

Multiple test files verify the current behavior:

- `/test/scenarios/01-simple-script.test.js:145` - `.hasNode('net:stdio', '__stdio__')`
- `/test/unit/ClearAndRebuild.test.js:236` - `assert.strictEqual(stdioNodes1[0].id, 'net:stdio#__stdio__')`
- `/test/unit/SemanticId.test.js:198` - `'net:stdio->__stdio__'`

### 2.5 GraphAsserter has LEGACY_TYPE_MAP

```typescript
const LEGACY_TYPE_MAP = {
  'EXTERNAL_STDIO': 'net:stdio',  // Maps EXTERNAL_STDIO -> net:stdio
  // ...
};
```

This suggests the codebase was planning for `EXTERNAL_STDIO` to eventually become `net:stdio`, but the factory itself uses `EXTERNAL_STDIO`.

---

## 3. The Architectural Question

**Is `net:stdio` or `EXTERNAL_STDIO` the right type?**

Looking at the vision in CLAUDE.md:
> "Grafema's core thesis: AI should query the graph, not read code."

Namespaced types (`net:stdio`, `db:query`, `http:route`) provide:
1. **Semantic grouping** - AI can query all network-related nodes with `net:*`
2. **Clear categorization** - Side effects are obvious from the type namespace
3. **Consistency** - Already used for `net:request`, `db:query`, `event:listener`

Base types (`EXTERNAL_STDIO`) provide:
1. **TypeScript type safety** - Can define interface with literal type
2. **Internal consistency** - Matches other node factories

**My verdict:** The namespaced type `net:stdio` is **RIGHT** for the product vision.

---

## 4. Recommended Approach

**Option A: Fix ExternalStdioNode to use net:stdio (RECOMMENDED)**

The ExternalStdioNode factory should be updated to:
1. Use `type: 'net:stdio'` (not `EXTERNAL_STDIO`)
2. Use ID format `net:stdio:__stdio__` (colon separator, consistent with other factories)
3. Keep the `description` field from current implementation

This aligns with:
- The product vision (semantic, queryable types)
- NodeKind.ts definition (`NET_STDIO: 'net:stdio'`)
- Existing test expectations

**Option B: Keep EXTERNAL_STDIO and update tests (NOT RECOMMENDED)**

This would require:
1. Updating 10+ test files
2. Relying on LEGACY_TYPE_MAP for queries
3. Breaking semantic consistency with other namespaced types

---

## 5. Proposed Changes

### 5.1 Update ExternalStdioNode.ts

```typescript
export class ExternalStdioNode {
  static readonly TYPE = 'net:stdio' as const;  // Changed from EXTERNAL_STDIO
  static readonly SINGLETON_ID = 'net:stdio:__stdio__';  // Colon separator

  static create(): ExternalStdioNodeRecord {
    return {
      id: this.SINGLETON_ID,
      type: this.TYPE,
      name: '__stdio__',
      file: '__builtin__',
      line: 0,
      description: 'Standard input/output stream'  // Add missing field
    };
  }
}
```

### 5.2 Update GraphBuilder.bufferStdioNodes()

```typescript
private bufferStdioNodes(methodCalls: MethodCallInfo[]): void {
  const consoleIOMethods = methodCalls.filter(mc =>
    (mc.object === 'console' && (mc.method === 'log' || mc.method === 'error'))
  );

  if (consoleIOMethods.length > 0) {
    const stdioNode = NodeFactory.createExternalStdio();

    if (!this._createdSingletons.has(stdioNode.id)) {
      this._bufferNode(stdioNode as unknown as GraphNode);
      this._createdSingletons.add(stdioNode.id);
    }

    for (const methodCall of consoleIOMethods) {
      this._bufferEdge({
        type: 'WRITES_TO',
        src: methodCall.id,
        dst: stdioNode.id  // Use factory-generated ID
      });
    }
  }
}
```

### 5.3 Update NodeFactory.validate() and related mappings

- Update `LEGACY_TYPE_MAP` (or remove the mapping since types now match)
- Update `DataFlowValidator.ts` to use `net:stdio` instead of `EXTERNAL_STDIO`
- Update `PathValidator.ts` to use consistent type

### 5.4 Update Tests

Update ID expectations from `net:stdio#__stdio__` to `net:stdio:__stdio__` (colon separator).

---

## 6. Files to Modify

**Primary changes:**
1. `/packages/core/src/core/nodes/ExternalStdioNode.ts` - Fix type and ID format
2. `/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` - Use factory

**Secondary changes:**
3. `/packages/core/src/plugins/validation/DataFlowValidator.ts` - Update type reference
4. `/packages/core/src/validation/PathValidator.ts` - Update type reference
5. `/test/helpers/GraphAsserter.js` - May need to update LEGACY_TYPE_MAP
6. `/test/unit/ClearAndRebuild.test.js` - Update ID expectation
7. `/test/scenarios/01-simple-script.test.js` - May need minor updates

**Test file to create:**
8. `/test/unit/ExternalStdioNodeMigration.test.js` - TDD tests

---

## 7. Verdict

**WAIT.** Before implementation, we need user confirmation on the architectural decision:

> Should `ExternalStdioNode` use the namespaced type `net:stdio` (matching NodeKind.ts and tests) or the base type `EXTERNAL_STDIO` (matching current factory)?

**My recommendation:** Use `net:stdio` because it aligns with the product vision of semantic, queryable graph types.

---

*"I don't care if it works, is it RIGHT?"* - The current `ExternalStdioNode` factory using `EXTERNAL_STDIO` is NOT right. The namespaced type `net:stdio` is what the codebase expects and what serves the product vision better. We need to fix the factory, not adapt around it.

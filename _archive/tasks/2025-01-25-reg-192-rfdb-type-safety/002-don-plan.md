# Don Melton - High-Level Plan: REG-192 Type Safety for RFDB Query Results

## Executive Summary

**Problem:** CLI commands cast RFDB node results to `any`, losing type safety.

**Root Cause:** Architectural mismatch between three distinct node type systems:
1. `WireNode` (RFDB protocol) - minimal wire format
2. `BackendNode` (RFDBServerBackend) - parsed JS format with metadata
3. `BaseNodeRecord` (types package) - rich semantic node type

**Solution:** Unify on `BaseNodeRecord` as the canonical return type, eliminate `BackendNode` duplication.

This is NOT a quick fix. This is a type system unification that touches the core architecture.

---

## Current State Analysis

### Three Node Type Systems (Architectural Smell)

**1. WireNode** (`packages/types/src/rfdb.ts:52-59`)
```typescript
export interface WireNode {
  id: string;
  nodeType: NodeType;
  name: string;
  file: string;
  exported: boolean;
  metadata: string; // JSON string
}
```
- Minimal wire protocol format
- Metadata as serialized JSON
- **Purpose:** Network transport, storage layer
- **Location:** Correct (types package, rfdb protocol)

**2. BackendNode** (`packages/core/src/storage/backends/RFDBServerBackend.ts:46-54`)
```typescript
export interface BackendNode {
  id: string;
  type: string;
  nodeType: string;
  name: string;
  file: string;
  exported: boolean;
  [key: string]: unknown;  // Spread metadata here
}
```
- Parsed from WireNode by `_parseNode()`
- Has BOTH `type` and `nodeType` (redundancy)
- Index signature for metadata fields
- **Purpose:** Return type from RFDBServerBackend
- **Problem:** Duplicates BaseNodeRecord, not recognized by TypeScript as BaseNodeRecord

**3. BaseNodeRecord** (`packages/types/src/nodes.ts:82-92`)
```typescript
export interface BaseNodeRecord {
  id: string;
  type: NodeType;
  name: string;
  file: string;
  line?: number;
  column?: number;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}
```
- Rich semantic node type
- Has typed extensions (FunctionNodeRecord, etc.)
- **Purpose:** Domain model - what the application works with
- **Location:** Correct (types package)

### The Problem

When CLI commands do:
```typescript
for await (const node of backend.queryNodes({ nodeType: 'VARIABLE' })) {
  const name = (node as any).name;  // ← TYPE SAFETY LOST
}
```

**Why?** Because `queryNodes` returns `BackendNode`, which TypeScript doesn't recognize as having the expected fields in a type-safe way. The index signature `[key: string]: unknown` means accessing properties requires casting.

---

## Root Cause: Architectural Contradiction

We have **duplication without semantic equivalence**:

- `BackendNode` is structurally similar to `BaseNodeRecord`
- But TypeScript sees them as different types
- `BackendNode` lives in wrong layer (backend implementation, not domain)
- CLI commands expect domain types, get backend types

**The Right Architecture:**
```
Wire Protocol Layer:  WireNode (serialize/deserialize)
                        ↓
Domain Layer:         BaseNodeRecord (what app works with)
                        ↓
CLI/MCP:              Typed node access, no casting
```

**Current (Wrong) Architecture:**
```
Wire Protocol:  WireNode
                  ↓
Backend:        BackendNode (←← EXTRA LAYER, WRONG ABSTRACTION)
                  ↓
CLI/MCP:        Cast to any (type safety lost)
```

---

## Proposed Solution

### Strategy: Eliminate BackendNode, Return BaseNodeRecord

**Step 1:** Update RFDBServerBackend to return `BaseNodeRecord`

Change:
```typescript
async getNode(id: string): Promise<BackendNode | null>
async *queryNodes(query: NodeQuery): AsyncGenerator<BackendNode>
```

To:
```typescript
async getNode(id: string): Promise<BaseNodeRecord | null>
async *queryNodes(query: NodeQuery): AsyncGenerator<BaseNodeRecord>
```

**Step 2:** Update `_parseNode` to construct `BaseNodeRecord`

```typescript
private _parseNode(wireNode: WireNode): BaseNodeRecord {
  const metadata: Record<string, unknown> = wireNode.metadata ? JSON.parse(wireNode.metadata) : {};

  // Parse nested JSON in metadata
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string' && (value.startsWith('[') || value.startsWith('{'))) {
      try { metadata[key] = JSON.parse(value); } catch {}
    }
  }

  const humanId = (metadata.originalId as string) || wireNode.id;

  return {
    id: humanId,
    type: wireNode.nodeType,
    name: wireNode.name,
    file: wireNode.file,
    exported: wireNode.exported,
    ...metadata,  // Spread parsed metadata as top-level properties
  };
}
```

**Key decisions:**
1. Use `type` (not `nodeType`) - matches BaseNodeRecord
2. Remove `nodeType` duplication
3. Spread metadata to top level (maintains backward compat)
4. Return `BaseNodeRecord` type

**Step 3:** Remove `BackendNode` interface entirely

It's redundant. Delete from `RFDBServerBackend.ts`.

**Step 4:** Update all CLI commands to remove `as any` casts

Replace:
```typescript
const name = (node as any).name || '';
```

With:
```typescript
const name = node.name || '';
```

TypeScript will know `node.name` exists because `node: BaseNodeRecord`.

---

## Files to Change

### Core Changes (packages/core)

**`packages/core/src/storage/backends/RFDBServerBackend.ts`:**
- Remove `BackendNode` interface (lines 46-54)
- Update `getNode()` return type: `Promise<BaseNodeRecord | null>`
- Update `queryNodes()` return type: `AsyncGenerator<BaseNodeRecord>`
- Update `getAllNodes()` return type: `Promise<BaseNodeRecord[]>`
- Update `findNodes()` parameter type: `(node: BaseNodeRecord) => boolean`
- Update `_parseNode()`: return `BaseNodeRecord`, use single `type` field

**`packages/core/src/storage/backends/RFDBServerBackend.ts` (edge parsing):**
- `BackendEdge` might also need review, but it's separate issue

### CLI Changes (packages/cli)

**Remove `as any` casts in:**
- `packages/cli/src/commands/trace.ts` (lines 151, 166-169, 208-213, 305-309)
- `packages/cli/src/commands/query.ts` (lines 172, 177-180, 223, 270, 277, 327, 367)
- `packages/cli/src/commands/get.ts` (lines 115-118, 146-149, 240)
- `packages/cli/src/commands/impact.ts` (lines 131, 135-138)
- `packages/cli/src/commands/explore.tsx` (if it has similar patterns)

**Pattern to replace:**
```typescript
// BEFORE
const name = (node as any).name || '';
const file = (node as any).file || '';
const line = (node as any).line;

// AFTER
const name = node.name || '';
const file = node.file || '';
const line = node.line;
```

### MCP Changes (packages/mcp)

**`packages/mcp/src/handlers.ts`:**
- Review if it has similar `as any` patterns
- Node access should already be type-safe if backend returns BaseNodeRecord

---

## Type Safety Validation

### What We Gain

1. **TypeScript catches errors:**
   ```typescript
   const typo = node.nane;  // ← TypeScript error: "nane" doesn't exist
   ```

2. **Autocomplete works:**
   - IDE knows `node.name`, `node.file`, `node.line` exist
   - Suggests available properties

3. **Metadata access is typed:**
   ```typescript
   const value = node.value;  // ← unknown type (safe)
   const params = node.params;  // ← unknown type (safe)
   ```
   Index signature still allows plugin-added properties, but with `unknown` type (safe).

4. **Refactoring is safe:**
   - If we rename `BaseNodeRecord.file` → `BaseNodeRecord.filePath`
   - TypeScript catches all call sites automatically

### Edge Cases to Handle

**1. Plugin-added properties:**
- Plugins add custom metadata: `node.customField`
- This works via index signature: `[key: string]: unknown`
- Access as `unknown`, then narrow with type guards

**2. Optional fields:**
- `line?: number` - optional in BaseNodeRecord
- Safe to access: `node.line` is `number | undefined`

**3. Metadata vs. top-level:**
- Current code spreads metadata to top level
- This preserves backward compat
- Plugin properties remain accessible

---

## Risks & Mitigation

### Risk 1: Breaking Changes in Backend Interface

**Impact:** Any code that depends on `BackendNode` type breaks.

**Mitigation:**
- Search codebase for `BackendNode` usage
- Only found in RFDBServerBackend itself (good isolation)
- CLI commands don't import it, they just cast to `any`

**Validation:**
```bash
grep -r "BackendNode" packages/
```
Should only hit RFDBServerBackend.ts.

### Risk 2: Metadata Spread Breaking Tests

**Impact:** Tests might depend on specific metadata structure.

**Mitigation:**
- Review tests that use `backend.getNode()` / `queryNodes()`
- Ensure metadata spread is preserved
- Run full test suite after changes

**Files to check:**
- `test/unit/storage/backends/RFDBServerBackend.*.test.js`
- Any tests using RFDBServerBackend

### Risk 3: Type vs. NodeType Confusion

**Impact:** Code might check `node.nodeType` instead of `node.type`.

**Mitigation:**
- Grep for `node.nodeType` in CLI/MCP
- Many places already handle both: `(node as any).type || (node as any).nodeType`
- After fix, only `node.type` exists (cleaner)

**Transition:**
- Keep both `type` and `nodeType` initially? NO.
- Cleaner to fix all call sites at once.
- Simpler mental model: single source of truth.

---

## Testing Strategy

### Unit Tests

**1. Test `_parseNode` transformation:**
```typescript
test('_parseNode converts WireNode to BaseNodeRecord', async () => {
  const wireNode: WireNode = {
    id: 'file.js->FUNCTION->foo',
    nodeType: 'FUNCTION',
    name: 'foo',
    file: 'file.js',
    exported: true,
    metadata: JSON.stringify({ async: true, line: 10 })
  };

  const result = backend._parseNode(wireNode);

  expect(result.type).toBe('FUNCTION');
  expect(result.name).toBe('foo');
  expect(result.async).toBe(true);  // metadata spread
  expect(result.line).toBe(10);
});
```

**2. Test queryNodes returns BaseNodeRecord:**
```typescript
test('queryNodes yields BaseNodeRecord', async () => {
  const nodes = [];
  for await (const node of backend.queryNodes({ nodeType: 'FUNCTION' })) {
    nodes.push(node);
  }

  expect(nodes[0].type).toBeDefined();
  expect(nodes[0].name).toBeDefined();
  // No need for 'as any' - TypeScript knows the types
});
```

### Integration Tests

**1. CLI commands work without casts:**
```bash
grafema query "function authenticate"
grafema trace "userId from authenticate"
grafema get "file.js->FUNCTION->foo"
```

**2. MCP handlers work:**
- query_graph tool
- find_nodes tool
- trace_data_flow tool

### Type-Level Tests

**Add to packages/types:**
```typescript
// Type-level validation
import type { BaseNodeRecord } from './nodes.js';

// Should compile without errors:
const node: BaseNodeRecord = {
  id: 'test',
  type: 'FUNCTION',
  name: 'foo',
  file: 'test.js',
};

const name: string = node.name;  // ← OK
const line: number | undefined = node.line;  // ← OK
```

---

## Alternative Approaches (Rejected)

### Alternative 1: Keep BackendNode, Add Type Assertion Helper

```typescript
function asTypedNode(node: BackendNode): BaseNodeRecord {
  return node as unknown as BaseNodeRecord;
}
```

**Why rejected:**
- Doesn't solve the root problem
- Still two node types
- Type assertion is a lie, not a guarantee

### Alternative 2: Make BackendNode Extend BaseNodeRecord

```typescript
export interface BackendNode extends BaseNodeRecord {
  nodeType: string;  // Extra field
}
```

**Why rejected:**
- Still duplication
- Extra `nodeType` field is redundant
- Doesn't eliminate the wrong abstraction layer

### Alternative 3: Generic Backend<T> Pattern

```typescript
class RFDBServerBackend<T = BaseNodeRecord> {
  async getNode(id: string): Promise<T | null> { ... }
}
```

**Why rejected:**
- Over-engineering
- Backend should return domain types, period
- Generics add complexity without benefit

---

## Alignment with Project Vision

### AI-First Design

**Before:** LLM agents must know to cast nodes to `any` when using RFDB.

**After:** LLM agents use typed interfaces naturally. TypeScript guides them.

From CLAUDE.md:
> "AI-first tool: Every function must be documented for LLM-based agents."

Typed interfaces ARE documentation for LLMs. Type errors guide AI to correct usage.

### Root Cause Policy

From CLAUDE.md:
> "If behavior or architecture doesn't match project vision: STOP, identify mismatch, fix from roots."

This task exemplifies Root Cause Policy:
1. STOP at symptom: `as any` casts
2. Identify mismatch: Three node type systems
3. Fix from roots: Unify on single domain type

We're not patching the symptoms. We're fixing the architecture.

### TDD Discipline

From CLAUDE.md:
> "New features/bugfixes: write tests first"

**Sequence:**
1. Kent writes tests for expected typed behavior
2. Tests fail (current code requires `as any`)
3. Rob implements type unification
4. Tests pass (typed access works)

---

## Success Criteria

### Must Have

1. ✅ No `(node as any)` casts in CLI commands
2. ✅ `backend.queryNodes()` returns `AsyncGenerator<BaseNodeRecord>`
3. ✅ `backend.getNode()` returns `Promise<BaseNodeRecord | null>`
4. ✅ All existing tests pass
5. ✅ TypeScript compiles without errors

### Should Have

6. ✅ New tests validate typed access
7. ✅ Documentation updated (if any backend docs exist)
8. ✅ No `BackendNode` references in codebase

### Nice to Have

9. ⚪ LSP autocomplete works in CLI commands for node properties
10. ⚪ Type-level tests for BaseNodeRecord

---

## Rollout Plan

### Phase 1: Core Types (packages/core)

1. Update RFDBServerBackend return types
2. Remove BackendNode interface
3. Update _parseNode to return BaseNodeRecord
4. Run core tests

### Phase 2: CLI (packages/cli)

1. Remove `as any` casts in trace.ts
2. Remove `as any` casts in query.ts
3. Remove `as any` casts in get.ts
4. Remove `as any` casts in impact.ts
5. Run CLI tests

### Phase 3: MCP (packages/mcp)

1. Review handlers.ts for similar patterns
2. Update if needed
3. Run MCP tests

### Phase 4: Validation

1. Full test suite
2. Manual testing of CLI commands
3. TypeScript strict mode check

---

## Open Questions for Joel

1. **Metadata handling:** Confirm metadata spread to top-level is correct behavior?
   - Current: `node.async` (from metadata)
   - Alternative: `node.metadata.async`
   - Recommendation: Keep spread for backward compat

2. **Edge types:** Should we also unify `BackendEdge` → `EdgeRecord`?
   - Separate issue or same PR?
   - Recommendation: Same pattern, but separate task (REG-193?)

3. **Migration path:** Should we support both `type` and `nodeType` during transition?
   - Recommendation: No. Clean break. Fix all call sites.

4. **Tests:** Which test files need priority review?
   - RFDBServerBackend tests
   - CLI command tests
   - MCP handler tests

---

## Estimated Complexity

**Effort:** Medium (2-3 hours)
- Type changes: 1 file (RFDBServerBackend.ts)
- Cast removal: 4 files (CLI commands)
- Test updates: Unknown (depends on test coverage)

**Risk:** Low-Medium
- Well-isolated change
- TypeScript catches errors
- Backward compatible (metadata spread preserved)

**Impact:** High
- Eliminates entire class of bugs
- Improves DX significantly
- Sets pattern for future backend types

---

## Next Steps

1. **Joel:** Expand into detailed technical spec
   - Exact file changes
   - Line-by-line diffs
   - Test plan specifics

2. **Linus:** Review this plan
   - Is this the RIGHT fix?
   - Are we solving the real problem?
   - Architectural concerns?

3. **Kent:** Prepare test suite
   - What tests validate typed access?
   - What tests ensure backward compat?
   - What tests catch regressions?

---

## Conclusion

**This is not a typing fix. This is an architecture fix.**

We're eliminating a wrong abstraction (`BackendNode`) and unifying on the right abstraction (`BaseNodeRecord`).

The symptom was `as any` casts. The disease was architectural duplication. We're treating the disease.

**Is this the RIGHT solution?**

Yes. Because:
1. Eliminates duplication
2. Single source of truth (BaseNodeRecord)
3. Type-safe by construction
4. Aligns backend with domain model
5. Zero runtime overhead

**Would we show this on stage?**

Hell yes. "Look, typed graph queries. No casts. TypeScript guides you. This is how backends should work."

---

Don Melton
2025-01-25

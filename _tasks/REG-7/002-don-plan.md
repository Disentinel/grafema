# Don Melton: Analysis of REG-7 (GOVERNS Edge Support)

## Summary

**GOVERNS edge type is ALREADY FULLY IMPLEMENTED.** This task is effectively DONE.

## Current State Analysis

### 1. Edge Type Registration

**File:** `/packages/core/src/storage/backends/typeValidation.ts:47`

```typescript
const KNOWN_EDGE_TYPES = new Set<string>([
  // ... other types ...
  'GOVERNS', 'VIOLATES', 'HAS_PARAMETER', 'DERIVES_FROM',
  // ...
]);
```

`GOVERNS` is already in `KNOWN_EDGE_TYPES`. The edge type validation system will accept it.

### 2. TypeScript Edge Type Constants

**File:** `/packages/types/src/edges.ts:92-93`

```typescript
// Guarantees/Invariants
GOVERNS: 'GOVERNS',
VIOLATES: 'VIOLATES',
```

Type-safe edge constant exists.

### 3. Actual Usage in Production Code

**File:** `/packages/core/src/core/GuaranteeManager.ts:233-246`

```typescript
// Creating GOVERNS edges
await this._createGovernsEdges(guaranteeNode.id, governs);

// Reading GOVERNS edges
const governsEdges = await this.graph.getOutgoingEdges(guaranteeNode.id, ['GOVERNS']);
```

**File:** `/packages/core/src/core/GuaranteeManager.ts:528-548`

```typescript
private async _createGovernsEdges(guaranteeId: string, patterns: string[]): Promise<void> {
  // Get all MODULE nodes
  const modules: ModuleNode[] = [];
  for await (const node of this.graph.queryNodes({ type: 'MODULE' })) {
    modules.push(node as ModuleNode);
  }

  // Match patterns (minimatch)
  for (const module of modules) {
    const relativePath = module.file?.replace(this.projectPath, '').replace(/^\//, '') || '';
    for (const pattern of patterns) {
      if (minimatch(relativePath, pattern) || minimatch(module.file || '', pattern)) {
        await this.graph.addEdge({
          type: 'GOVERNS',
          src: guaranteeId,
          dst: module.id
        });
        break;
      }
    }
  }
}
```

GuaranteeManager is actively creating and querying GOVERNS edges.

### 4. Tests

**File:** `/test/unit/GuaranteeManager.test.js:76-85`

```javascript
it('should create GOVERNS edges to matching modules', async () => {
  await manager.create({
    id: 'test-governs',
    rule: 'violation(X) :- node(X, "CALL").',
    governs: ['**/*.js']
  });

  const edges = await backend.getOutgoingEdges('GUARANTEE:test-governs', ['GOVERNS']);
  assert.ok(edges.length > 0, 'Should create GOVERNS edges to modules');
});
```

Test validates GOVERNS edges are created correctly.

## Two Guarantee Systems

The codebase has **TWO separate guarantee systems**, each using GOVERNS differently:

### System 1: GuaranteeManager (Datalog-based)
- **Purpose:** Runtime validation via Datalog rules
- **File:** `packages/core/src/core/GuaranteeManager.ts`
- **Node type:** `GUARANTEE` (all-caps)
- **GOVERNS edge:** `GUARANTEE:id --GOVERNS--> MODULE:file`
- **Use case:** "No eval() calls" — expressed as Datalog rule

### System 2: GuaranteeAPI (Contract-based)
- **Purpose:** Schema validation, business invariants
- **File:** `packages/core/src/api/GuaranteeAPI.ts`
- **Node type:** `guarantee:queue`, `guarantee:api`, etc. (namespaced)
- **GOVERNS edge:** `guarantee:queue#orders --GOVERNS--> queue:publish#...`
- **Use case:** "Queue message structure" — expressed as JSON schema

Both use the **same GOVERNS edge type** but for different semantic purposes:
- GuaranteeManager: links GUARANTEE to files it validates
- GuaranteeAPI: links guarantee to specific operations it governs

This is architecturally sound — they're orthogonal systems sharing an edge type.

## Task Request Analysis

The user's request:
```
guarantee:queue#orders --governs--> queue:publish#order-api#...
guarantee:queue#orders --governs--> queue:consume#processor#...
```

This is **GuaranteeAPI usage**, not GuaranteeManager. The edge type exists and is used.

## What Needs to Be Done?

**NOTHING.** The edge type is:
1. Registered in KNOWN_EDGE_TYPES
2. Defined in TypeScript constants
3. Used in production code (both systems)
4. Tested

### Option Analysis (from task description)

The task mentions two options:
1. **Add `GOVERNS` to KNOWN_EDGE_TYPES** — ✅ ALREADY DONE (line 47 of typeValidation.ts)
2. **Use namespaced `guarantee:governs`** — ❌ NOT NEEDED (would be non-standard; all other edges are un-namespaced)

## Recommendation

**Mark task as DONE immediately.** REG-7 was completed as part of previous guarantee system implementation.

If user wants something BEYOND what exists, they need to clarify:
- Do they want to CREATE new guarantee:queue nodes? (use GuaranteeAPI.createGuarantee())
- Do they want to CREATE GOVERNS edges? (automatic when creating guarantees)
- Do they want documentation on how to use guarantees? (different task)

But the core requirement — "add GOVERNS edge support" — is fully implemented.

## Files Involved (for reference)

| File | What It Contains |
|------|------------------|
| `packages/core/src/storage/backends/typeValidation.ts:47` | GOVERNS in KNOWN_EDGE_TYPES |
| `packages/types/src/edges.ts:92` | GOVERNS constant definition |
| `packages/core/src/core/GuaranteeManager.ts` | GOVERNS creation/usage (Datalog system) |
| `packages/core/src/api/GuaranteeAPI.ts` | GOVERNS usage (contract system) |
| `test/unit/GuaranteeManager.test.js:76-85` | GOVERNS edge test |
| `test/unit/GuaranteeAPI.test.ts` | GuaranteeAPI tests (includes GOVERNS) |

## Architecture Alignment

This implementation aligns with Grafema's core principles:
- ✅ Uses existing edge type system (no new infrastructure)
- ✅ Reuses GOVERNS for both guarantee systems (DRY)
- ✅ Forward registration (guarantees create their GOVERNS edges, no scanning)
- ✅ Tested in both systems
- ✅ Type-safe via TypeScript constants

## Next Steps

1. Confirm with user if task is complete
2. If user wants something else, clarify specific requirements
3. If confirmed complete, mark REG-7 as Done in Linear

**Time estimate if task is actually complete:** 0 minutes (already done)

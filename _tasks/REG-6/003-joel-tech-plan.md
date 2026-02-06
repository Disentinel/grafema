# Joel Spolsky: Technical Implementation Plan

## Summary

REG-6 core implementation is **COMPLETE**. The remaining work is fixing a broken test file.

## Current State

### Implementation (100% Complete)

| Component | Status | Location |
|-----------|--------|----------|
| NodeKind types | Done | `packages/core/src/core/nodes/NodeKind.ts:88-92` |
| isGuaranteeType() | Done | `packages/core/src/core/nodes/NodeKind.ts:167-171` |
| GuaranteeNode class | Done | `packages/core/src/core/nodes/GuaranteeNode.ts` |
| GuaranteeAPI | Done | `packages/core/src/api/GuaranteeAPI.ts` |
| Types | Done | `packages/types/src/nodes.ts` |
| Edge types | Done | `packages/types/src/edges.ts` (GOVERNS, VIOLATES) |
| Rust wildcard support | Done | `packages/rfdb-server/src/graph/engine.rs:693-701` |
| Export from @grafema/core | Done | `packages/core/src/index.ts:127-128` |

### Tests (Broken)

`test/unit/GuaranteeAPI.test.ts` has wrong import paths:

```typescript
// BROKEN:
import { GuaranteeAPI } from '../../src/v2/api/GuaranteeAPI.js';
import { GuaranteeNode } from '../../src/v2/core/nodes/GuaranteeNode.js';
```

The `src/v2/` path no longer exists — code was moved to `packages/core/src/`.

## Implementation Tasks

### Task 1: Export GuaranteeNode from @grafema/core

**File:** `packages/core/src/index.ts`

**Change:** Add export for GuaranteeNode class and types

```typescript
// After line 133 (export { IssueNode ... })
export { GuaranteeNode } from './core/nodes/GuaranteeNode.js';
export type {
  GuaranteeNodeRecord,
  GuaranteeNodeOptions,
  GuaranteePriority,
  GuaranteeStatus,
  GuaranteeType
} from './core/nodes/GuaranteeNode.js';
```

**Complexity:** O(1) — single export addition
**Risk:** LOW — only adds exports, doesn't change existing behavior

### Task 2: Fix test imports

**File:** `test/unit/GuaranteeAPI.test.ts`

**Change:** Update imports to use package imports

```typescript
// FROM:
import { GuaranteeAPI, type GuaranteeGraphBackend } from '../../src/v2/api/GuaranteeAPI.js';
import { GuaranteeNode } from '../../src/v2/core/nodes/GuaranteeNode.js';

// TO:
import { GuaranteeAPI, type GuaranteeGraphBackend, GuaranteeNode } from '@grafema/core';
```

**Complexity:** O(1) — two import changes
**Risk:** LOW — test file only, no production impact

### Task 3: Build and run tests

**Commands:**
```bash
pnpm build  # Build all packages
node --test test/unit/GuaranteeAPI.test.ts  # Run the specific test
```

**Expected:** All 23 test cases should pass.

## Test Cases Covered (in GuaranteeAPI.test.ts)

1. **createGuarantee()** — 5 tests
   - Create guarantee:queue node
   - Create guarantee:api node
   - Create with schema
   - Use default values
   - Reject invalid type

2. **getGuarantee()** — 2 tests
   - Get by ID
   - Return null for non-existent

3. **findGuarantees()** — 5 tests
   - Find all
   - Filter by type
   - Filter by priority
   - Filter by status
   - Filter by multiple criteria

4. **updateGuarantee()** — 2 tests
   - Update fields
   - Reject update for non-existent

5. **deleteGuarantee()** — 2 tests
   - Delete guarantee
   - Return false for non-existent

6. **GOVERNS edges** — 5 tests
   - Create on guarantee creation
   - Add manually
   - Get governing guarantees
   - Remove edge
   - Cleanup on delete

7. **checkGuarantee()** — 3 tests
   - Pass without schema
   - Validate against schema
   - Report invalid schema

8. **checkAllGuarantees()** — 1 test
   - Check all and return summary

9. **GuaranteeNode helpers** — 4 tests
   - parseId()
   - Invalid ID handling
   - buildId()
   - validate()

## File Change Summary

| File | Action | Lines Changed |
|------|--------|---------------|
| `packages/core/src/index.ts` | Add export | +8 lines |
| `test/unit/GuaranteeAPI.test.ts` | Fix imports | ~3 lines |

## Acceptance Criteria

1. `pnpm build` succeeds
2. `node --test test/unit/GuaranteeAPI.test.ts` passes all tests
3. No changes to production code behavior

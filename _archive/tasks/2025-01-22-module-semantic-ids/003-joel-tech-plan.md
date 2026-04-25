# Joel Spolsky - Technical Implementation Plan for REG-126

## Overview

This plan details the implementation of semantic IDs for MODULE nodes, aligning them with the established pattern used by CLASS, FUNCTION, and other node types.

## Expected Semantic ID Format

Based on the specification in `SemanticId.test.js`:

```
MODULE:        {file}->global->MODULE->module
Example:       src/index.js->global->MODULE->module
```

The name is always `module` (a constant) because each file has exactly one MODULE node.

---

## Phase 1: Update ModuleNode Contract

### File: `packages/core/src/core/nodes/ModuleNode.ts`

**Changes Required:**

1. Add import for `computeSemanticId` and types
2. Add `ModuleContextOptions` interface
3. Add `createWithContext()` static method

**Exact Code:**

```typescript
// Add import
import { computeSemanticId, type ScopeContext } from '../SemanticId.js';

// Add interface
interface ModuleContextOptions {
  contentHash?: string;
  isTest?: boolean;
}

// Add method
static createWithContext(
  context: ScopeContext,
  options: ModuleContextOptions = {}
): ModuleNodeRecord {
  if (!context.file) throw new Error('ModuleNode.createWithContext: file is required in context');

  const id = computeSemanticId(this.TYPE, 'module', context);

  return {
    id,
    type: this.TYPE,
    name: context.file,
    file: context.file,
    line: 0,
    contentHash: options.contentHash || '',
    isTest: options.isTest || false
  };
}
```

---

## Phase 2: Update NodeFactory

### File: `packages/core/src/core/NodeFactory.ts`

**Changes Required:**

Add `createModuleWithContext()` method.

```typescript
import type { ScopeContext } from './SemanticId.js';

interface ModuleContextOptions {
  contentHash?: string;
  isTest?: boolean;
}

static createModuleWithContext(context: ScopeContext, options: ModuleContextOptions = {}) {
  return ModuleNode.createWithContext(context, options);
}
```

---

## Phase 3: Update JSModuleIndexer

### File: `packages/core/src/plugins/indexing/JSModuleIndexer.ts`

**Changes Required:**

1. Update MODULE node creation to use semantic IDs
2. Update edge references to use semantic IDs

**Key Changes:**

```typescript
// Create scope context for semantic ID
const relativePath = relative(projectPath, currentFile) || basename(currentFile);
const context = { file: relativePath, scopePath: [] };

// Create MODULE node with semantic ID
const moduleNode = NodeFactory.createModuleWithContext(context, {
  contentHash: fileHash ?? undefined,
  isTest
});
const moduleId = moduleNode.id;

// For DEPENDS_ON edges:
const depRelativePath = relative(projectPath, resolvedDep) || basename(resolvedDep);
const depModuleId = `${depRelativePath}->global->MODULE->module`;
```

---

## Phase 4: Update IncrementalModuleIndexer

### File: `packages/core/src/plugins/indexing/IncrementalModuleIndexer.ts`

Update MODULE ID generation to use semantic format:

```typescript
const semanticId = `${relativePath}->global->MODULE->module`;
const moduleNode: NodeRecord = {
  id: semanticId,
  type: 'MODULE',
  name: relativePath,
  file: file,
  contentHash: fileHash
};
```

---

## Phase 5: Update VersionManager

### File: `packages/core/src/core/VersionManager.ts`

Update `generateStableId()` for MODULE type.

**CRITICAL:** Must use `node.name` (relative path), NOT `node.file` (absolute path):

```typescript
if (type === 'MODULE') {
  // Use node.name which stores relative path for MODULE nodes
  const relativePath = name; // 'name' parameter in generateStableId
  return `${relativePath}->global->MODULE->module`;
}
```

---

## Phase 6: Update ExpressAnalyzer (ADDED PER LINUS REVIEW)

### File: `packages/core/src/plugins/analysis/ExpressAnalyzer.ts`

**Line 381** constructs MODULE ID for MOUNTS edge creation using legacy format.

**Current (broken):**
```typescript
const targetModuleId = `${targetModulePath}:MODULE:${targetModulePath}:0`;
```

**Fixed:**
```typescript
// Use semantic ID format for MODULE reference
const targetModuleId = `${targetModulePath}->global->MODULE->module`;
```

**Note:** `targetModulePath` is already a relative path in this context.

---

## Implementation Order

1. **ModuleNode.ts** - Add `createWithContext()` method
2. **NodeFactory.ts** - Add `createModuleWithContext()` method
3. **JSModuleIndexer.ts** - Use new API
4. **IncrementalModuleIndexer.ts** - Use semantic ID format
5. **VersionManager.ts** - Update stable ID format (use `name` not `file`)
6. **ExpressAnalyzer.ts** - Update MODULE ID for MOUNTS edges

---

## Test Plan

### New Test File: `test/unit/ModuleNodeSemanticId.test.js`

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ModuleNode, computeSemanticId } from '@grafema/core';

describe('ModuleNode with Semantic ID', () => {
  describe('createWithContext()', () => {
    it('should create MODULE with semantic ID', () => {
      const context = { file: 'src/index.js', scopePath: [] };
      const node = ModuleNode.createWithContext(context);

      assert.strictEqual(node.id, 'src/index.js->global->MODULE->module');
      assert.strictEqual(node.type, 'MODULE');
      assert.strictEqual(node.name, 'src/index.js');
    });

    it('should handle nested path', () => {
      const context = { file: 'packages/core/src/utils/helper.ts', scopePath: [] };
      const node = ModuleNode.createWithContext(context);

      assert.strictEqual(node.id, 'packages/core/src/utils/helper.ts->global->MODULE->module');
    });

    it('should include contentHash when provided', () => {
      const context = { file: 'src/app.js', scopePath: [] };
      const node = ModuleNode.createWithContext(context, { contentHash: 'abc123' });

      assert.strictEqual(node.contentHash, 'abc123');
    });

    it('should require file in context', () => {
      const context = { file: '', scopePath: [] };
      assert.throws(() => ModuleNode.createWithContext(context), /file is required/);
    });
  });

  describe('Semantic ID stability', () => {
    it('should produce same ID regardless of contentHash', () => {
      const context = { file: 'src/module.js', scopePath: [] };
      const node1 = ModuleNode.createWithContext(context, { contentHash: 'hash1' });
      const node2 = ModuleNode.createWithContext(context, { contentHash: 'hash2' });

      assert.strictEqual(node1.id, node2.id);
    });
  });

  describe('computeSemanticId integration', () => {
    it('should match computeSemanticId output', () => {
      const context = { file: 'src/handlers/user.js', scopePath: [] };
      const node = ModuleNode.createWithContext(context);
      const expectedId = computeSemanticId('MODULE', 'module', context);

      assert.strictEqual(node.id, expectedId);
    });
  });
});
```

---

## Checklist

### Kent Beck (Tests)

1. [ ] Create `test/unit/ModuleNodeSemanticId.test.js`
2. [ ] Run tests - they should FAIL (TDD)
3. [ ] After implementation, verify all tests pass

### Rob Pike (Implementation)

1. [ ] ModuleNode.ts - Add `createWithContext()`
2. [ ] NodeFactory.ts - Add `createModuleWithContext()`
3. [ ] JSModuleIndexer.ts - Use semantic IDs
4. [ ] IncrementalModuleIndexer.ts - Use semantic format
5. [ ] VersionManager.ts - Update stable ID (use `name` not `file`)
6. [ ] ExpressAnalyzer.ts - Update MODULE ID for MOUNTS edges
7. [ ] Run all tests
8. [ ] Run `grafema analyze` to verify

---

## Notes

- `contentHash` remains as node attribute for change detection
- **BREAKING CHANGE:** Run `grafema db:clear` before deploying (old hash-based IDs incompatible)
- Legacy `create()` preserved for backward compatibility

---

## Additional Tests (Per Linus Review)

### Edge Consistency Test

```javascript
describe('Edge reference consistency', () => {
  it('DEPENDS_ON edges should use matching semantic IDs', () => {
    // Create two MODULE nodes
    const ctx1 = { file: 'src/a.js', scopePath: [] };
    const ctx2 = { file: 'src/b.js', scopePath: [] };

    const node1 = ModuleNode.createWithContext(ctx1);
    const node2 = ModuleNode.createWithContext(ctx2);

    // Create edge referencing node2
    const depModuleId = `${ctx2.file}->global->MODULE->module`;

    // Edge dst must match node ID exactly
    assert.strictEqual(depModuleId, node2.id);
  });
});
```

### Cross-Indexer Consistency Test

```javascript
describe('Cross-indexer consistency', () => {
  it('JSModuleIndexer and IncrementalModuleIndexer produce same IDs', () => {
    const file = 'src/app.js';

    // JSModuleIndexer approach
    const jsContext = { file, scopePath: [] };
    const jsNode = ModuleNode.createWithContext(jsContext);

    // IncrementalModuleIndexer approach (direct string)
    const incId = `${file}->global->MODULE->module`;

    assert.strictEqual(jsNode.id, incId);
  });
});
```

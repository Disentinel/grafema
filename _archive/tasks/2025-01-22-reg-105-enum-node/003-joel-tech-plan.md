# REG-105: EnumNode Migration - Technical Implementation Plan

**Implementation Planner: Joel Spolsky**
**Date:** 2025-01-22

---

## Executive Summary

This document provides detailed technical specifications for migrating ENUM node creation from inline object literals to the EnumNode factory pattern. The EnumNode factory already exists and is fully implemented. This migration follows the exact same pattern as InterfaceNode (REG-103).

**Key Insight from Don's Analysis:**
- TypeScriptVisitor generates legacy IDs with `#` separator: `ENUM#Status#/path/file.ts#20`
- EnumNode.create() generates modern IDs with `:` separator: `/path/file.ts:ENUM:Status:20`
- **Solution:** Ignore `enumDecl.id` from TypeScriptVisitor, use `EnumNode.create()` to generate proper ID

---

## Part 1: Test Specifications (For Kent Beck)

### Test File Structure

**File:** `/Users/vadimr/grafema/test/unit/EnumNodeMigration.test.js`

**Pattern Reference:** Follow `/Users/vadimr/grafema/test/unit/InterfaceNodeMigration.test.js` exactly.

### Test Sections

#### 1. EnumNode.create() ID Format Verification (Unit Tests)

These tests verify the EnumNode factory produces correct IDs.

**Test 1.1: ID uses colon separator**
```javascript
it('should generate ID with colon separator', () => {
  const node = EnumNode.create(
    'Status',
    '/project/src/types.ts',
    5,
    0
  );

  // ID format: {file}:ENUM:{name}:{line}
  assert.strictEqual(
    node.id,
    '/project/src/types.ts:ENUM:Status:5',
    'ID should use colon separators'
  );
});
```

**Test 1.2: ID does NOT use # separator**
```javascript
it('should NOT use # separator in ID', () => {
  const node = EnumNode.create(
    'Color',
    '/project/src/enums.ts',
    10,
    0
  );

  assert.ok(
    !node.id.includes('#'),
    `ID should NOT contain # separator: ${node.id}`
  );
});
```

**Test 1.3: ID follows pattern {file}:ENUM:{name}:{line}**
```javascript
it('should follow pattern: {file}:ENUM:{name}:{line}', () => {
  const node = EnumNode.create(
    'Direction',
    '/src/data/enums.ts',
    25,
    0
  );

  const parts = node.id.split(':');
  assert.strictEqual(parts.length, 4, 'ID should have 4 parts separated by :');
  assert.strictEqual(parts[0], '/src/data/enums.ts', 'First part should be file');
  assert.strictEqual(parts[1], 'ENUM', 'Second part should be ENUM');
  assert.strictEqual(parts[2], 'Direction', 'Third part should be name');
  assert.strictEqual(parts[3], '25', 'Fourth part should be line');
});
```

**Test 1.4: Preserve all required fields**
```javascript
it('should preserve all required fields', () => {
  const node = EnumNode.create(
    'Status',
    '/project/types.ts',
    15,
    5,
    {
      isConst: true,
      members: [
        { name: 'Active', value: 0 },
        { name: 'Inactive', value: 1 }
      ]
    }
  );

  assert.strictEqual(node.type, 'ENUM');
  assert.strictEqual(node.name, 'Status');
  assert.strictEqual(node.file, '/project/types.ts');
  assert.strictEqual(node.line, 15);
  assert.strictEqual(node.column, 5);
  assert.strictEqual(node.isConst, true);
  assert.strictEqual(node.members.length, 2);
  assert.strictEqual(node.members[0].name, 'Active');
  assert.strictEqual(node.members[0].value, 0);
});
```

**Test 1.5: Handle const enums**
```javascript
it('should handle const enum option', () => {
  const node = EnumNode.create(
    'Flag',
    '/project/src/flags.ts',
    10,
    0,
    { isConst: true }
  );

  assert.strictEqual(node.type, 'ENUM');
  assert.strictEqual(node.isConst, true);
  assert.ok(node.id.includes(':ENUM:'),
    `Const enum should use colon format: ${node.id}`);
});
```

**Test 1.6: Handle members with different value types**
```javascript
it('should handle enum members with numeric and string values', () => {
  const nodeNumeric = EnumNode.create(
    'HttpStatus',
    '/project/http.ts',
    5,
    0,
    {
      members: [
        { name: 'OK', value: 200 },
        { name: 'NotFound', value: 404 }
      ]
    }
  );

  const nodeString = EnumNode.create(
    'Color',
    '/project/colors.ts',
    10,
    0,
    {
      members: [
        { name: 'Red', value: 'red' },
        { name: 'Blue', value: 'blue' }
      ]
    }
  );

  assert.strictEqual(nodeNumeric.members[0].value, 200);
  assert.strictEqual(nodeNumeric.members[1].value, 404);
  assert.strictEqual(nodeString.members[0].value, 'red');
  assert.strictEqual(nodeString.members[1].value, 'blue');
});
```

**Test 1.7: Create consistent IDs for same parameters**
```javascript
it('should create consistent IDs for same parameters', () => {
  const node1 = EnumNode.create('Status', '/file.ts', 10, 0);
  const node2 = EnumNode.create('Status', '/file.ts', 10, 0);

  assert.strictEqual(node1.id, node2.id,
    'Same parameters should produce same ID');
});
```

**Test 1.8: Create unique IDs for different enums**
```javascript
it('should create unique IDs for different enums', () => {
  const status = EnumNode.create('Status', '/types.ts', 5, 0);
  const color = EnumNode.create('Color', '/types.ts', 10, 0);
  const statusOtherFile = EnumNode.create('Status', '/other.ts', 5, 0);

  assert.notStrictEqual(status.id, color.id,
    'Different names should have different IDs');
  assert.notStrictEqual(status.id, statusOtherFile.id,
    'Same name in different files should have different IDs');
});
```

#### 2. Integration Tests - ENUM Analysis

These tests verify end-to-end enum analysis works correctly.

**Test 2.1: Analyze regular enum with colon ID format**
```javascript
it('should analyze TypeScript enum and use colon ID format', async () => {
  await setupTest(backend, {
    'index.ts': `
export enum Status {
  Active = 0,
  Inactive = 1
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const enumNode = allNodes.find(n =>
    n.name === 'Status' && n.type === 'ENUM'
  );

  assert.ok(enumNode, 'ENUM node "Status" not found');

  // ID should use colon format (EnumNode.create pattern)
  assert.ok(
    enumNode.id.includes(':ENUM:Status:'),
    `ID should use colon format: ${enumNode.id}`
  );

  // Should NOT have legacy # format
  assert.ok(
    !enumNode.id.includes('ENUM#'),
    `ID should NOT use legacy # format: ${enumNode.id}`
  );
});
```

**Test 2.2: Analyze const enum**
```javascript
it('should analyze const enum correctly', async () => {
  await setupTest(backend, {
    'index.ts': `
export const enum Direction {
  Up,
  Down,
  Left,
  Right
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const enumNode = allNodes.find(n =>
    n.name === 'Direction' && n.type === 'ENUM'
  );

  assert.ok(enumNode, 'ENUM node "Direction" not found');
  assert.strictEqual(enumNode.isConst, true,
    'Should have isConst: true for const enum');
});
```

**Test 2.3: Analyze enum with numeric values**
```javascript
it('should analyze enum with explicit numeric values', async () => {
  await setupTest(backend, {
    'index.ts': `
export enum HttpStatus {
  OK = 200,
  Created = 201,
  NotFound = 404
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const enumNode = allNodes.find(n =>
    n.name === 'HttpStatus' && n.type === 'ENUM'
  );

  assert.ok(enumNode, 'ENUM node "HttpStatus" not found');
  assert.ok(Array.isArray(enumNode.members),
    'members should be an array');
  // Note: Value capture depends on AST visitor implementation
});
```

**Test 2.4: Analyze enum with string values**
```javascript
it('should analyze enum with string values', async () => {
  await setupTest(backend, {
    'index.ts': `
export enum Color {
  Red = 'red',
  Green = 'green',
  Blue = 'blue'
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const enumNode = allNodes.find(n =>
    n.name === 'Color' && n.type === 'ENUM'
  );

  assert.ok(enumNode, 'ENUM node "Color" not found');
  assert.ok(Array.isArray(enumNode.members),
    'members should be an array');
});
```

**Test 2.5: Create MODULE -> CONTAINS -> ENUM edge**
```javascript
it('should create MODULE -> CONTAINS -> ENUM edge', async () => {
  await setupTest(backend, {
    'index.ts': `
export enum Status {
  Active,
  Inactive
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const allEdges = await backend.getAllEdges();

  const enumNode = allNodes.find(n =>
    n.name === 'Status' && n.type === 'ENUM'
  );
  const moduleNode = allNodes.find(n =>
    n.type === 'MODULE' && n.file.endsWith('index.ts')
  );

  assert.ok(enumNode, 'ENUM node not found');
  assert.ok(moduleNode, 'MODULE node not found');

  // Find CONTAINS edge from module to enum
  const containsEdge = allEdges.find(e =>
    e.type === 'CONTAINS' &&
    e.src === moduleNode.id &&
    e.dst === enumNode.id
  );

  assert.ok(containsEdge,
    `CONTAINS edge from ${moduleNode.id} to ${enumNode.id} not found`);
});
```

**Test 2.6: Create unique IDs for different enums**
```javascript
it('should create unique IDs for different enums', async () => {
  await setupTest(backend, {
    'index.ts': `
enum Status {
  Active,
  Inactive
}

enum Priority {
  Low,
  High
}

enum Color {
  Red,
  Green
}

export { Status, Priority, Color };
    `
  });

  const allNodes = await backend.getAllNodes();
  const status = allNodes.find(n => n.name === 'Status' && n.type === 'ENUM');
  const priority = allNodes.find(n => n.name === 'Priority' && n.type === 'ENUM');
  const color = allNodes.find(n => n.name === 'Color' && n.type === 'ENUM');

  assert.ok(status, 'Status not found');
  assert.ok(priority, 'Priority not found');
  assert.ok(color, 'Color not found');

  // All IDs should be unique
  const ids = [status.id, priority.id, color.id];
  const uniqueIds = new Set(ids);
  assert.strictEqual(uniqueIds.size, 3, 'All enum IDs should be unique');

  // All should use colon format
  for (const node of [status, priority, color]) {
    assert.ok(
      node.id.includes(':ENUM:'),
      `ID should use colon format: ${node.id}`
    );
  }
});
```

#### 3. No Inline ID Strings Verification

**Test 3.1: Should NOT use ENUM# format in analyzed code**
```javascript
it('should NOT use ENUM# format in analyzed code', async () => {
  await setupTest(backend, {
    'index.ts': `
export enum State {
  Ready,
  Running,
  Done
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const enumNode = allNodes.find(n =>
    n.name === 'State' && n.type === 'ENUM'
  );

  assert.ok(enumNode, 'State not found');

  // Check ID format
  assert.ok(
    !enumNode.id.includes('ENUM#'),
    `ID should NOT contain legacy ENUM# format: ${enumNode.id}`
  );

  assert.ok(
    enumNode.id.includes(':ENUM:'),
    `ID should use colon format: ${enumNode.id}`
  );
});
```

**Test 3.2: Should match EnumNode.create ID format**
```javascript
it('should match EnumNode.create ID format', async () => {
  await setupTest(backend, {
    'index.ts': `
export enum Mode {
  Development,
  Production
}
    `
  });

  const allNodes = await backend.getAllNodes();
  const analyzed = allNodes.find(n =>
    n.name === 'Mode' && n.type === 'ENUM'
  );

  assert.ok(analyzed, 'Mode not found');

  // The ID format should match what EnumNode.create produces
  assert.ok(
    analyzed.id.startsWith(analyzed.file + ':ENUM:Mode:'),
    `Analyzed ID should follow EnumNode.create format: ${analyzed.id}`
  );
});
```

#### 4. NodeFactory.createEnum Compatibility

**Test 4.1: Should be alias for EnumNode.create**
```javascript
it('should be alias for EnumNode.create', () => {
  const viaNodeFactory = NodeFactory.createEnum(
    'Status',
    '/file.ts',
    10,
    0,
    {
      isConst: true,
      members: [{ name: 'Active', value: 0 }]
    }
  );

  const viaEnumNode = EnumNode.create(
    'Status',
    '/file.ts',
    10,
    0,
    {
      isConst: true,
      members: [{ name: 'Active', value: 0 }]
    }
  );

  assert.deepStrictEqual(viaNodeFactory, viaEnumNode,
    'NodeFactory.createEnum should produce same result as EnumNode.create');
});
```

**Test 4.2: Should pass validation**
```javascript
it('should pass validation for created enums', () => {
  const node = NodeFactory.createEnum(
    'Priority',
    '/project/enums.ts',
    15,
    0,
    {
      isConst: false,
      members: [
        { name: 'Low', value: 0 },
        { name: 'High', value: 1 }
      ]
    }
  );

  const errors = NodeFactory.validate(node);
  assert.strictEqual(errors.length, 0,
    `Expected no validation errors, got: ${JSON.stringify(errors)}`);
});
```

### Test File Template Structure

```javascript
/**
 * EnumNode Migration Tests (REG-105)
 *
 * TDD tests for migrating ENUM node creation to EnumNode factory.
 * Following pattern from InterfaceNodeMigration.test.js (REG-103).
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { EnumNode, NodeFactory } from '@grafema/core';
import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `grafema-test-enum-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-enum-${testCounter}`,
      type: 'module',
      main: 'index.ts'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend, { forceAnalysis: true });
  await orchestrator.run(testDir);

  return { testDir };
}

describe('EnumNode Migration (REG-105)', () => {
  describe('EnumNode.create() ID format', () => {
    // Unit tests here
  });

  describe('ENUM node analysis integration', () => {
    let backend;

    beforeEach(async () => {
      if (backend) {
        await backend.cleanup();
      }
      backend = createTestBackend();
      await backend.connect();
    });

    after(async () => {
      if (backend) {
        await backend.cleanup();
      }
    });

    // Integration tests here
  });

  describe('No inline ID strings', () => {
    // Verification tests here
  });

  describe('NodeFactory.createEnum compatibility', () => {
    // Compatibility tests here
  });
});
```

### Test Expectations

**PASS immediately:**
- All `EnumNode.create()` unit tests (Section 1) - factory already exists
- NodeFactory compatibility tests (Section 4) - factory integration complete

**FAIL initially, PASS after Rob's implementation:**
- Integration tests (Section 2) - will fail until GraphBuilder uses EnumNode.create()
- No inline ID strings tests (Section 3) - will fail until migration complete

---

## Part 2: Implementation Specifications (For Rob Pike)

### File to Modify

**Location:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### Step 1: Add Import Statement

**Location:** Line 9 (after InterfaceNode import)

**Add:**
```typescript
import { EnumNode, type EnumNodeRecord } from '../../../core/nodes/EnumNode.js';
```

**Context (lines 8-10 after change):**
```typescript
import { ImportNode } from '../../../core/nodes/ImportNode.js';
import { InterfaceNode, type InterfaceNodeRecord } from '../../../core/nodes/InterfaceNode.js';
import { EnumNode, type EnumNodeRecord } from '../../../core/nodes/EnumNode.js';
import { NodeFactory } from '../../../core/NodeFactory.js';
```

### Step 2: Update bufferEnumNodes() Method

**Location:** Lines 1155-1176

**BEFORE (Current Implementation):**
```typescript
private bufferEnumNodes(module: ModuleNode, enums: EnumDeclarationInfo[]): void {
  for (const enumDecl of enums) {
    // Buffer ENUM node
    this._bufferNode({
      id: enumDecl.id,
      type: 'ENUM',
      name: enumDecl.name,
      file: enumDecl.file,
      line: enumDecl.line,
      column: enumDecl.column,
      isConst: enumDecl.isConst,
      members: enumDecl.members
    });

    // MODULE -> CONTAINS -> ENUM
    this._bufferEdge({
      type: 'CONTAINS',
      src: module.id,
      dst: enumDecl.id
    });
  }
}
```

**AFTER (Migrated Implementation):**
```typescript
/**
 * Buffer ENUM nodes
 * Uses EnumNode.create() to ensure consistent ID format (colon separator)
 */
private bufferEnumNodes(module: ModuleNode, enums: EnumDeclarationInfo[]): void {
  for (const enumDecl of enums) {
    // Use EnumNode.create() to generate proper ID (colon format)
    // Do NOT use enumDecl.id which has legacy # format from TypeScriptVisitor
    const enumNode = EnumNode.create(
      enumDecl.name,
      enumDecl.file,
      enumDecl.line,
      enumDecl.column || 0,
      {
        isConst: enumDecl.isConst || false,
        members: enumDecl.members || []
      }
    );

    this._bufferNode(enumNode as unknown as GraphNode);

    // MODULE -> CONTAINS -> ENUM
    this._bufferEdge({
      type: 'CONTAINS',
      src: module.id,
      dst: enumNode.id  // Use factory-generated ID (colon format)
    });
  }
}
```

### Key Changes Explained

1. **Ignore enumDecl.id:** Don't use `enumDecl.id` from TypeScriptVisitor (legacy `#` format)
2. **Use EnumNode.create():** Generate proper ID with colon separator format
3. **Default values:** Use `|| 0` for column, `|| false` for isConst, `|| []` for members
4. **Type cast:** Cast `enumNode as unknown as GraphNode` (same pattern as InterfaceNode)
5. **Use factory-generated ID:** Reference `enumNode.id` in edge destination

### Step 3: Verify No Other Changes Needed

**Check:** Search for other inline ENUM creation in GraphBuilder
- TypeScriptVisitor ID generation is intentionally LEFT AS-IS (future cleanup)
- No other locations use inline ENUM creation
- EnumNode factory is already exported from @grafema/core

---

## Part 3: Edge Cases and Error Handling

### Edge Case 1: Missing or Undefined Column

**Scenario:** `enumDecl.column` is `undefined`

**Handling:** Use `enumDecl.column || 0` as default

**Code:**
```typescript
const enumNode = EnumNode.create(
  enumDecl.name,
  enumDecl.file,
  enumDecl.line,
  enumDecl.column || 0,  // ← Default to 0 if undefined
  { ... }
);
```

### Edge Case 2: Missing isConst Field

**Scenario:** `enumDecl.isConst` is `undefined`

**Handling:** Use `enumDecl.isConst || false` to ensure boolean

**Code:**
```typescript
{
  isConst: enumDecl.isConst || false,  // ← Default to false
  members: enumDecl.members || []
}
```

### Edge Case 3: Empty Members Array

**Scenario:** `enumDecl.members` is `undefined` or empty

**Handling:** Use `enumDecl.members || []` to ensure array

**Code:**
```typescript
{
  isConst: enumDecl.isConst || false,
  members: enumDecl.members || []  // ← Default to empty array
}
```

### Edge Case 4: Enum Without Explicit Values

**Scenario:** Enum members don't have explicit values (auto-numbered)

**Handling:** EnumNode accepts members without values (TypeScriptVisitor handles extraction)

**Example:**
```typescript
enum Status {
  Active,    // value: undefined (auto-numbered by TS)
  Inactive
}
```

**EnumNode handles:**
```typescript
{
  members: [
    { name: 'Active', value: undefined },
    { name: 'Inactive', value: undefined }
  ]
}
```

### Edge Case 5: Required Field Validation

**Scenario:** Missing name, file, or line

**Handling:** EnumNode.create() throws error (factory validation)

**EnumNode validation:**
```typescript
if (!name) throw new Error('EnumNode.create: name is required');
if (!file) throw new Error('EnumNode.create: file is required');
if (!line) throw new Error('EnumNode.create: line is required');
```

**No additional handling needed** - let factory throw if data is invalid.

---

## Part 4: Implementation Order (Step-by-Step)

### Phase 1: Write Tests (Kent Beck)

1. Create `/Users/vadimr/grafema/test/unit/EnumNodeMigration.test.js`
2. Copy structure from `InterfaceNodeMigration.test.js`
3. Implement all test sections (1-4) as specified above
4. Run tests: `node --test test/unit/EnumNodeMigration.test.js`
5. **Expected:** Unit tests PASS, integration tests FAIL

### Phase 2: Implement Migration (Rob Pike)

1. Open `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`
2. Add import statement at line 9 (after InterfaceNode import)
3. Update `bufferEnumNodes()` method (lines 1155-1176)
4. Save file

### Phase 3: Verify Implementation (Rob Pike)

1. Run tests: `node --test test/unit/EnumNodeMigration.test.js`
2. **Expected:** All tests PASS
3. If failures occur:
   - Check import statement is correct
   - Verify EnumNode.create() parameters match spec
   - Ensure type cast `as unknown as GraphNode` is present
   - Confirm edge uses `enumNode.id` not `enumDecl.id`

### Phase 4: Run Full Test Suite

1. Run full suite: `npm test`
2. **Expected:** All tests pass (no regressions)
3. If regressions occur:
   - Check if other code depends on legacy ENUM# ID format
   - Verify CONTAINS edge uses correct ID
   - Ensure no other code references `enumDecl.id` directly

---

## Part 5: Verification Checklist

### Before Implementation

- [ ] Read InterfaceNodeMigration.test.js to understand pattern
- [ ] Verify EnumNode is exported from @grafema/core
- [ ] Check GraphBuilder.bufferInterfaceNodes() for reference
- [ ] Understand EnumDeclarationInfo structure from types.ts

### During Implementation

- [ ] Import statement added at correct location
- [ ] bufferEnumNodes() signature unchanged
- [ ] EnumNode.create() receives correct parameters
- [ ] Default values applied for optional fields
- [ ] Type cast to GraphNode present
- [ ] Edge references enumNode.id (not enumDecl.id)
- [ ] Comment explains ID format choice

### After Implementation

- [ ] EnumNodeMigration.test.js: all tests pass
- [ ] Full test suite: npm test passes
- [ ] No legacy ENUM# format in new enum IDs
- [ ] All enum IDs use colon format: `{file}:ENUM:{name}:{line}`
- [ ] MODULE -> CONTAINS -> ENUM edges work correctly
- [ ] No regressions in other tests

---

## Part 6: Reference Materials

### EnumNode API

**Location:** `/Users/vadimr/grafema/packages/core/src/core/nodes/EnumNode.ts`

**Signature:**
```typescript
EnumNode.create(
  name: string,
  file: string,
  line: number,
  column: number,
  options?: {
    isConst?: boolean;
    members?: Array<{ name: string; value?: string | number }>;
  }
): EnumNodeRecord
```

**Returns:**
```typescript
{
  id: string;           // {file}:ENUM:{name}:{line}
  type: 'ENUM';
  name: string;
  file: string;
  line: number;
  column: number;
  isConst: boolean;
  members: Array<{ name: string; value?: string | number }>;
}
```

### EnumDeclarationInfo Structure

**Location:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/types.ts:181-196`

```typescript
interface EnumDeclarationInfo {
  id: string;              // Legacy format: ENUM#name#file#line
  semanticId?: string;     // Future: stable semantic ID
  type: 'ENUM';
  name: string;
  file: string;
  line: number;
  column?: number;
  isConst?: boolean;       // const enum flag
  members: EnumMemberInfo[];
}

interface EnumMemberInfo {
  name: string;
  value?: string | number;
}
```

### InterfaceNode Migration Reference

**Location:** `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts:1066-1115`

**Pattern to follow:**
```typescript
private bufferInterfaceNodes(module: ModuleNode, interfaces: InterfaceDeclarationInfo[]): void {
  const interfaceNodes = new Map<string, InterfaceNodeRecord>();

  for (const iface of interfaces) {
    const interfaceNode = InterfaceNode.create(
      iface.name,
      iface.file,
      iface.line,
      iface.column || 0,
      {
        extends: iface.extends,
        properties: iface.properties
      }
    );
    interfaceNodes.set(iface.name, interfaceNode);
    this._bufferNode(interfaceNode as unknown as GraphNode);

    // MODULE -> CONTAINS -> INTERFACE
    this._bufferEdge({
      type: 'CONTAINS',
      src: module.id,
      dst: interfaceNode.id  // ← Use factory-generated ID
    });
  }
  // ... EXTENDS edge handling (second pass)
}
```

**Key differences for EnumNode:**
- No EXTENDS edges (enums don't extend)
- No Map needed (no second pass for edges)
- Different optional fields (isConst, members vs extends, properties)

---

## Part 7: Common Pitfalls to Avoid

### Pitfall 1: Using enumDecl.id

**WRONG:**
```typescript
this._bufferNode(enumNode);
this._bufferEdge({
  type: 'CONTAINS',
  src: module.id,
  dst: enumDecl.id  // ❌ Legacy # format!
});
```

**CORRECT:**
```typescript
this._bufferNode(enumNode as unknown as GraphNode);
this._bufferEdge({
  type: 'CONTAINS',
  src: module.id,
  dst: enumNode.id  // ✅ Factory-generated colon format
});
```

### Pitfall 2: Forgetting Type Cast

**WRONG:**
```typescript
this._bufferNode(enumNode);  // ❌ Type error: EnumNodeRecord not assignable to GraphNode
```

**CORRECT:**
```typescript
this._bufferNode(enumNode as unknown as GraphNode);  // ✅ Type cast needed
```

### Pitfall 3: Not Handling Undefined Column

**WRONG:**
```typescript
const enumNode = EnumNode.create(
  enumDecl.name,
  enumDecl.file,
  enumDecl.line,
  enumDecl.column,  // ❌ Might be undefined!
  { ... }
);
```

**CORRECT:**
```typescript
const enumNode = EnumNode.create(
  enumDecl.name,
  enumDecl.file,
  enumDecl.line,
  enumDecl.column || 0,  // ✅ Default to 0
  { ... }
);
```

### Pitfall 4: Missing Options Object

**WRONG:**
```typescript
const enumNode = EnumNode.create(
  enumDecl.name,
  enumDecl.file,
  enumDecl.line,
  enumDecl.column || 0
  // ❌ Missing options - isConst and members not passed
);
```

**CORRECT:**
```typescript
const enumNode = EnumNode.create(
  enumDecl.name,
  enumDecl.file,
  enumDecl.line,
  enumDecl.column || 0,
  {
    isConst: enumDecl.isConst || false,
    members: enumDecl.members || []
  }
);
```

### Pitfall 5: Trying to Update TypeScriptVisitor

**WRONG:** Changing TypeScriptVisitor ID generation as part of this task

**CORRECT:** Leave TypeScriptVisitor as-is. The legacy `enumDecl.id` is simply ignored in favor of `EnumNode.create()` generated ID.

---

## Part 8: Success Criteria

### Must Pass

1. All unit tests in EnumNodeMigration.test.js pass
2. All integration tests in EnumNodeMigration.test.js pass
3. Full test suite passes (`npm test`)
4. No regressions in existing tests

### Must Verify

1. All ENUM node IDs use colon format: `{file}:ENUM:{name}:{line}`
2. No ENUM node IDs contain `#` separator
3. MODULE -> CONTAINS -> ENUM edges use correct enum node IDs
4. const enums have `isConst: true`
5. Enum members are preserved correctly

### Documentation

1. bufferEnumNodes() has comment explaining ID format choice
2. Tests document expected behavior clearly
3. No inline object literals remain in bufferEnumNodes()

---

## Summary

This migration is straightforward because:
1. EnumNode factory already exists and works correctly
2. Pattern is identical to InterfaceNode migration (REG-103)
3. Only one method needs updating: `bufferEnumNodes()`
4. No breaking changes to external APIs

**Estimated effort:** 30-45 minutes including tests

**Risk level:** Low (following established pattern)

**Dependencies:** None (EnumNode factory complete)

---

**Joel Spolsky** - "Make it crystal clear, make it impossible to get wrong."

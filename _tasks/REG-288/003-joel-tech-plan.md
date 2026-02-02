# Joel Spolsky's Technical Plan: REG-288 - Track UpdateExpression modifications

## Overview

Implement first-class graph representation for UpdateExpression (i++, --count) following the VariableReassignment pattern from REG-290. This replaces the current SCOPE-based tracking with proper UPDATE_EXPRESSION nodes and edges.

**Pattern to follow:** REG-290 VariableReassignment implementation
- File: `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts` lines 1380-1401, 3917-4026
- File: `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` lines 1753-1876
- Test: `/Users/vadimr/grafema-worker-4/test/unit/VariableReassignment.test.js`

---

## Phase 1: Add UpdateExpressionInfo Type

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/types.ts`

### 1.1 Add UpdateExpressionInfo interface (after VariableReassignmentInfo, around line 654)

```typescript
// === UPDATE EXPRESSION INFO ===
/**
 * Tracks update expressions (i++, --count) for UPDATE_EXPRESSION node creation.
 * Used to create MODIFIES edges and READS_FROM self-loops.
 *
 * Edge direction:
 * - UPDATE_EXPRESSION --MODIFIES--> VARIABLE
 * - VARIABLE --READS_FROM--> VARIABLE (self-loop)
 *
 * Distinction from VariableReassignmentInfo:
 * - UpdateExpression: i++, --count -> UPDATE_EXPRESSION node
 * - AssignmentExpression: x += 1 -> FLOWS_INTO edge (no dedicated node)
 *
 * Both are read+write operations and create READS_FROM self-loops.
 */
export interface UpdateExpressionInfo {
  variableName: string;           // Name of variable being modified
  variableLine: number;           // Line where variable is referenced
  operator: '++' | '--';          // Increment or decrement
  prefix: boolean;                // ++i (true) vs i++ (false)
  file: string;
  line: number;                   // Line of update expression
  column: number;
  parentScopeId?: string;         // Containing scope for CONTAINS edge
}
```

**Exact location:** Insert after line 653 (end of VariableReassignmentInfo)

### 1.2 Add to ASTCollections interface (line 675-729)

Find the collections list around line 705 and add:

```typescript
  // Variable reassignment tracking for FLOWS_INTO edges (REG-290)
  variableReassignments?: VariableReassignmentInfo[];
  // Update expression tracking for UPDATE_EXPRESSION nodes (REG-288)
  updateExpressions?: UpdateExpressionInfo[];  // ADD THIS LINE
  // Return statement tracking for RETURNS edges
  returnStatements?: ReturnStatementInfo[];
```

**Exact location:** After line 706 (variableReassignments), before returnStatements

---

## Phase 2: Collect UpdateExpressions at Module Level

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

### 2.1 Add module-level UpdateExpression visitor (after traverse_assignments, before traverse_classes)

**Location:** After line 1401 (end of traverse_assignments), before line 1403 (traverse_classes)

**Code to add:**

```typescript
      this.profiler.end('traverse_assignments');

      // UpdateExpression (module-level: count++, --total)
      this.profiler.start('traverse_updates');

      // Initialize collection if not exists
      if (!allCollections.updateExpressions) {
        allCollections.updateExpressions = [];
      }
      const updateExpressions = allCollections.updateExpressions as UpdateExpressionInfo[];

      traverse(ast, {
        UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
          const functionParent = updatePath.getFunctionParent();
          if (functionParent) return;  // Skip function-level, handled elsewhere

          this.collectUpdateExpression(updatePath.node, module, updateExpressions, undefined);
        }
      });
      this.profiler.end('traverse_updates');

      // Classes
      this.profiler.start('traverse_classes');
```

**Notes:**
- Pattern matches traverse_assignments (lines 1323-1401)
- `parentScopeId` is undefined for module-level

---

## Phase 3: Collect UpdateExpressions at Function Level

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

### 3.1 Replace existing UpdateExpression visitor (lines 3299-3321)

**Current code to REPLACE:**

```typescript
      UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
        const updateNode = updatePath.node;
        if (updateNode.argument.type === 'Identifier') {
          const varName = updateNode.argument.name;

          // Find variable by name - could be from parent scope or declarations
          const fromParentScope = Array.from(parentScopeVariables).find(v => v.name === varName);
          const fromDeclarations = variableDeclarations.find(v => v.name === varName);
          const variable = fromParentScope ?? fromDeclarations;

          if (variable) {
            const scope = scopes.find(s => s.id === parentScopeId);
            if (scope) {
              if (!scope.modifies) scope.modifies = [];
              scope.modifies.push({
                variableId: variable.id,
                variableName: varName,
                line: getLine(updateNode)
              });
            }
          }
        }
      },
```

**NEW code:**

```typescript
      UpdateExpression: (updatePath: NodePath<t.UpdateExpression>) => {
        // Initialize collection if not exists
        if (!collections.updateExpressions) {
          collections.updateExpressions = [];
        }
        const updateExpressions = collections.updateExpressions as UpdateExpressionInfo[];

        this.collectUpdateExpression(updatePath.node, module, updateExpressions, parentScopeId);
      },
```

**Exact location:** Replace lines 3299-3321

---

## Phase 4: Implement collectUpdateExpression Helper

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/JSASTAnalyzer.ts`

### 4.1 Add helper method (after detectVariableReassignment, around line 4027)

**Location:** After line 4026 (end of detectVariableReassignment method)

**Code to add:**

```typescript
  /**
   * Collect UpdateExpression metadata (i++, --count)
   *
   * Similar to detectVariableReassignment but creates UPDATE_EXPRESSION nodes instead of FLOWS_INTO edges.
   * Both create READS_FROM self-loops since they read current value before modifying.
   *
   * REG-288: First-class graph representation for update expressions
   */
  private collectUpdateExpression(
    updateNode: t.UpdateExpression,
    module: VisitorModule,
    updateExpressions: UpdateExpressionInfo[],
    parentScopeId: string | undefined
  ): void {
    // Only handle simple identifiers (i++, --count)
    // Ignore member expressions (obj.prop++, arr[i]++) - will be handled separately
    if (updateNode.argument.type !== 'Identifier') {
      return;
    }

    const variableName = updateNode.argument.name;
    const operator = updateNode.operator as '++' | '--';
    const prefix = updateNode.prefix;
    const line = getLine(updateNode);
    const column = getColumn(updateNode);

    updateExpressions.push({
      variableName,
      variableLine: getLine(updateNode.argument),
      operator,
      prefix,
      file: module.file,
      line,
      column,
      parentScopeId
    });
  }
```

**Notes:**
- Uses same imports as detectVariableReassignment (getLine, getColumn)
- Pattern matches detectVariableReassignment structure
- Only handles Identifier (matches current UpdateExpression visitor line 3301)

---

## Phase 5: Create Graph Nodes and Edges

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### 5.1 Add to build() method (line 106-319)

**Location 1:** Extract updateExpressions from data parameter (after variableReassignments, around line 138)

Find this section:
```typescript
      // Variable reassignment tracking for FLOWS_INTO edges (REG-290)
      variableReassignments = [],
```

Add after it:
```typescript
      // Variable reassignment tracking for FLOWS_INTO edges (REG-290)
      variableReassignments = [],
      // Update expression tracking for UPDATE_EXPRESSION nodes (REG-288)
      updateExpressions = [],
```

**Location 2:** Add bufferUpdateExpressionEdges call (after bufferVariableReassignmentEdges, around line 306)

Find this section:
```typescript
    // 28. Buffer FLOWS_INTO edges for variable reassignments (REG-290)
    this.bufferVariableReassignmentEdges(variableReassignments, variableDeclarations, callSites, methodCalls, parameters);

    // 29. Buffer RETURNS edges for return statements
```

Add between them:
```typescript
    // 28. Buffer FLOWS_INTO edges for variable reassignments (REG-290)
    this.bufferVariableReassignmentEdges(variableReassignments, variableDeclarations, callSites, methodCalls, parameters);

    // 28.5. Buffer UPDATE_EXPRESSION nodes and MODIFIES/READS_FROM edges (REG-288)
    this.bufferUpdateExpressionEdges(updateExpressions, variableDeclarations, parameters);

    // 29. Buffer RETURNS edges for return statements
```

### 5.2 Implement bufferUpdateExpressionEdges method (after bufferVariableReassignmentEdges, around line 1876)

**Location:** After line 1876 (end of bufferVariableReassignmentEdges)

**Code to add:**

```typescript
  /**
   * Buffer UPDATE_EXPRESSION nodes and edges for update expressions (i++, --count).
   *
   * Creates:
   * - UPDATE_EXPRESSION node
   * - UPDATE_EXPRESSION --MODIFIES--> VARIABLE
   * - VARIABLE --READS_FROM--> VARIABLE (self-loop, reads current value)
   * - SCOPE --CONTAINS--> UPDATE_EXPRESSION (if parentScopeId exists)
   *
   * Pattern matches bufferVariableReassignmentEdges (compound operators create READS_FROM self-loops).
   *
   * REG-288: First-class graph representation for update expressions
   */
  private bufferUpdateExpressionEdges(
    updateExpressions: UpdateExpressionInfo[],
    variableDeclarations: VariableDeclarationInfo[],
    parameters: ParameterInfo[]
  ): void {
    // Build lookup cache: O(n) instead of O(n*m)
    const varLookup = new Map<string, VariableDeclarationInfo>();
    for (const v of variableDeclarations) {
      varLookup.set(`${v.file}:${v.name}`, v);
    }

    const paramLookup = new Map<string, ParameterInfo>();
    for (const p of parameters) {
      paramLookup.set(`${p.file}:${p.name}`, p);
    }

    for (const update of updateExpressions) {
      const {
        variableName,
        operator,
        prefix,
        file,
        line,
        column,
        parentScopeId
      } = update;

      // Find target variable node
      const targetVar = varLookup.get(`${file}:${variableName}`);
      const targetParam = !targetVar ? paramLookup.get(`${file}:${variableName}`) : null;
      const targetNodeId = targetVar?.id ?? targetParam?.id;

      if (!targetNodeId) {
        // Variable not found - could be module-level or external reference
        continue;
      }

      // Create UPDATE_EXPRESSION node
      // ID format: {file}:UPDATE_EXPRESSION:{operator}:{line}:{column}
      const updateId = `${file}:UPDATE_EXPRESSION:${operator}:${line}:${column}`;

      this._bufferNode({
        type: 'UPDATE_EXPRESSION',
        id: updateId,
        name: `${prefix ? operator : ''}${variableName}${prefix ? '' : operator}`,
        operator,
        prefix,
        variableName,  // Store for queries
        file,
        line,
        column
      });

      // Create READS_FROM self-loop
      // UpdateExpression always reads current value (like compound assignment x += 1)
      this._bufferEdge({
        type: 'READS_FROM',
        src: targetNodeId,  // Variable reads from...
        dst: targetNodeId   // ...itself (self-loop)
      });

      // Create MODIFIES edge
      // UPDATE_EXPRESSION modifies the variable
      this._bufferEdge({
        type: 'MODIFIES',
        src: updateId,       // UPDATE_EXPRESSION node
        dst: targetNodeId    // VARIABLE node
      });

      // Create CONTAINS edge (if scope exists)
      if (parentScopeId) {
        this._bufferEdge({
          type: 'CONTAINS',
          src: parentScopeId,
          dst: updateId
        });
      }
    }
  }
```

**Notes:**
- Pattern exactly matches bufferVariableReassignmentEdges (lines 1753-1876)
- Uses same lookup cache optimization
- ID format: `{file}:UPDATE_EXPRESSION:{operator}:{line}:{column}` (matches EXPRESSION ID pattern)
- Name format: `++i` (prefix=true) or `i++` (prefix=false)

---

## Phase 6: Remove Old MODIFIES Mechanism

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/types.ts`

### 6.1 Remove modifies field from ScopeInfo (line 65)

**Current code (line 51-66):**

```typescript
export interface ScopeInfo {
  id: string;
  type: 'SCOPE';
  scopeType: string;
  name?: string;
  semanticId?: string;  // Stable ID for diff comparison (e.g., "MyClass->myMethod:if_statement[0]")
  conditional?: boolean;
  condition?: string;
  constraints?: unknown[];
  file?: string;
  line: number;
  parentScopeId?: string;
  parentFunctionId?: string;
  capturesFrom?: string;
  modifies?: Array<{ variableId: string; variableName: string; line: number }>;
}
```

**NEW code:**

```typescript
export interface ScopeInfo {
  id: string;
  type: 'SCOPE';
  scopeType: string;
  name?: string;
  semanticId?: string;  // Stable ID for diff comparison (e.g., "MyClass->myMethod:if_statement[0]")
  conditional?: boolean;
  condition?: string;
  constraints?: unknown[];
  file?: string;
  line: number;
  parentScopeId?: string;
  parentFunctionId?: string;
  capturesFrom?: string;
  // modifies field removed - REG-288: MODIFIES edges now come from UPDATE_EXPRESSION nodes
}
```

**Exact location:** Remove line 65 (modifies field)

**File:** `/Users/vadimr/grafema-worker-4/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### 6.2 Remove MODIFIES edge creation from bufferScopeEdges (lines 379-388)

**Current code:**

```typescript
      // MODIFIES - scope модифицирует переменные (count++)
      if (modifies && modifies.length > 0) {
        for (const mod of modifies) {
          this._bufferEdge({
            type: 'MODIFIES',
            src: scopeData.id,
            dst: mod.variableId
          });
        }
      }
```

**Action:** DELETE lines 379-388 entirely

**Note:** Leave CAPTURES section (lines 367-377) unchanged

---

## Phase 7: Write Tests

**File:** `/Users/vadimr/grafema-worker-4/test/unit/UpdateExpression.test.js` (NEW FILE)

### 7.1 Create test file

**Pattern:** Copy structure from `/Users/vadimr/grafema-worker-4/test/unit/VariableReassignment.test.js` lines 1-150

**Test cases to write:**

```javascript
/**
 * Tests for Update Expression Tracking (UPDATE_EXPRESSION nodes and MODIFIES/READS_FROM edges)
 *
 * REG-288: Track UpdateExpression modifications with first-class graph nodes.
 *
 * When code does i++, --count, etc., we create:
 * - UPDATE_EXPRESSION node
 * - UPDATE_EXPRESSION --MODIFIES--> VARIABLE
 * - VARIABLE --READS_FROM--> VARIABLE (self-loop)
 * - SCOPE --CONTAINS--> UPDATE_EXPRESSION
 *
 * This is the TDD test file for REG-288.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';

import { createTestBackend } from '../helpers/TestRFDB.js';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';

let testCounter = 0;

async function setupTest(backend, files) {
  const testDir = join(tmpdir(), `navi-test-update-expr-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(
    join(testDir, 'package.json'),
    JSON.stringify({
      name: `test-update-expr-${testCounter}`,
      type: 'module'
    })
  );

  for (const [filename, content] of Object.entries(files)) {
    writeFileSync(join(testDir, filename), content);
  }

  const orchestrator = createTestOrchestrator(backend);
  await orchestrator.run(testDir);

  return { testDir };
}

describe('Update Expression Tracking', () => {
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

  describe('Postfix increment (i++)', () => {
    it('should create UPDATE_EXPRESSION node', async () => {
      await setupTest(backend, {
        'index.js': `
let count = 0;
count++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'count');

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created');
      assert.strictEqual(updateNode.operator, '++');
      assert.strictEqual(updateNode.prefix, false);
      assert.strictEqual(updateNode.name, 'count++');
    });

    it('should create MODIFIES edge', async () => {
      await setupTest(backend, {
        'index.js': `
let count = 0;
count++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const countVar = allNodes.find(n => n.name === 'count' && n.type === 'VARIABLE');
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'count');

      assert.ok(countVar, 'Variable "count" not found');
      assert.ok(updateNode, 'UPDATE_EXPRESSION node not found');

      const modifies = allEdges.find(e =>
        e.type === 'MODIFIES' &&
        e.src === updateNode.id &&
        e.dst === countVar.id
      );

      assert.ok(
        modifies,
        `Expected MODIFIES edge from UPDATE_EXPRESSION to count. Found: ${JSON.stringify(allEdges.filter(e => e.type === 'MODIFIES'))}`
      );
    });

    it('should create READS_FROM self-loop', async () => {
      await setupTest(backend, {
        'index.js': `
let i = 0;
i++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const iVar = allNodes.find(n => n.name === 'i' && n.type === 'VARIABLE');
      assert.ok(iVar, 'Variable "i" not found');

      const readsFrom = allEdges.find(e =>
        e.type === 'READS_FROM' &&
        e.src === iVar.id &&
        e.dst === iVar.id
      );

      assert.ok(
        readsFrom,
        'READS_FROM self-loop not created (i++ reads current value before incrementing)'
      );
    });
  });

  describe('Prefix increment (++i)', () => {
    it('should create UPDATE_EXPRESSION node with prefix=true', async () => {
      await setupTest(backend, {
        'index.js': `
let count = 0;
++count;
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'count');

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created');
      assert.strictEqual(updateNode.operator, '++');
      assert.strictEqual(updateNode.prefix, true);
      assert.strictEqual(updateNode.name, '++count');
    });
  });

  describe('Decrement (--)', () => {
    it('should create UPDATE_EXPRESSION node for postfix decrement', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 10;
total--;
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'total');

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created');
      assert.strictEqual(updateNode.operator, '--');
      assert.strictEqual(updateNode.prefix, false);
      assert.strictEqual(updateNode.name, 'total--');
    });

    it('should create UPDATE_EXPRESSION node for prefix decrement', async () => {
      await setupTest(backend, {
        'index.js': `
let total = 10;
--total;
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'total');

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created');
      assert.strictEqual(updateNode.operator, '--');
      assert.strictEqual(updateNode.prefix, true);
      assert.strictEqual(updateNode.name, '--total');
    });
  });

  describe('Function-level updates', () => {
    it('should track updates inside functions', async () => {
      await setupTest(backend, {
        'index.js': `
function increment() {
  let count = 0;
  count++;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'count');
      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created inside function');

      // Verify CONTAINS edge from SCOPE to UPDATE_EXPRESSION
      const contains = allEdges.find(e =>
        e.type === 'CONTAINS' &&
        e.dst === updateNode.id
      );
      assert.ok(contains, 'CONTAINS edge from SCOPE to UPDATE_EXPRESSION not created');
    });
  });

  describe('Module-level updates', () => {
    it('should track updates at module level', async () => {
      await setupTest(backend, {
        'index.js': `
let moduleCounter = 0;
moduleCounter++;
        `
      });

      const allNodes = await backend.getAllNodes();
      const updateNode = allNodes.find(n => n.type === 'UPDATE_EXPRESSION' && n.variableName === 'moduleCounter');

      assert.ok(updateNode, 'UPDATE_EXPRESSION node not created at module level');
    });
  });

  describe('No MODIFIES edges from SCOPE (old mechanism removed)', () => {
    it('should NOT create SCOPE --MODIFIES--> VARIABLE edge', async () => {
      await setupTest(backend, {
        'index.js': `
function test() {
  let x = 0;
  x++;
}
        `
      });

      const allNodes = await backend.getAllNodes();
      const allEdges = await backend.getAllEdges();

      const xVar = allNodes.find(n => n.name === 'x' && n.type === 'VARIABLE');
      assert.ok(xVar, 'Variable "x" not found');

      // OLD mechanism: SCOPE --MODIFIES--> VARIABLE
      const scopeModifies = allEdges.find(e =>
        e.type === 'MODIFIES' &&
        e.dst === xVar.id &&
        allNodes.find(n => n.id === e.src)?.type === 'SCOPE'
      );

      assert.strictEqual(
        scopeModifies, undefined,
        'SCOPE --MODIFIES--> edge should NOT exist (old mechanism removed)'
      );

      // NEW mechanism: UPDATE_EXPRESSION --MODIFIES--> VARIABLE
      const updateModifies = allEdges.find(e =>
        e.type === 'MODIFIES' &&
        e.dst === xVar.id &&
        allNodes.find(n => n.id === e.src)?.type === 'UPDATE_EXPRESSION'
      );

      assert.ok(
        updateModifies,
        'UPDATE_EXPRESSION --MODIFIES--> edge should exist (new mechanism)'
      );
    });
  });
});
```

---

## Summary of Changes

### Files Modified

1. **types.ts** (3 changes)
   - Add UpdateExpressionInfo interface (after line 653)
   - Add updateExpressions to ASTCollections (after line 706)
   - Remove modifies from ScopeInfo (delete line 65)

2. **JSASTAnalyzer.ts** (3 changes)
   - Add module-level UpdateExpression visitor (after line 1401)
   - Replace function-level UpdateExpression visitor (lines 3299-3321)
   - Add collectUpdateExpression helper method (after line 4026)

3. **GraphBuilder.ts** (4 changes)
   - Extract updateExpressions from data (after line 138)
   - Call bufferUpdateExpressionEdges (after line 306)
   - Implement bufferUpdateExpressionEdges method (after line 1876)
   - Remove MODIFIES edge creation from bufferScopeEdges (delete lines 379-388)

4. **UpdateExpression.test.js** (NEW FILE)
   - Create comprehensive test suite

### Edge Changes

**REMOVED:**
- `SCOPE --MODIFIES--> VARIABLE` (old mechanism)

**ADDED:**
- `UPDATE_EXPRESSION --MODIFIES--> VARIABLE`
- `VARIABLE --READS_FROM--> VARIABLE` (self-loop)
- `SCOPE --CONTAINS--> UPDATE_EXPRESSION`

### Node Changes

**ADDED:**
- `UPDATE_EXPRESSION` node type
  - Properties: id, type, name, operator, prefix, variableName, file, line, column

---

## Implementation Order

1. **Phase 1:** Add types (types.ts) - enables compilation
2. **Phase 7:** Write tests (UpdateExpression.test.js) - TDD, tests should fail
3. **Phase 4:** Implement collectUpdateExpression helper (JSASTAnalyzer.ts)
4. **Phase 2:** Add module-level collection (JSASTAnalyzer.ts)
5. **Phase 3:** Replace function-level collection (JSASTAnalyzer.ts)
6. **Phase 5:** Implement graph builder (GraphBuilder.ts)
7. **Phase 6:** Remove old mechanism (types.ts, GraphBuilder.ts)
8. **Run tests** - should pass

---

## Acceptance Criteria

1. **Graph nodes created:**
   ```javascript
   let count = 0;
   count++;
   ```
   Creates: UPDATE_EXPRESSION node with operator="++"

2. **Edges created:**
   - `UPDATE_EXPRESSION --MODIFIES--> count`
   - `count --READS_FROM--> count` (self-loop)
   - `SCOPE --CONTAINS--> UPDATE_EXPRESSION`

3. **Both prefix and postfix work:**
   - `i++` → prefix=false, name="i++"
   - `++i` → prefix=true, name="++i"

4. **Module and function level:**
   - Module-level: `count++` at top level
   - Function-level: `count++` inside function

5. **No regression:**
   - Existing tests pass
   - No SCOPE --MODIFIES--> edges exist

---

## Risk Assessment

**LOW RISK:**
- Additive change (new nodes, new edges)
- Clear pattern to follow (VariableReassignment)
- Small scope (UpdateExpression with Identifier only)

**MEDIUM RISK:**
- Breaking change to MODIFIES semantics
- Mitigation: comprehensive tests, parallel implementation before removal

**Timeline:** 2-3 hours (straightforward implementation, mostly mechanical).

---

## Notes for Implementation

1. **Import requirements:**
   - JSASTAnalyzer: Already imports `getLine`, `getColumn`, `traverse`, `NodePath`
   - GraphBuilder: No new imports needed
   - UpdateExpressionInfo already exported from types.ts

2. **ID format convention:**
   - Pattern: `{file}:UPDATE_EXPRESSION:{operator}:{line}:{column}`
   - Example: `index.js:UPDATE_EXPRESSION:++:42:10`

3. **Member expressions (out of scope):**
   - `arr[i]++`, `obj.prop++` will be ignored (updateNode.argument.type !== 'Identifier')
   - Create follow-up issue if needed

4. **Consistency with REG-290:**
   - Both UpdateExpression and compound assignment (x += 1) create READS_FROM self-loops
   - UpdateExpression creates UPDATE_EXPRESSION node + MODIFIES edge
   - AssignmentExpression creates FLOWS_INTO edge (no dedicated node)

---

**END OF TECHNICAL PLAN**

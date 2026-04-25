# Joel Spolsky's Revised Technical Implementation Plan: REG-99 ClassNode Migration

**Date:** 2025-01-22
**Revision:** Based on Don's approved plan
**Status:** Ready for Kent (tests) and Rob (implementation)

---

## Executive Summary

This plan breaks down Don's approved approach into atomic, testable code changes. Each change includes exact before/after snippets, validation requirements, and test coverage specifications.

**Key principles:**
1. ClassVisitor ALWAYS uses `ClassNode.createWithContext()` (has ScopeTracker)
2. Workers ALWAYS use `ClassNode.create()` (no ScopeTracker, legacy IDs)
3. GraphBuilder computes superclass IDs, NEVER creates placeholder nodes
4. All changes are atomic and independently testable

---

## Implementation Order

**Phase 1:** ClassVisitor (highest value, semantic IDs immediately)
**Phase 2:** ASTWorker (consistency, no inline strings)
**Phase 3:** QueueWorker (consistency, no inline strings)
**Phase 4:** GraphBuilder superclass edges (no fake nodes)
**Phase 5:** Validation (grep test, documentation)

Each phase must:
- Pass all tests before proceeding to next phase
- Be committable independently
- Not break existing functionality

---

## Phase 1: ClassVisitor - Semantic IDs

### File: `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts`

### Change 1.1: Replace inline CLASS ID with ClassNode.createWithContext()

**Location:** Lines 171-175

**Current code:**
```typescript
const classId = `CLASS#${className}#${module.file}#${classNode.loc!.start.line}`;
const superClassName = classNode.superClass?.type === 'Identifier'
  ? (classNode.superClass as Identifier).name
  : null;
```

**New code:**
```typescript
// Extract superClass name
const superClassName = classNode.superClass?.type === 'Identifier'
  ? (classNode.superClass as Identifier).name
  : null;

// Create CLASS node using NodeFactory with semantic ID
const classRecord = ClassNode.createWithContext(
  className,
  scopeTracker!.getContext(),
  { line: classNode.loc!.start.line, column: classNode.loc!.start.column },
  { superClass: superClassName || undefined }
);
```

**Dependencies:**
- Import ClassNode at top of file
- ScopeTracker is guaranteed available (constructor enforces it)

**What changed:**
- No inline ID string creation
- Uses ClassNode.createWithContext() for semantic IDs
- Passes ScopeTracker context for stable IDs
- superClass moved to options

**Tests must verify:**
- ClassNode.createWithContext() called with correct arguments
- Semantic ID format: `{file}->{scope_path}->CLASS->{name}`
- superClass passed in options when present
- Line and column captured in location

---

### Change 1.2: Remove manual semantic ID computation

**Location:** Lines 177-181

**Current code:**
```typescript
// Generate semantic ID if scopeTracker available
let classSemanticId: string | undefined;
if (scopeTracker) {
  classSemanticId = computeSemanticId('CLASS', className, scopeTracker.getContext());
}
```

**New code:**
```typescript
// Remove this block - ClassNode.createWithContext() handles semantic IDs
```

**What changed:**
- ClassNode API handles semantic ID generation internally
- No manual computeSemanticId() call needed

**Tests must verify:**
- No duplicate semantic ID computation
- ClassRecord has correct semantic ID from ClassNode

---

### Change 1.3: Update ClassInfo to extend ClassNodeRecord

**Location:** Lines 33-44 (interface definition)

**Current code:**
```typescript
interface ClassInfo {
  id: string;
  semanticId?: string;
  type: 'CLASS';
  name: string;
  file: string;
  line: number;
  column: number;
  superClass: string | null;
  implements?: string[];  // TypeScript implements
  methods: string[];
}
```

**New code:**
```typescript
/**
 * Class declaration info
 * Extends ClassNodeRecord with TypeScript-specific metadata
 */
interface ClassInfo extends ClassNodeRecord {
  implements?: string[];  // TypeScript implements (visitor extension)
}
```

**Dependencies:**
- Import ClassNodeRecord from ClassNode

**What changed:**
- ClassInfo extends ClassNodeRecord (DRY)
- implements remains as TypeScript-specific extension
- All CLASS node fields come from ClassNodeRecord

**Tests must verify:**
- ClassInfo has all ClassNodeRecord fields
- implements field is optional TypeScript extension

---

### Change 1.4: Update classDeclarations.push() to use ClassInfo structure

**Location:** Lines 194-205

**Current code:**
```typescript
(classDeclarations as ClassInfo[]).push({
  id: classId,
  semanticId: classSemanticId,
  type: 'CLASS',
  name: className,
  file: module.file,
  line: classNode.loc!.start.line,
  column: classNode.loc!.start.column,
  superClass: superClassName,
  implements: implementsNames.length > 0 ? implementsNames : undefined,
  methods: []
});
```

**New code:**
```typescript
// Store ClassNodeRecord + TypeScript metadata
(classDeclarations as ClassInfo[]).push({
  ...classRecord,
  implements: implementsNames.length > 0 ? implementsNames : undefined
});
```

**What changed:**
- Spread classRecord from ClassNode.createWithContext()
- Add implements as TypeScript extension
- No manual field construction

**Tests must verify:**
- ClassInfo contains all ClassNodeRecord fields
- implements field added correctly when present
- methods array initialized empty

---

### Change 1.5: Add required imports

**Location:** Lines 1-28 (top of file)

**Current imports:**
```typescript
import { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
```

**New imports:**
```typescript
import { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { ClassNode, type ClassNodeRecord } from '../../../../core/nodes/ClassNode.js';
```

**What changed:**
- Import ClassNode factory
- Import ClassNodeRecord type
- Remove computeSemanticId (no longer needed)

---

### Change 1.6: Enforce ScopeTracker requirement in constructor

**Location:** Lines 92-101

**Current code:**
```typescript
constructor(
  module: VisitorModule,
  collections: VisitorCollections,
  analyzeFunctionBody: AnalyzeFunctionBodyCallback,
  scopeTracker?: ScopeTracker
) {
  super(module, collections);
  this.analyzeFunctionBody = analyzeFunctionBody;
  this.scopeTracker = scopeTracker;
}
```

**New code:**
```typescript
/**
 * @param module - Current module being analyzed
 * @param collections - Must contain arrays and counter refs
 * @param analyzeFunctionBody - Callback to analyze method internals
 * @param scopeTracker - REQUIRED for semantic ID generation
 */
constructor(
  module: VisitorModule,
  collections: VisitorCollections,
  analyzeFunctionBody: AnalyzeFunctionBodyCallback,
  scopeTracker: ScopeTracker  // REQUIRED, not optional
) {
  super(module, collections);
  this.analyzeFunctionBody = analyzeFunctionBody;
  this.scopeTracker = scopeTracker;
}
```

**What changed:**
- scopeTracker parameter no longer optional
- Documentation clarifies it's REQUIRED
- Private field scopeTracker type changes from `ScopeTracker?` to `ScopeTracker`

**Location:** Line 84

**Current code:**
```typescript
private scopeTracker?: ScopeTracker;
```

**New code:**
```typescript
private scopeTracker: ScopeTracker;
```

**Tests must verify:**
- Constructor throws if scopeTracker not provided (optional: can add validation)
- All call sites pass ScopeTracker

---

### Tests for Phase 1 (ClassVisitor)

Kent must write tests that verify:

1. **Semantic ID generation:**
   - CLASS node has semantic ID format: `{file}->{scope_path}->CLASS->{name}`
   - Nested classes get correct scope path
   - Top-level classes have `global` scope

2. **ClassNodeRecord structure:**
   - All required fields present: id, type, name, file, line, column
   - superClass field populated when present
   - methods array initialized empty
   - exported field defaults to false

3. **TypeScript extension:**
   - implements field added when TypeScript implements clause present
   - implements field omitted when no implements clause

4. **No inline ID strings:**
   - No `CLASS#` strings in generated IDs
   - All IDs come from ClassNode.createWithContext()

5. **Integration:**
   - Analyze class with superclass → correct superClass in options
   - Analyze class with implements → implements in ClassInfo
   - Analyze nested class → correct semantic ID with scope path

**Test files to create:**
- `test/unit/ClassVisitor.createWithContext.test.js` - ClassNode API usage
- `test/unit/ClassVisitor.semanticIds.test.js` - Semantic ID formats
- `test/unit/ClassVisitor.typescript.test.js` - implements extension

---

## Phase 2: ASTWorker - Legacy IDs

### File: `/Users/vadimr/grafema/packages/core/src/core/ASTWorker.ts`

### Change 2.1: Replace inline CLASS ID with ClassNode.create()

**Location:** Lines 455-470

**Current code:**
```typescript
ClassDeclaration(path: NodePath<ClassDeclaration>) {
  if (path.getFunctionParent()) return;

  const node = path.node;
  if (!node.id) return;

  const className = node.id.name;
  const classId = `CLASS#${className}#${filePath}#${node.loc!.start.line}`;

  collections.classDeclarations.push({
    id: classId,
    type: 'CLASS',
    name: className,
    file: filePath,
    line: node.loc!.start.line,
    superClass: (node.superClass as Identifier)?.name || null
  });
```

**New code:**
```typescript
ClassDeclaration(path: NodePath<ClassDeclaration>) {
  if (path.getFunctionParent()) return;

  const node = path.node;
  if (!node.id) return;

  const className = node.id.name;

  // Extract superClass name
  const superClassName = node.superClass && node.superClass.type === 'Identifier'
    ? (node.superClass as Identifier).name
    : null;

  // Create CLASS node using ClassNode.create() (legacy format for workers)
  const classRecord = ClassNode.create(
    className,
    filePath,
    node.loc!.start.line,
    node.loc!.start.column || 0,
    { superClass: superClassName || undefined }
  );

  collections.classDeclarations.push(classRecord);
```

**What changed:**
- No inline ID string `CLASS#${className}#${filePath}#${line}`
- Uses ClassNode.create() for legacy line-based IDs
- superClass moved to options
- Returns ClassNodeRecord structure

**Tests must verify:**
- ClassNode.create() called with correct arguments
- Legacy ID format: `{file}:CLASS:{name}:{line}`
- superClass passed in options when present
- ClassNodeRecord structure returned

---

### Change 2.2: Update ClassDeclarationNode interface

**Location:** Lines 125-133

**Current code:**
```typescript
interface ClassDeclarationNode {
  id: string;
  type: 'CLASS';
  name: string;
  file: string;
  line: number;
  superClass: string | null;
}
```

**New code:**
```typescript
/**
 * Class declaration node (matches ClassNodeRecord from ClassNode factory)
 * Workers use legacy line-based IDs
 */
interface ClassDeclarationNode extends ClassNodeRecord {
  // All fields inherited from ClassNodeRecord
}
```

**Dependencies:**
- Import ClassNodeRecord from ClassNode

**What changed:**
- Extends ClassNodeRecord (type compatibility)
- Documents that workers use legacy IDs

**Tests must verify:**
- ClassDeclarationNode compatible with ClassNodeRecord
- ASTCollections.classDeclarations type-checks

---

### Change 2.3: Add required imports

**Location:** Top of file

**Add import:**
```typescript
import { ClassNode, type ClassNodeRecord } from './nodes/ClassNode.js';
```

---

### Tests for Phase 2 (ASTWorker)

Kent must write tests that verify:

1. **Legacy ID format:**
   - CLASS node has format: `{file}:CLASS:{name}:{line}`
   - No `CLASS#` separator in ID

2. **ClassNodeRecord structure:**
   - All required fields present
   - superClass field populated when present
   - methods array present (empty in workers)

3. **No inline strings:**
   - No manual ID construction
   - All IDs come from ClassNode.create()

4. **Integration:**
   - Parse file with class → ClassNodeRecord in collections
   - Parse class with superclass → superClass in record

**Test files to create:**
- `test/unit/ASTWorker.classNode.test.js` - ClassNode.create() usage

---

## Phase 3: QueueWorker - Legacy IDs

### File: `/Users/vadimr/grafema/packages/core/src/core/QueueWorker.ts`

### Change 3.1: Replace inline CLASS ID with ClassNode.create()

**Location:** Lines 316-335

**Current code:**
```typescript
ClassDeclaration(path: NodePath<t.ClassDeclaration>) {
  if (path.getFunctionParent()) return;

  const node = path.node;
  if (!node.id) return;

  const className = node.id.name;
  const line = node.loc?.start.line || 0;
  const classId = `CLASS#${className}#${filePath}#${line}`;

  nodes.push({
    id: classId,
    type: 'CLASS',
    name: className,
    file: filePath,
    line,
    superClass: node.superClass && node.superClass.type === 'Identifier' ? node.superClass.name : null,
  });

  edges.push({ src: moduleId, dst: classId, type: 'CONTAINS' });
```

**New code:**
```typescript
ClassDeclaration(path: NodePath<t.ClassDeclaration>) {
  if (path.getFunctionParent()) return;

  const node = path.node;
  if (!node.id) return;

  const className = node.id.name;
  const line = node.loc?.start.line || 0;
  const column = node.loc?.start.column || 0;

  // Extract superClass name
  const superClassName = node.superClass && node.superClass.type === 'Identifier'
    ? node.superClass.name
    : null;

  // Create CLASS node using ClassNode.create() (legacy format for workers)
  const classRecord = ClassNode.create(
    className,
    filePath,
    line,
    column,
    { superClass: superClassName || undefined }
  );

  nodes.push(classRecord as unknown as GraphNode);

  edges.push({ src: moduleId, dst: classRecord.id, type: 'CONTAINS' });
```

**What changed:**
- No inline ID string `CLASS#${className}#${filePath}#${line}`
- Uses ClassNode.create() for legacy IDs
- superClass moved to options
- Use classRecord.id for edge dst

**Tests must verify:**
- ClassNode.create() called with correct arguments
- Legacy ID format: `{file}:CLASS:{name}:{line}`
- CONTAINS edge uses classRecord.id
- Node added to graph with all ClassNodeRecord fields

---

### Change 3.2: Add required imports

**Location:** Top of file (after other imports)

**Add import:**
```typescript
import { ClassNode, type ClassNodeRecord } from './nodes/ClassNode.js';
```

---

### Tests for Phase 3 (QueueWorker)

Kent must write tests that verify:

1. **Legacy ID format:**
   - CLASS node has format: `{file}:CLASS:{name}:{line}`
   - No `CLASS#` separator in ID

2. **RFDB integration:**
   - Node written to RFDB with all ClassNodeRecord fields
   - CONTAINS edge created with correct ID

3. **No inline strings:**
   - No manual ID construction
   - All IDs come from ClassNode.create()

**Test files to create:**
- `test/unit/QueueWorker.classNode.test.js` - ClassNode.create() usage in worker context

---

## Phase 4: GraphBuilder - Superclass Edges

### File: `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts`

### Change 4.1: Compute superclass ID instead of creating node

**Location:** Lines 393-428 (bufferClassDeclarationNodes method)

**Current code:**
```typescript
private bufferClassDeclarationNodes(classDeclarations: ClassDeclarationInfo[]): void {
  for (const classDecl of classDeclarations) {
    const { id, type, name, file, line, column, superClass, methods } = classDecl;

    // Buffer CLASS node
    this._bufferNode({
      id,
      type,
      name,
      file,
      line,
      column,
      superClass
    });

    // Buffer CONTAINS edges: CLASS -> METHOD
    for (const methodId of methods) {
      this._bufferEdge({
        type: 'CONTAINS',
        src: id,
        dst: methodId
      });
    }

    // If superClass, buffer DERIVES_FROM edge
    if (superClass) {
      const superClassId = `CLASS#${superClass}#${file}`;
      this._bufferEdge({
        type: 'DERIVES_FROM',
        src: id,
        dst: superClassId
      });
    }
  }
}
```

**New code:**
```typescript
private bufferClassDeclarationNodes(classDeclarations: ClassDeclarationInfo[]): void {
  for (const classDecl of classDeclarations) {
    const { id, type, name, file, line, column, superClass, methods } = classDecl;

    // Buffer CLASS node
    this._bufferNode({
      id,
      type,
      name,
      file,
      line,
      column,
      superClass
    });

    // Buffer CONTAINS edges: CLASS -> METHOD
    for (const methodId of methods) {
      this._bufferEdge({
        type: 'CONTAINS',
        src: id,
        dst: methodId
      });
    }

    // If superClass, buffer DERIVES_FROM edge with computed ID
    if (superClass) {
      // Compute superclass ID using same format as ClassNode (line 0 = unknown location)
      // Assume superclass is in same file (most common case)
      // When superclass is in different file, edge will be dangling until that file analyzed
      const superClassId = `${file}:CLASS:${superClass}:0`;

      this._bufferEdge({
        type: 'DERIVES_FROM',
        src: id,
        dst: superClassId
      });
    }
  }
}
```

**What changed:**
- Superclass ID format changed from `CLASS#${superClass}#${file}` to `${file}:CLASS:${superClass}:0`
- Line 0 indicates unknown location (honest about what we don't know)
- No placeholder node creation
- Edge created, node will exist when superclass file analyzed

**Tests must verify:**
- DERIVES_FROM edge has correct dst ID format
- Line 0 in superclass ID
- No placeholder CLASS nodes created
- Edge is dangling if superclass not yet analyzed (expected behavior)

---

### Change 4.2: Remove external class node creation in bufferClassNodes

**Location:** Lines 430-464 (bufferClassNodes method)

**Current code:**
```typescript
private bufferClassNodes(module: ModuleNode, classInstantiations: ClassInstantiationInfo[], classDeclarations: ClassDeclarationInfo[]): void {
  // Create lookup map: className → declaration ID
  const declarationMap = new Map<string, string>();
  for (const decl of classDeclarations) {
    if (decl.file === module.file) {
      declarationMap.set(decl.name, decl.id);
    }
  }

  for (const instantiation of classInstantiations) {
    const { variableId, className, line } = instantiation;

    let classId = declarationMap.get(className);

    if (!classId) {
      // External class - buffer CLASS node
      const classNode = NodeFactory.createClass(
        className,
        module.file,
        line,
        0,  // column not available
        { isInstantiationRef: true }
      );
      classId = classNode.id;
      this._bufferNode(classNode as unknown as GraphNode);
    }

    // Buffer INSTANCE_OF edge
    this._bufferEdge({
      type: 'INSTANCE_OF',
      src: variableId,
      dst: classId
    });
  }
}
```

**New code:**
```typescript
private bufferClassNodes(module: ModuleNode, classInstantiations: ClassInstantiationInfo[], classDeclarations: ClassDeclarationInfo[]): void {
  // Create lookup map: className → declaration ID
  const declarationMap = new Map<string, string>();
  for (const decl of classDeclarations) {
    if (decl.file === module.file) {
      declarationMap.set(decl.name, decl.id);
    }
  }

  for (const instantiation of classInstantiations) {
    const { variableId, className, line } = instantiation;

    let classId = declarationMap.get(className);

    if (!classId) {
      // External class - compute ID using ClassNode format (line 0 = unknown location)
      // Assume class is in same file (most common case)
      // When class is in different file, edge will be dangling until that file analyzed
      classId = `${module.file}:CLASS:${className}:0`;

      // NO node creation - node will exist when class file analyzed
    }

    // Buffer INSTANCE_OF edge
    this._bufferEdge({
      type: 'INSTANCE_OF',
      src: variableId,
      dst: classId
    });
  }
}
```

**What changed:**
- No NodeFactory.createClass() call for external classes
- Compute ID using ClassNode format with line 0
- No placeholder node buffering
- Edge created, node will exist when class file analyzed

**Tests must verify:**
- INSTANCE_OF edge has correct dst ID format
- No placeholder CLASS nodes created
- Edge is dangling if class not yet analyzed (expected behavior)

---

### Tests for Phase 4 (GraphBuilder)

Kent must write tests that verify:

1. **DERIVES_FROM edges:**
   - Superclass ID format: `{file}:CLASS:{superClass}:0`
   - Line 0 in superclass ID
   - No placeholder nodes created
   - Edge dangling if superclass not analyzed (expected)

2. **INSTANCE_OF edges:**
   - External class ID format: `{file}:CLASS:{className}:0`
   - No placeholder nodes created
   - Edge dangling if class not analyzed (expected)

3. **Integration:**
   - Analyze class with superclass → DERIVES_FROM edge created
   - Analyze both classes → edge resolves to real node
   - NewExpression for external class → INSTANCE_OF edge created

**Test files to create:**
- `test/unit/GraphBuilder.superclassEdges.test.js` - DERIVES_FROM without placeholders
- `test/unit/GraphBuilder.instanceOf.test.js` - INSTANCE_OF without placeholders

---

## Phase 5: Validation & Documentation

### Change 5.1: Add grep test to prevent regression

**Location:** New test file

**File:** `test/unit/NoLegacyClassIds.test.js`

```javascript
/**
 * Regression test: Ensure no legacy CLASS# IDs in production code
 *
 * This test prevents reintroduction of inline ID string creation
 * that was removed in REG-99.
 *
 * If this test fails, someone added inline CLASS node ID construction
 * instead of using ClassNode.create() or ClassNode.createWithContext()
 */

import { describe, it } from 'node:test';
import { execSync } from 'child_process';
import assert from 'assert';

describe('CLASS node ID format validation', () => {
  it('should have no CLASS# format in production code', () => {
    // Grep for CLASS# in source files (exclude test files)
    const grepCommand = `grep -r "CLASS#" packages/core/src --include="*.ts" --include="*.js" || true`;
    const result = execSync(grepCommand, { encoding: 'utf-8' });

    // Filter out comments explaining the old format
    const matches = result
      .split('\n')
      .filter(line => line.trim())
      .filter(line => !line.includes('//'))
      .filter(line => !line.includes('/*'))
      .filter(line => !line.includes('*'));

    assert.strictEqual(
      matches.length,
      0,
      `Found CLASS# format in production code (should use ClassNode API):\n${matches.join('\n')}`
    );
  });

  it('should use ClassNode.create() or ClassNode.createWithContext()', () => {
    // Verify ClassNode API is used in key files
    const files = [
      'packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts',
      'packages/core/src/core/ASTWorker.ts',
      'packages/core/src/core/QueueWorker.ts'
    ];

    for (const file of files) {
      const grepCommand = `grep -c "ClassNode.create" ${file} || echo "0"`;
      const result = execSync(grepCommand, { encoding: 'utf-8' }).trim();
      const count = parseInt(result, 10);

      assert.ok(
        count > 0,
        `${file} should use ClassNode.create() or ClassNode.createWithContext()`
      );
    }
  });
});
```

**What this test does:**
- Fails if `CLASS#` format found in production code
- Verifies ClassNode API used in key files
- Prevents regression to inline ID construction

---

### Change 5.2: Document ID formats in ClassNode.ts

**Location:** `/Users/vadimr/grafema/packages/core/src/core/nodes/ClassNode.ts`

**Add to top of file (after imports):**

```typescript
/**
 * ClassNode - Factory for CLASS node creation
 *
 * ID FORMATS:
 *
 * 1. Semantic IDs (via createWithContext):
 *    Format: {file}->{scope_path}->CLASS->{name}
 *    Example: src/models/User.js->global->CLASS->User
 *    Example: src/app.js->global->MyApp->CLASS->Config
 *    Used by: ClassVisitor (has ScopeTracker)
 *
 * 2. Legacy IDs (via create):
 *    Format: {file}:CLASS:{name}:{line}
 *    Example: src/models/User.js:CLASS:User:15
 *    Used by: ASTWorker, QueueWorker (no ScopeTracker)
 *
 * 3. Unknown location (computed IDs):
 *    Format: {file}:CLASS:{name}:0
 *    Example: src/models/User.js:CLASS:BaseUser:0
 *    Used by: GraphBuilder for superclass/external class references
 *    Note: Line 0 indicates unknown location (honest about missing data)
 *
 * MIGRATION PATH:
 * - Workers currently use legacy IDs (performance-optimized, no context tracking)
 * - ClassVisitor uses semantic IDs (full AST analysis with ScopeTracker)
 * - Both formats coexist temporarily, both queryable by name
 * - Future: deprecate workers OR add lightweight scope tracking
 *
 * NEVER create IDs manually - always use ClassNode.create() or createWithContext()
 */
```

**What this documentation does:**
- Explains all three ID format variants
- Documents when each format is used
- Clarifies line 0 semantics (unknown location)
- Provides migration path context
- Warns against manual ID construction

---

### Change 5.3: Add ClassNode usage examples in CLAUDE.md

**Location:** `/Users/vadimr/grafema/CLAUDE.md`

**Add new section after "Forbidden Patterns":**

```markdown
## Node Creation Patterns

### CLASS Nodes

**ALWAYS use ClassNode API - NEVER create IDs manually**

```typescript
// ✅ CORRECT - ClassVisitor (has ScopeTracker)
import { ClassNode } from '../core/nodes/ClassNode.js';

const classRecord = ClassNode.createWithContext(
  className,
  scopeTracker.getContext(),
  { line: node.loc.start.line, column: node.loc.start.column },
  { superClass: superClassName || undefined }
);

// ✅ CORRECT - Workers (no ScopeTracker)
const classRecord = ClassNode.create(
  className,
  filePath,
  line,
  column,
  { superClass: superClassName || undefined }
);

// ✅ CORRECT - GraphBuilder (reference with unknown location)
const superClassId = `${file}:CLASS:${superClass}:0`;  // line 0 = unknown

// ❌ WRONG - Manual ID construction
const classId = `CLASS#${className}#${file}#${line}`;  // NEVER DO THIS
```

**ID Formats:**
- Semantic: `{file}->{scope_path}->CLASS->{name}` (ClassVisitor)
- Legacy: `{file}:CLASS:{name}:{line}` (Workers)
- Unknown location: `{file}:CLASS:{name}:0` (References)

**Why:**
- Single source of truth for ID generation
- Format changes handled in one place
- Validation built into factory
- Type safety enforced
```

---

### Tests for Phase 5 (Validation)

Kent must write:

1. **Grep regression test:**
   - Verify no `CLASS#` in production code
   - Verify ClassNode API usage in key files

2. **Documentation completeness:**
   - Verify all ID formats documented
   - Verify migration path explained

**Test files to create:**
- `test/unit/NoLegacyClassIds.test.js` - Grep test for regression prevention

---

## Test Execution Order

1. **Phase 1 tests (ClassVisitor):**
   - Run: `node --test test/unit/ClassVisitor.*.test.js`
   - Must pass before proceeding to Phase 2

2. **Phase 2 tests (ASTWorker):**
   - Run: `node --test test/unit/ASTWorker.classNode.test.js`
   - Must pass before proceeding to Phase 3

3. **Phase 3 tests (QueueWorker):**
   - Run: `node --test test/unit/QueueWorker.classNode.test.js`
   - Must pass before proceeding to Phase 4

4. **Phase 4 tests (GraphBuilder):**
   - Run: `node --test test/unit/GraphBuilder.*.test.js`
   - Must pass before proceeding to Phase 5

5. **Phase 5 tests (Validation):**
   - Run: `node --test test/unit/NoLegacyClassIds.test.js`
   - Must pass before final commit

6. **Full suite:**
   - Run: `npm test`
   - Must pass before marking task complete

---

## Integration Test Requirements

After all phases complete, Kent must create integration test:

**File:** `test/integration/ClassNodeMigration.test.js`

```javascript
/**
 * Integration test: CLASS node migration (REG-99)
 *
 * Verifies:
 * 1. ClassVisitor produces semantic IDs
 * 2. Workers produce legacy IDs
 * 3. Both formats queryable in graph
 * 4. DERIVES_FROM edges work with computed IDs
 * 5. No placeholder nodes created
 */

import { describe, it } from 'node:test';
import assert from 'assert';
// ... test implementation

describe('CLASS node migration integration', () => {
  it('should create semantic IDs from ClassVisitor', async () => {
    // Analyze file with class using ClassVisitor
    // Verify semantic ID format in graph
  });

  it('should create legacy IDs from workers', async () => {
    // Analyze file with class using worker
    // Verify legacy ID format in graph
  });

  it('should create DERIVES_FROM edges with line 0', async () => {
    // Analyze class with superclass
    // Verify edge dst has line 0
    // Verify no placeholder node created
  });

  it('should query both semantic and legacy IDs by name', async () => {
    // Create both formats in graph
    // Query by name
    // Verify both found
  });
});
```

---

## Commit Strategy

Each phase is ONE atomic commit:

1. **Commit 1:** `fix(ClassVisitor): use ClassNode.createWithContext() for semantic IDs (REG-99)`
   - All Phase 1 changes
   - Tests passing

2. **Commit 2:** `fix(ASTWorker): use ClassNode.create() for legacy IDs (REG-99)`
   - All Phase 2 changes
   - Tests passing

3. **Commit 3:** `fix(QueueWorker): use ClassNode.create() for legacy IDs (REG-99)`
   - All Phase 3 changes
   - Tests passing

4. **Commit 4:** `fix(GraphBuilder): compute superclass IDs without placeholder nodes (REG-99)`
   - All Phase 4 changes
   - Tests passing

5. **Commit 5:** `test(CLASS): add regression test and documentation (REG-99)`
   - All Phase 5 changes
   - Full suite passing

---

## Dependencies Between Changes

### Phase 1 (ClassVisitor):
- **No dependencies** - can start immediately
- Must import ClassNode
- Must import ClassNodeRecord type

### Phase 2 (ASTWorker):
- **No dependencies on Phase 1** - independent
- Must import ClassNode
- Must import ClassNodeRecord type

### Phase 3 (QueueWorker):
- **No dependencies on Phase 1 or 2** - independent
- Must import ClassNode
- Must import ClassNodeRecord type

### Phase 4 (GraphBuilder):
- **Depends on ClassNode format** (already exists)
- No code dependencies on Phase 1-3
- Must understand ClassNode ID format

### Phase 5 (Validation):
- **Depends on Phase 1-4 complete**
- Grep test verifies all phases done

---

## Rob's Implementation Checklist

For each phase:

- [ ] Read current code in file
- [ ] Apply exact before/after changes
- [ ] Add required imports
- [ ] Run phase-specific tests (Kent provides these)
- [ ] Verify no regressions in full suite
- [ ] Commit with atomic message
- [ ] Proceed to next phase

---

## Expected Test Output

After all phases complete:

```bash
$ npm test

# ClassVisitor tests
✓ ClassVisitor.createWithContext.test.js (5 tests)
✓ ClassVisitor.semanticIds.test.js (8 tests)
✓ ClassVisitor.typescript.test.js (3 tests)

# ASTWorker tests
✓ ASTWorker.classNode.test.js (4 tests)

# QueueWorker tests
✓ QueueWorker.classNode.test.js (4 tests)

# GraphBuilder tests
✓ GraphBuilder.superclassEdges.test.js (6 tests)
✓ GraphBuilder.instanceOf.test.js (4 tests)

# Validation tests
✓ NoLegacyClassIds.test.js (2 tests)

# Integration tests
✓ ClassNodeMigration.test.js (4 tests)

Total: 40 tests passed
```

---

## Success Criteria (from Don's Plan)

Task is DONE when:

1. ✅ ClassVisitor uses `ClassNode.createWithContext()` - semantic IDs
2. ✅ ASTWorker uses `ClassNode.create()` - legacy IDs, no inline strings
3. ✅ QueueWorker uses `ClassNode.create()` - legacy IDs, no inline strings
4. ✅ GraphBuilder computes superclass IDs, no placeholder nodes
5. ✅ NO inline ID string creation for CLASS anywhere in codebase
6. ✅ ClassNodeRecord returned from all paths
7. ✅ Tests verify both semantic and legacy IDs work
8. ✅ `grep -r "CLASS#"` returns ZERO matches in production code

---

## What We're NOT Doing

Per Don's plan, we are explicitly NOT:

1. ❌ Forcing semantic IDs everywhere (workers use legacy, that's OK)
2. ❌ Creating placeholder CLASS nodes (compute IDs instead)
3. ❌ Adding implements to ClassNodeRecord (TypeScript-specific, stays in ClassInfo)
4. ❌ Migrating existing graph data (user cleared graph)
5. ❌ Adding conditional logic (each path knows what it needs)

---

## Risk Mitigation

### Risk: Two ID formats in graph

**Mitigation:**
- Both formats have same prefix structure: `{file}:CLASS:{name}`
- Queries by name work for both formats
- Documentation explains temporary coexistence
- Clear migration path documented

### Risk: Dangling DERIVES_FROM edges

**Mitigation:**
- Expected behavior when superclass not yet analyzed
- Better than fake nodes with wrong line numbers
- UI can show "Superclass not analyzed"
- Resolves automatically when superclass file analyzed

### Risk: Breaking existing code

**Mitigation:**
- Atomic commits per phase
- Tests pass after each phase
- Each phase independently reviewable
- Full suite runs before final commit

---

## Questions for Kent (Test Engineer)

1. Do test specifications provide enough detail for implementation?
2. Are there additional edge cases we should test?
3. Should we add performance benchmarks (semantic vs legacy ID generation)?
4. Any concerns about test execution time (grep test might be slow on large repos)?

---

## Questions for Rob (Implementation Engineer)

1. Are before/after code snippets clear and unambiguous?
2. Any concerns about import paths or module dependencies?
3. Should we add type assertions to catch mistakes during implementation?
4. Any TypeScript compilation issues anticipated?

---

## Joel's Implementation Notes

**Key principles applied:**

1. **DRY:** ClassInfo extends ClassNodeRecord (no duplication)
2. **KISS:** Each phase is simple, atomic change
3. **TDD:** Tests specify behavior before implementation
4. **No conditionals:** Each code path knows what it needs (ClassVisitor vs Workers)
5. **Honest data:** Line 0 for unknown location, no fake placeholders

**Why this plan is different from original:**

- Original: tried to make everyone use semantic IDs (forced fit)
- This plan: accepts that workers and visitors have different needs
- Original: created placeholder nodes with fake data
- This plan: computes IDs honestly (line 0 = unknown)
- Original: conditional logic based on scopeTracker availability
- This plan: separate code paths for separate purposes

**This plan implements Don's vision:**

- Fix ID format consistency FIRST (all use ClassNode API)
- Use semantic IDs where we HAVE context (ClassVisitor)
- Use legacy IDs where we DON'T HAVE context (Workers)
- Be honest about what we know (line 0 for unknown)
- No conditional correctness (each path does what it's designed for)

---

**Plan ready for:**
- Kent Beck (write tests per specifications)
- Rob Pike (implement per atomic changes)

— Joel Spolsky

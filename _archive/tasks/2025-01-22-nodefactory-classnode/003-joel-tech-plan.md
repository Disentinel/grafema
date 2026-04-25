# Technical Implementation Plan: NodeFactory ClassNode Migration

**Task:** REG-99 - Migrate remaining ClassNode.create() to ClassNode.createWithContext()

**Context:**
- User decisions: semantic IDs, clear graph, ClassNodeRecord return
- Don's analysis identified 4 files to fix
- ClassNode.createWithContext API exists and tested

---

## Files Analysis

### Current State

**ClassNode.createWithContext API** (`/Users/vadimr/grafema/packages/core/src/core/nodes/ClassNode.ts`):
```typescript
static createWithContext(
  name: string,
  context: ScopeContext,
  location: Partial<Location>,
  options: ClassContextOptions = {}
): ClassNodeRecord
```

**Files to fix:**
1. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/visitors/ClassVisitor.ts` (line 172)
2. `/Users/vadimr/grafema/packages/core/src/core/ASTWorker.ts` (line 462)
3. `/Users/vadimr/grafema/packages/core/src/core/QueueWorker.ts` (line 325)
4. `/Users/vadimr/grafema/packages/core/src/plugins/analysis/ast/GraphBuilder.ts` (line 420)

**Already correct:**
- GraphBuilder line 446 (uses NodeFactory)

---

## Implementation Steps

### STEP 1: Fix ClassVisitor.ts (HIGHEST PRIORITY)

**Why first:** This is the AST visitor that creates CLASS nodes during traversal. It already has ScopeTracker available.

**Current code** (lines 172-205):
```typescript
// Create CLASS node for declaration
const classId = `CLASS#${className}#${module.file}#${classNode.loc!.start.line}`;
const superClassName = classNode.superClass?.type === 'Identifier'
  ? (classNode.superClass as Identifier).name
  : null;

// Generate semantic ID if scopeTracker available
let classSemanticId: string | undefined;
if (scopeTracker) {
  classSemanticId = computeSemanticId('CLASS', className, scopeTracker.getContext());
}

// Extract implements (TypeScript)
const implementsNames: string[] = [];
// ... implements extraction code ...

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
// Create CLASS node using NodeFactory
import { ClassNode } from '../../../../core/nodes/ClassNode.js';

// Extract superClass
const superClassName = classNode.superClass?.type === 'Identifier'
  ? (classNode.superClass as Identifier).name
  : null;

// Extract implements (TypeScript)
const implementsNames: string[] = [];
// ... implements extraction code ...

// Create ClassNodeRecord using createWithContext
let classRecord: import('@grafema/types').BaseNodeRecord;
if (scopeTracker) {
  classRecord = ClassNode.createWithContext(
    className,
    scopeTracker.getContext(),
    { line: classNode.loc!.start.line, column: classNode.loc!.start.column },
    {
      exported: false,
      superClass: superClassName || undefined,
      methods: []
    }
  );
} else {
  // Fallback to create() for backward compatibility
  classRecord = ClassNode.create(
    className,
    module.file,
    classNode.loc!.start.line,
    classNode.loc!.start.column,
    {
      exported: false,
      superClass: superClassName || undefined,
      methods: []
    }
  );
}

// Store as ClassInfo with extends field for implements
(classDeclarations as ClassInfo[]).push({
  ...classRecord,
  implements: implementsNames.length > 0 ? implementsNames : undefined,
  methods: []
});
```

**Changes:**
1. Add import: `import { ClassNode } from '../../../../core/nodes/ClassNode.js';`
2. Replace manual node creation with `ClassNode.createWithContext()`
3. Keep fallback to `ClassNode.create()` when scopeTracker unavailable
4. Spread classRecord into classDeclarations array
5. Keep implements field (TypeScript-specific, not in ClassNode)

**Dependencies:** None - self-contained change

**Test requirements:**
- Existing test `/Users/vadimr/grafema/test/unit/ClassNodeSemanticId.test.js` should pass
- New test: verify implements field preserved

---

### STEP 2: Fix ASTWorker.ts (MEDIUM PRIORITY)

**Why second:** Worker thread for parallel AST parsing. No ScopeTracker available.

**Current code** (lines 455-471):
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

  // Extract methods...
}
```

**New code:**
```typescript
import { ClassNode } from '../../../core/nodes/ClassNode.js';

ClassDeclaration(path: NodePath<ClassDeclaration>) {
  if (path.getFunctionParent()) return;

  const node = path.node;
  if (!node.id) return;

  const className = node.id.name;
  const superClassName = (node.superClass as Identifier)?.name || null;

  // Use ClassNode.create() (no ScopeTracker in worker)
  const classRecord = ClassNode.create(
    className,
    filePath,
    node.loc!.start.line,
    0,  // column not available in simplified worker
    {
      superClass: superClassName || undefined
    }
  );

  collections.classDeclarations.push(classRecord);

  // Extract methods...
}
```

**Changes:**
1. Add import: `import { ClassNode } from '../../../core/nodes/ClassNode.js';`
2. Replace manual object with `ClassNode.create()`
3. Use create() not createWithContext() (no ScopeTracker in worker)

**Dependencies:** None

**Test requirements:**
- Worker tests should pass
- Verify ClassDeclarationNode interface matches ClassNodeRecord

---

### STEP 3: Fix QueueWorker.ts (MEDIUM PRIORITY)

**Why third:** Another worker thread. Similar to ASTWorker but newer architecture.

**Current code** (lines 316-360):
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

  // Extract methods...
}
```

**New code:**
```typescript
import { ClassNode } from '../../../core/nodes/ClassNode.js';

ClassDeclaration(path: NodePath<t.ClassDeclaration>) {
  if (path.getFunctionParent()) return;

  const node = path.node;
  if (!node.id) return;

  const className = node.id.name;
  const line = node.loc?.start.line || 0;
  const superClassName = node.superClass && node.superClass.type === 'Identifier'
    ? node.superClass.name
    : null;

  // Use ClassNode.create() (no ScopeTracker in worker)
  const classRecord = ClassNode.create(
    className,
    filePath,
    line,
    0,  // column not available
    {
      superClass: superClassName || undefined
    }
  );

  nodes.push(classRecord as unknown as GraphNode);

  edges.push({ src: moduleId, dst: classRecord.id, type: 'CONTAINS' });

  // Extract methods...
}
```

**Changes:**
1. Add import: `import { ClassNode } from '../../../core/nodes/ClassNode.js';`
2. Replace manual object with `ClassNode.create()`
3. Cast to GraphNode for type compatibility
4. Use classRecord.id for edge

**Dependencies:** None

**Test requirements:**
- QueueWorker integration tests should pass
- Verify node format matches RFDB expectations

---

### STEP 4: Fix GraphBuilder.ts (LOW PRIORITY - edge creation)

**Why last:** This is edge creation, not node creation. Lower risk.

**Current code** (lines 417-427):
```typescript
// If superClass, buffer DERIVES_FROM edge
if (superClass) {
  const superClassId = `CLASS#${superClass}#${file}`;
  this._bufferEdge({
    type: 'DERIVES_FROM',
    src: id,
    dst: superClassId
  });
}
```

**Issue:** Manual ID construction for superclass reference. Should use NodeFactory or lookup existing node.

**New code:**
```typescript
// If superClass, buffer DERIVES_FROM edge
if (superClass) {
  // Try to find existing class declaration
  const superClassDecl = classDeclarations.find(c => c.name === superClass && c.file === file);

  let superClassId: string;
  if (superClassDecl) {
    superClassId = superClassDecl.id;
  } else {
    // Create reference node using NodeFactory
    const superClassNode = NodeFactory.createClass(
      superClass,
      file,
      line,  // use current class line as placeholder
      0,
      { isInstantiationRef: true }
    );
    superClassId = superClassNode.id;
    this._bufferNode(superClassNode as unknown as GraphNode);
  }

  this._bufferEdge({
    type: 'DERIVES_FROM',
    src: id,
    dst: superClassId
  });
}
```

**Changes:**
1. Lookup existing superclass in classDeclarations
2. If not found, use NodeFactory.createClass() to create reference
3. Buffer reference node
4. Use returned ID for edge

**Dependencies:** Requires classDeclarations parameter access in bufferClassDeclarationNodes

**Test requirements:**
- Test inheritance with declared superclass
- Test inheritance with external superclass

---

## Change Order & Dependencies

```
STEP 1: ClassVisitor.ts (INDEPENDENT)
  ↓
STEP 2: ASTWorker.ts (INDEPENDENT)
  ↓
STEP 3: QueueWorker.ts (INDEPENDENT)
  ↓
STEP 4: GraphBuilder.ts (depends on NodeFactory pattern)
```

All steps are independent except Step 4, which should follow the NodeFactory pattern established in Step 1-3.

---

## Test Strategy

### Unit Tests (Kent will write):

1. **ClassVisitor test:**
   - Input: AST with class declaration + superclass
   - Verify: ClassNodeRecord with semantic ID when scopeTracker present
   - Verify: implements field preserved

2. **ASTWorker test:**
   - Input: File with class declaration
   - Verify: ClassNodeRecord with line-based ID (no scopeTracker)
   - Verify: Interface matches ClassDeclarationNode

3. **QueueWorker test:**
   - Input: File with class + superclass
   - Verify: ClassNodeRecord created
   - Verify: CONTAINS edge to module

4. **GraphBuilder test:**
   - Input: ClassDeclarationInfo with superclass
   - Verify: DERIVES_FROM edge created
   - Verify: Superclass reference node created if needed

### Integration Test:
- Analyze file with class hierarchy
- Verify semantic IDs end-to-end
- Verify DERIVES_FROM edges correct

---

## Potential Pitfalls

### 1. **ClassInfo interface mismatch**
- **Problem:** ClassInfo in ClassVisitor has `implements` field not in ClassNodeRecord
- **Solution:** Spread classRecord and add implements field separately

### 2. **Worker type compatibility**
- **Problem:** Workers use simplified interfaces (ClassDeclarationNode)
- **Solution:** Verify ClassNodeRecord fields match ClassDeclarationNode

### 3. **GraphBuilder parameter access**
- **Problem:** bufferClassDeclarationNodes doesn't have access to classDeclarations array
- **Solution:** Pass classDeclarations as parameter or store in class field

### 4. **Superclass reference timing**
- **Problem:** Superclass might not be analyzed yet
- **Solution:** Create reference node with isInstantiationRef=true

---

## Rollback Plan

If any step fails:
1. Each file change is atomic - revert individual file
2. Tests verify backward compatibility via create() fallback
3. Graph can be cleared and re-analyzed (user decision)

---

## Success Criteria

✅ All 4 files use ClassNode factory methods
✅ Semantic IDs generated where ScopeTracker available
✅ Line-based IDs used in workers (no ScopeTracker)
✅ ClassNodeRecord interface consistent
✅ Tests pass
✅ DERIVES_FROM edges use correct IDs

---

## Implementation Notes for Rob

- Import ClassNode at top of each file
- Follow exact signatures from ClassNode.ts
- Preserve existing logic flow (minimal refactoring)
- Add type casts where needed for compatibility
- Keep fallback to create() when scopeTracker unavailable

---

**Next Steps:**
1. Kent writes tests for each file change
2. Rob implements changes in order (Step 1 → 4)
3. Kevlin reviews code quality
4. Linus reviews architectural alignment

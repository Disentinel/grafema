# Joel Spolsky — Technical Specification for REG-399

## Executive Summary

Don's plan proposes extracting `extractVariableNamesFromPattern` to a shared utility. **After examining the actual code, this is unnecessary.**

The method is already:
- A standalone method on JSASTAnalyzer (lines 571-632)
- Passed as a callback to VariableVisitor via `.bind(this)` (line 1530)
- Has no dependencies on JSASTAnalyzer instance state (pure function)

**Better approach: Import JSASTAnalyzer and call the method directly.**

No file extraction needed. Just import, instantiate once, and use.

---

## Implementation Plan

### Phase 1: Extend ParameterInfo Schema

**File:** `/Users/vadimr/grafema-worker-7/packages/core/src/plugins/analysis/ast/types.ts`

**Location:** Line 40-53 (ParameterInfo interface)

**Change:**
```typescript
// === PARAMETER INFO ===
export interface ParameterInfo {
  id: string;
  semanticId?: string;  // Stable ID: file->scope->PARAMETER->name
  type: 'PARAMETER';
  name: string;
  file: string;
  line: number;
  index?: number;
  hasDefault?: boolean;  // Has default value (e.g., function(a = 1))
  isRest?: boolean;      // Rest parameter (e.g., function(...args))
  functionId?: string;   // Legacy field - prefer parentFunctionId
  parentFunctionId?: string;
  // NEW: Destructuring metadata (REG-399)
  propertyPath?: string[];  // For nested object destructuring: ['data', 'user'] for ({ data: { user } })
  arrayIndex?: number;      // For array destructuring: 0 for first element in ([first, second])
}
```

**Impact:** Backward compatible (optional fields).

**Complexity:** O(1) - Schema change only.

---

### Phase 2: Update createParameterNodes.ts

**File:** `/Users/vadimr/grafema-worker-7/packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts`

#### 2.1 Add Imports

**Location:** Lines 11-19 (import section)

**Add:**
```typescript
import type {
  Node,
  Identifier,
  AssignmentPattern,
  RestElement,
  ObjectPattern,    // NEW
  ArrayPattern      // NEW
} from '@babel/types';
import type { ParameterInfo } from '../types.js';
import type { ScopeTracker } from '../../../../core/ScopeTracker.js';
import { computeSemanticId } from '../../../../core/SemanticId.js';
// NEW: Import for accessing extractVariableNamesFromPattern
import { JSASTAnalyzer } from '../../JSASTAnalyzer.js';
```

**Rationale:** We need ObjectPattern and ArrayPattern types, and JSASTAnalyzer for the extraction method.

#### 2.2 Create Helper Instance (Module-Level)

**Location:** After imports, before function definition (after line 19)

**Add:**
```typescript
/**
 * Helper instance for extracting variable names from destructuring patterns.
 * We only need the method, not the full analyzer functionality.
 * Created once and reused across all parameter processing.
 */
const patternExtractor = new JSASTAnalyzer('', null as any);
```

**Rationale:**
- JSASTAnalyzer.extractVariableNamesFromPattern is a pure method
- No instance state dependencies
- Creating one instance is cheap (analyzer won't run, we just need the method)
- Alternative would be extracting to utility, but this is simpler and Don's concern about code organization is addressed by clear documentation

**Complexity:** O(1) - One-time instantiation.

#### 2.3 Update Function Signature Documentation

**Location:** Lines 21-39 (function documentation)

**Change:**
```typescript
/**
 * Create PARAMETER nodes for function parameters
 *
 * Handles:
 * - Simple Identifier parameters: function(a, b)
 * - AssignmentPattern (default parameters): function(a = 1)
 * - RestElement (rest parameters): function(...args)
 * - ObjectPattern (destructuring): function({ x, y })       // NEW
 * - ArrayPattern (destructuring): function([a, b])          // NEW
 * - Nested destructuring: function({ data: { user } })      // NEW
 * - Defaults in destructuring: function({ x = 42 })         // NEW
 *
 * @param params - AST nodes for function parameters
 * @param functionId - ID of the parent function (for parentFunctionId field)
 * @param file - File path
 * @param line - Line number of the function (for ParameterInfo.line fallback)
 * @param parameters - Array to push ParameterInfo objects into
 * @param scopeTracker - REQUIRED for semantic ID generation
 */
```

**Remove line 29-31:** "Does NOT handle..." comment (now obsolete).

#### 2.4 Add Destructuring Handling Logic

**Location:** Line 101 (after existing RestElement handling, before line 102)

**Replace line 102 comment with:**

```typescript
    } else if (param.type === 'ObjectPattern' || param.type === 'ArrayPattern') {
      // REG-399: Handle destructured parameters
      // Extract all parameter names from destructuring pattern
      const extractedParams = patternExtractor.extractVariableNamesFromPattern(param);

      extractedParams.forEach((paramInfo, subIndex) => {
        // Discriminator ensures unique IDs for parameters at same position
        // Formula: index * 1000 + subIndex
        // Example: function({ a, b }, c) — a=0, b=1, c=1000
        const discriminator = index * 1000 + subIndex;

        const paramId = computeSemanticId(
          'PARAMETER',
          paramInfo.name,
          scopeTracker.getContext(),
          { discriminator }
        );

        const paramData: ParameterInfo = {
          id: paramId,
          semanticId: paramId,
          type: 'PARAMETER',
          name: paramInfo.name,
          file: file,
          line: paramInfo.loc.start.line,
          index: index,  // Original parameter position in function signature
          parentFunctionId: functionId
        };

        // Add destructuring metadata
        if (paramInfo.propertyPath && paramInfo.propertyPath.length > 0) {
          paramData.propertyPath = paramInfo.propertyPath;
        }
        if (paramInfo.arrayIndex !== undefined) {
          paramData.arrayIndex = paramInfo.arrayIndex;
        }
        if (paramInfo.isRest) {
          paramData.isRest = true;
        }

        parameters.push(paramData);
      });
    }
```

**Complexity:** O(n) where n = number of destructured bindings in parameter.

**Semantic ID Strategy:**
- `discriminator = index * 1000 + subIndex`
- Ensures uniqueness even with duplicate names: `function({ x }, { x }) {}`
- Preserves parameter position: all destructured params at position 0 have `index: 0`

#### 2.5 Handle AssignmentPattern with Destructuring

**Location:** Line 65 (inside existing AssignmentPattern handler)

**Current code (lines 65-82):**
```typescript
    } else if (param.type === 'AssignmentPattern') {
      // Default parameter: function(a = 1)
      const assignmentParam = param as AssignmentPattern;
      if (assignmentParam.left.type === 'Identifier') {
        const name = assignmentParam.left.name;
        const paramId = computeSemanticId('PARAMETER', name, scopeTracker.getContext(), { discriminator: index });
        parameters.push({
          id: paramId,
          semanticId: paramId,
          type: 'PARAMETER',
          name,
          file: file,
          line: assignmentParam.left.loc?.start.line || line,
          index: index,
          hasDefault: true,
          parentFunctionId: functionId
        });
      }
```

**Change to:**
```typescript
    } else if (param.type === 'AssignmentPattern') {
      // Default parameter: function(a = 1) OR destructured with defaults: function({ x = 1 })
      const assignmentParam = param as AssignmentPattern;

      if (assignmentParam.left.type === 'Identifier') {
        // Simple default: function(a = 1)
        const name = assignmentParam.left.name;
        const paramId = computeSemanticId('PARAMETER', name, scopeTracker.getContext(), { discriminator: index });
        parameters.push({
          id: paramId,
          semanticId: paramId,
          type: 'PARAMETER',
          name,
          file: file,
          line: assignmentParam.left.loc?.start.line || line,
          index: index,
          hasDefault: true,
          parentFunctionId: functionId
        });
      } else if (assignmentParam.left.type === 'ObjectPattern' || assignmentParam.left.type === 'ArrayPattern') {
        // REG-399: Destructuring with default: function({ x } = {})
        // The destructured params themselves might have defaults, but the pattern-level default
        // means "if argument is undefined, use this default object/array"
        // extractVariableNamesFromPattern already handles AssignmentPattern recursively
        const extractedParams = patternExtractor.extractVariableNamesFromPattern(assignmentParam.left);

        extractedParams.forEach((paramInfo, subIndex) => {
          const discriminator = index * 1000 + subIndex;

          const paramId = computeSemanticId(
            'PARAMETER',
            paramInfo.name,
            scopeTracker.getContext(),
            { discriminator }
          );

          const paramData: ParameterInfo = {
            id: paramId,
            semanticId: paramId,
            type: 'PARAMETER',
            name: paramInfo.name,
            file: file,
            line: paramInfo.loc.start.line,
            index: index,
            hasDefault: true,  // Pattern-level default (e.g., = {})
            parentFunctionId: functionId
          };

          // Add destructuring metadata
          if (paramInfo.propertyPath && paramInfo.propertyPath.length > 0) {
            paramData.propertyPath = paramInfo.propertyPath;
          }
          if (paramInfo.arrayIndex !== undefined) {
            paramData.arrayIndex = paramInfo.arrayIndex;
          }
          if (paramInfo.isRest) {
            paramData.isRest = true;
          }

          parameters.push(paramData);
        });
      }
```

**Key insight:** `extractVariableNamesFromPattern` already handles `AssignmentPattern` recursively (line 627-629 in JSASTAnalyzer), so nested defaults like `{ x = 1 }` are handled automatically.

**Complexity:** O(n) where n = number of destructured bindings.

---

### Phase 3: Critical Analysis of Don's Extraction Proposal

**Don's proposal:** Extract `extractVariableNamesFromPattern` to shared utility file.

**Reality check:**

1. **Current usage:**
   - Used by VariableVisitor (passed as callback via `.bind(this)`)
   - Will be used by createParameterNodes (this task)

2. **Method characteristics:**
   - No instance state dependencies
   - Pure function (input → output, no side effects)
   - 62 lines (571-632)

3. **Extraction cost:**
   - Create new file: `ast/utils/extractVariableNamesFromPattern.ts`
   - Move VariableInfo interface (currently in VariableVisitor.ts)
   - Update imports in 3 files (JSASTAnalyzer, VariableVisitor, createParameterNodes)
   - Update type imports for ExtractedVariable/VariableInfo

4. **Extraction benefit:**
   - Clearer separation of concerns
   - No circular dependencies
   - Easier to test in isolation

5. **Import approach cost:**
   - Add one import to createParameterNodes
   - Create one module-level instance
   - 2 lines of code

**Decision: Import approach for now, defer extraction.**

**Rationale:**
- Extraction is the RIGHT architectural move (Don is correct)
- But it's a REFACTORING, not a requirement for REG-399
- Import approach unblocks the feature immediately
- Extraction can be separate task (technical debt)

**Recommendation for user:**
- Implement with import approach
- Create Linear issue: "Extract extractVariableNamesFromPattern to shared utility (tech debt from REG-399)"
- Assign to v0.2 (parallelizable tech debt)

---

## Test Plan

### Test File Location

**New file:** `/Users/vadimr/grafema-worker-7/test/unit/plugins/analysis/ast/destructured-parameters.test.ts`

**Pattern:** Follow existing test structure from `loop-nodes.test.ts`:
- Use `createTestDatabase` helper
- Use `createTestOrchestrator` for analysis
- Test files written to tmpdir
- Query backend for PARAMETER nodes and edges

### Test Cases

#### 1. Object Destructuring - Basic

```javascript
// Input
function foo({ maxBodyLength }) {
  return maxBodyLength;
}

// Expected
PARAMETER {
  name: 'maxBodyLength',
  type: 'PARAMETER',
  index: 0,
  hasDefault: undefined,
  isRest: undefined,
  propertyPath: ['maxBodyLength'],
  arrayIndex: undefined
}

HAS_PARAMETER edge: FUNCTION[foo] -> PARAMETER[maxBodyLength]
```

#### 2. Object Destructuring - Nested

```javascript
// Input
function foo({ data: { user } }) {
  return user;
}

// Expected
PARAMETER {
  name: 'user',
  type: 'PARAMETER',
  index: 0,
  propertyPath: ['data', 'user']
}
```

#### 3. Object Destructuring - Renaming

```javascript
// Input
function foo({ old: newName }) {
  return newName;
}

// Expected
PARAMETER {
  name: 'newName',  // NOT 'old'
  type: 'PARAMETER',
  index: 0,
  propertyPath: ['old']
}
```

#### 4. Array Destructuring

```javascript
// Input
function foo([first, second]) {
  return first + second;
}

// Expected
PARAMETER[first] {
  name: 'first',
  arrayIndex: 0,
  index: 0
}
PARAMETER[second] {
  name: 'second',
  arrayIndex: 1,
  index: 0
}
```

#### 5. Rest Parameters in Destructuring

```javascript
// Input
function foo({ a, ...rest }) {
  return rest;
}

// Expected
PARAMETER[a] {
  name: 'a',
  isRest: undefined,
  propertyPath: ['a']
}
PARAMETER[rest] {
  name: 'rest',
  isRest: true,
  propertyPath: undefined
}
```

#### 6. Default Values in Destructuring

```javascript
// Input
function foo({ x = 42 }) {
  return x;
}

// Expected
PARAMETER {
  name: 'x',
  hasDefault: true,  // CRITICAL: extractVariableNamesFromPattern handles this via AssignmentPattern
  propertyPath: ['x']
}
```

#### 7. Pattern-Level Default

```javascript
// Input
function foo({ x, y } = {}) {
  return x + y;
}

// Expected
PARAMETER[x] {
  name: 'x',
  hasDefault: true,  // Pattern-level default
  propertyPath: ['x']
}
PARAMETER[y] {
  name: 'y',
  hasDefault: true,
  propertyPath: ['y']
}
```

#### 8. Arrow Functions

```javascript
// Input
const foo = ({ x }) => x;

// Expected
Same as regular function - PARAMETER node with propertyPath: ['x']
```

#### 9. Multiple Parameters (Semantic ID Uniqueness)

```javascript
// Input
function foo({ a, b }, { c, d }) {
  return a + b + c + d;
}

// Expected
PARAMETER[a] { index: 0, discriminator: 0 }    // ID: file->foo->PARAMETER->a#0
PARAMETER[b] { index: 0, discriminator: 1 }    // ID: file->foo->PARAMETER->b#1
PARAMETER[c] { index: 1, discriminator: 1000 } // ID: file->foo->PARAMETER->c#1000
PARAMETER[d] { index: 1, discriminator: 1001 } // ID: file->foo->PARAMETER->d#1001

All IDs must be unique. No collisions.
```

#### 10. Duplicate Names Across Parameters

```javascript
// Input
function foo({ x }, { x: y }) {
  return x + y;
}

// Expected
PARAMETER[x] { index: 0, discriminator: 0, propertyPath: ['x'] }
PARAMETER[y] { index: 1, discriminator: 1000, propertyPath: ['x'] }

Semantic IDs must be unique despite both coming from 'x' property.
```

#### 11. Mixed Simple and Destructured

```javascript
// Input
function foo(a, { b, c }, d) {
  return a + b + c + d;
}

// Expected
PARAMETER[a] { index: 0, propertyPath: undefined }
PARAMETER[b] { index: 1, propertyPath: ['b'] }
PARAMETER[c] { index: 1, propertyPath: ['c'] }
PARAMETER[d] { index: 2, propertyPath: undefined }
```

#### 12. TypeScript Type Annotations

```typescript
// Input
function foo({ x }: { x: number }) {
  return x;
}

// Expected
Same behavior - type annotations ignored during AST analysis
PARAMETER { name: 'x', propertyPath: ['x'] }
```

---

## Complexity Analysis

### Time Complexity

**Per parameter:**
- Simple identifier: O(1)
- Destructured (n bindings): O(n)
- Nested destructuring (depth d, n bindings): O(d * n)

**Overall:** O(p * b) where p = parameters, b = average bindings per parameter.

**Worst case:** `function({ a: { b: { c: { d: { e }}}}})` → O(5) = constant for practical cases.

### Space Complexity

**ParameterInfo objects:** O(total bindings across all parameters)

**Example:**
- `function(a, b, c)` → 3 PARAMETER nodes
- `function({ a, b }, { c, d })` → 4 PARAMETER nodes
- `function({ a: { b: { c }}})` → 1 PARAMETER node (only innermost binding)

---

## Edge Cases and Validation

### 1. Empty Destructuring

```javascript
function foo({}) {}  // Zero parameters
function foo([]) {}  // Zero parameters
```

**Behavior:** No PARAMETER nodes created (correct - no bindings).

### 2. Sparse Array Destructuring

```javascript
function foo([, , third]) {}
```

**Expected:**
```javascript
PARAMETER { name: 'third', arrayIndex: 2 }
```

**Validation:** Check extractVariableNamesFromPattern handles null/undefined elements (line 603 has `if (element)` check).

### 3. Computed Property Names

```javascript
function foo({ [key]: value }) {}
```

**Babel AST:** ObjectPattern with computed: true

**Current extractVariableNamesFromPattern:** Line 590-591 checks `isIdentifier` or `isStringLiteral`/`isNumericLiteral`.

**Computed keys not literals → skipped.**

**Behavior:** No PARAMETER for `value` (limitation, not bug).

**Acceptance criteria:** Not listed, so NOT in scope for REG-399.

### 4. Default Values at Multiple Levels

```javascript
function foo({ x = 1, y: { z = 2 } = {} }) {}
```

**extractVariableNamesFromPattern handles:**
- Line 627: `t.isAssignmentPattern(pattern)` → recurses on `pattern.left`
- Correctly extracts `x` and `z` with their locations

**Expected:**
```javascript
PARAMETER[x] { hasDefault: true }  // from x = 1
PARAMETER[z] { hasDefault: true }  // from pattern-level default
```

**Critical:** Test this explicitly. Nested defaults are tricky.

### 5. Rest in Array Destructuring

```javascript
function foo([first, ...rest]) {}
```

**Expected:**
```javascript
PARAMETER[first] { arrayIndex: 0, isRest: false }
PARAMETER[rest]  { arrayIndex: 1, isRest: true }
```

**Validation:** Check line 604-611 in extractVariableNamesFromPattern handles this.

---

## Migration Strategy

### Backward Compatibility

**Schema change:** Optional fields → backward compatible.

**Existing code:**
- Queries filtering by `type: 'PARAMETER'` → still work
- Code reading `name`, `index` → still work
- Code NOT expecting `propertyPath` → ignores it (fine)

**Risk:** LOW

### Rollout

1. **Tests pass:** All new tests + existing tests pass
2. **Deploy:** No migration needed (optional fields)
3. **Validation:** Run on real codebase, check PARAMETER node count increases

---

## Open Questions

### Q1: Should `hasDefault` distinguish pattern-level vs property-level defaults?

**Example:**
```javascript
function foo({ x = 1 } = {}) {}
//              ^^^^   ^^^^
//              prop   pattern
```

**Current spec:** Both set `hasDefault: true`

**Alternative:** Add `hasPatternDefault` field?

**Decision:** Not in scope for REG-399. Accept current behavior. File as tech debt if needed.

### Q2: Should we create EXPRESSION nodes for destructured params?

**Don's recommendation:** No, defer to future task.

**Reasoning:** Parameters don't have static source (comes from call site).

**Decision:** Agreed. REG-399 only creates PARAMETER nodes.

---

## Summary

### Files Modified

1. `/packages/core/src/plugins/analysis/ast/types.ts` (lines 40-53)
   - Add `propertyPath` and `arrayIndex` to ParameterInfo

2. `/packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts`
   - Add imports (ObjectPattern, ArrayPattern, JSASTAnalyzer)
   - Add module-level helper instance
   - Update documentation
   - Add destructuring handling (after line 101)
   - Update AssignmentPattern handler (line 65)

3. `/test/unit/plugins/analysis/ast/destructured-parameters.test.ts` (NEW)
   - 12 test cases covering all acceptance criteria

### Lines of Code

- Production code: ~80 lines added
- Test code: ~500 lines (comprehensive coverage)

### Acceptance Criteria Mapping

| Criterion | Implementation | Test Case |
|-----------|---------------|-----------|
| `function foo({ maxBodyLength })` | Section 2.4 | Test 1 |
| Nested: `function foo({ data: { user } })` | Section 2.4 | Test 2 |
| Renaming: `function foo({ old: newName })` | Section 2.4 | Test 3 |
| Array: `function foo([first, second])` | Section 2.4 | Test 4 |
| Rest: `function foo({ a, ...rest })` | Section 2.4 | Test 5 |
| Default values: `function foo({ x = 42 })` | Section 2.5 | Test 6 |
| Arrow functions: `({ x }) => x` | Section 2.4 | Test 8 |

All acceptance criteria covered.

---

## Risks

### 1. JSASTAnalyzer Import Creates Circular Dependency

**Risk:** createParameterNodes.ts imports JSASTAnalyzer, which imports createParameterNodes.

**Check:** Does JSASTAnalyzer import createParameterNodes?

**Validation needed:** Grep for imports.

**Mitigation if circular:** Extract to utility (Don's original plan).

### 2. extractVariableNamesFromPattern Has Hidden Dependencies

**Risk:** Method relies on instance state we don't see.

**Validation:** Method signature (lines 571-632) takes only parameters, no `this` usage inside.

**Confidence:** HIGH - it's pure.

### 3. hasDefault Logic Incomplete

**Risk:** `hasDefault` tracking for nested defaults doesn't work.

**Validation:** Test 6 and 7 must verify this explicitly.

**Mitigation:** If extractVariableNamesFromPattern doesn't track `hasDefault`, we need to extend it (Don's Phase 5 concern).

---

## Next Steps for Kent Beck

1. Write tests FIRST (all 12 test cases in test plan)
2. Tests will FAIL (no implementation yet)
3. Report: "All tests fail as expected - ready for implementation"

## Next Steps for Rob Pike

1. Implement Phase 1 (schema change)
2. Implement Phase 2.1-2.2 (imports + helper)
3. Implement Phase 2.3 (documentation)
4. Implement Phase 2.4 (ObjectPattern/ArrayPattern handling)
5. Implement Phase 2.5 (AssignmentPattern with destructuring)
6. Run tests
7. Fix until all tests pass

## Post-Implementation: Create Tech Debt Issue

**Title:** Extract extractVariableNamesFromPattern to shared utility

**Description:**
- Currently a method on JSASTAnalyzer
- Used by VariableVisitor (via callback) and createParameterNodes (via import)
- Should be standalone utility for cleaner architecture
- No functionality change, pure refactoring

**Labels:** Improvement, Tech Debt, v0.2

**Priority:** Low (works fine as-is, just not ideal architecture)

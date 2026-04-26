# Don Melton - Tech Lead Analysis: REG-134 Class Parameter Nodes

## Problem Analysis

**The Issue:** Class constructor and method parameters are not created as PARAMETER nodes. FunctionVisitor correctly creates PARAMETER nodes for standalone functions and arrow functions, but ClassVisitor does not do this for class methods.

**Evidence:**
1. `ObjectMutationTracking.test.js` lines 247, 287 have skipped tests with explicit comment: "Class constructor/method parameters are not created as PARAMETER nodes"
2. `FunctionVisitor.ts` has `createParameterNodes()` helper (lines 220-276) that handles:
   - Simple Identifier parameters
   - AssignmentPattern (default parameters)
   - RestElement (rest parameters)
3. `ClassVisitor.ts` processes `ClassMethod` and `ClassProperty` (function values) but never calls any parameter creation logic

**Impact:**
- Data flow tracing breaks for class methods - can't track `this.handler = handler` patterns
- HAS_PARAMETER edges don't exist for class methods
- Graph queries for parameters miss class context entirely

## Architectural Decision: Share vs Duplicate `createParameterNodes`

**Current State:**
- `createParameterNodes()` is defined inside `FunctionVisitor.getHandlers()` as a closure
- It directly accesses the `parameters` array from closure scope
- Uses local `ParameterInfo` interface (duplicated from `types.ts`)

**Decision: Extract to shared utility**

Reasons:
1. **DRY principle** - Same logic for parameter extraction regardless of context
2. **Types already shared** - `ParameterInfo` is defined in `types.ts` and exported
3. **Collections pattern** - Both visitors use `VisitorCollections.parameters`
4. **Future-proof** - Other contexts may need parameter creation (e.g., ObjectMethod in future)

**Extraction approach:**
- Create utility function in a shared location (suggest `packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts`)
- Function signature: `createParameterNodes(params: Node[], functionId: string, file: string, line: number, parameters: ParameterInfo[]): void`
- Import and use in both FunctionVisitor and ClassVisitor

**Alternative considered and rejected:**
- Duplicate the logic: Would violate DRY, and any bug fix or enhancement would need to be applied twice

## High-Level Plan

### Step 1: Create Shared Utility
1. Create `packages/core/src/plugins/analysis/ast/utils/createParameterNodes.ts`
2. Extract `createParameterNodes()` logic from FunctionVisitor
3. Make it a pure function that takes `parameters` array as argument (no closure dependency)
4. Export for use by both visitors

### Step 2: Refactor FunctionVisitor
1. Import the shared `createParameterNodes` utility
2. Remove the local `createParameterNodes` function
3. Remove the local `ParameterInfo` interface (use from types.ts)
4. Update calls to pass `parameters` array explicitly
5. Verify existing tests still pass

### Step 3: Implement in ClassVisitor
1. Import the shared `createParameterNodes` utility
2. In `ClassMethod` handler (around line 340, after function data is pushed):
   - Call `createParameterNodes(methodNode.params, functionId, module.file, methodNode.loc!.start.line, parameters)`
3. In `ClassProperty` handler (around line 285, for function values):
   - Call `createParameterNodes(funcNode.params, functionId, module.file, propNode.loc!.start.line, parameters)`
4. Ensure `parameters` is extracted from `this.collections` at the start of `getHandlers()`

### Step 4: Unskip and Verify Tests
1. Unskip tests in `ObjectMutationTracking.test.js` (lines 247, 287)
2. Run tests to verify they pass
3. Consider adding dedicated tests to `Parameter.test.js` for class parameters

## Test Strategy

### Existing Tests to Unskip
- `ObjectMutationTracking.test.js:247` - `this.prop = value` in constructor
- `ObjectMutationTracking.test.js:287` - `this.prop = value` in class methods

### New Test Cases (in Parameter.test.js)
1. **Constructor parameters**: `class Foo { constructor(a, b) {} }` should create PARAMETER nodes for `a`, `b`
2. **Method parameters**: `class Foo { process(data, options) {} }` should create PARAMETER nodes
3. **Arrow function property parameters**: `class Foo { handler = (event) => {} }` should create PARAMETER node for `event`
4. **Default parameters in methods**: `class Foo { greet(name = "World") {} }` should have `hasDefault: true`
5. **Rest parameters in methods**: `class Foo { sum(...numbers) {} }` should have `isRest: true`
6. **HAS_PARAMETER edges**: Verify edges from method FUNCTION nodes to their PARAMETER nodes

### Test Fixture
Create `test/fixtures/parameters/class-params.js` with:
```javascript
class ConfigService {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
  }

  process(data, ...extras) {
    return data;
  }

  handler = (event) => {
    console.log(event);
  }
}
```

## Risks and Concerns

### Low Risk
1. **Refactoring FunctionVisitor** - Well-tested, should be safe with existing tests
2. **Type compatibility** - `ParameterInfo` already exists in types.ts

### Medium Risk
1. **ClassVisitor scope context** - Must ensure `scopeTracker.enterScope()` is called BEFORE `createParameterNodes()` so semantic IDs are correct
   - Looking at ClassVisitor: `enterScope` is called for methods at line 342, which is BEFORE analyzeFunctionBody but we need params created right after function data is pushed
   - **Solution**: Call `createParameterNodes` right after `enterScope`

### Considerations
1. **Parameter ID format**: FunctionVisitor uses legacy format `PARAMETER#name#file#line:index`. Should we add semantic IDs?
   - For now: Keep consistent with FunctionVisitor (legacy format)
   - Future: Can enhance both at once if needed

2. **Edge creation**: HAS_PARAMETER edges are created in GraphBuilder, not in visitors. Verify GraphBuilder handles class method parameters correctly.
   - Check: `GraphBuilder.ts` should already handle this via `parentFunctionId` on ParameterInfo

## Summary

This is a straightforward feature addition with low architectural risk:
1. Extract shared utility (DRY)
2. Add parameter creation to ClassVisitor in two places (ClassMethod, ClassProperty)
3. Unskip existing tests + add new ones
4. Estimated effort: Small (2-3 hours)

The main thing to get right is the timing: `createParameterNodes` must be called after `scopeTracker.enterScope()` to ensure correct semantic context, but this is already the natural flow in ClassVisitor.

# REG-227: Rob Pike - Implementation Report

## Summary

Successfully implemented the CallResolverValidator resolution categorization as specified in Joel's tech spec. The validator now correctly categorizes call resolution outcomes and only reports truly unresolved calls as warnings.

## Changes Made

### Step 1: Created `/packages/core/src/data/builtins/jsGlobals.ts`

New file containing the `JS_GLOBAL_FUNCTIONS` constant - a shared Set of JavaScript built-in global functions that don't need CALLS edges:

- Global functions: `parseInt`, `parseFloat`, `isNaN`, `isFinite`, `eval`, `encodeURI`, `decodeURI`, `encodeURIComponent`, `decodeURIComponent`
- Timers: `setTimeout`, `setInterval`, `setImmediate`, `clearTimeout`, `clearInterval`, `clearImmediate`
- CommonJS: `require`

### Step 2: Updated `/packages/core/src/data/builtins/index.ts`

Added export for the new constant:
```typescript
export { JS_GLOBAL_FUNCTIONS } from './jsGlobals.js';
```

### Step 3: Updated `/packages/core/src/plugins/enrichment/ExternalCallResolver.ts`

1. Added import from shared location:
   ```typescript
   import { JS_GLOBAL_FUNCTIONS } from '../../data/builtins/index.js';
   ```

2. Removed local `JS_BUILTINS` definition (lines 43-68 in original)

3. Replaced all usages of `JS_BUILTINS` with `JS_GLOBAL_FUNCTIONS`

### Step 4: Rewrote `/packages/core/src/plugins/validation/CallResolverValidator.ts`

Complete rewrite with the following key changes:

1. **New Resolution Type System**: Added `ResolutionType` enum with 5 categories:
   - `internal` - CALLS edge to FUNCTION node
   - `external` - CALLS edge to EXTERNAL_MODULE node
   - `builtin` - Name in JS_GLOBAL_FUNCTIONS
   - `method` - Has 'object' attribute (not validated)
   - `unresolved` - No edge, not builtin

2. **New ValidationSummary Structure**:
   ```typescript
   interface ValidationSummary {
     totalCalls: number;
     resolvedInternal: number;
     resolvedExternal: number;
     resolvedBuiltin: number;
     methodCalls: number;
     unresolvedCalls: number;
     warnings: number;
   }
   ```

3. **Programmatic Resolution Detection**: Replaced Datalog-based validation with programmatic checks using `determineResolutionType()` method

4. **Warning vs Error**: Changed error code from `ERR_UNRESOLVED_CALL` to `WARN_UNRESOLVED_CALL` with severity `'warning'`

5. **Dependencies**: Added explicit dependencies on `FunctionCallResolver` and `ExternalCallResolver`

## Type Fix

Joel's spec assumed `NodeRecord` was a simple interface, but it's actually a union type. Fixed by using `BaseNodeRecord` instead:

```typescript
// Before (didn't compile)
interface CallNode extends NodeRecord { ... }

// After (compiles correctly)
interface CallNode extends BaseNodeRecord { ... }
```

## Test Results

All 13 test suites pass, including the 4 new REG-227 tests:

1. **should NOT flag JavaScript built-in function calls** - PASS
2. **should NOT flag external package calls with CALLS edges** - PASS
3. **should flag truly unresolved calls as warnings (not errors)** - PASS
4. **should correctly categorize mixed resolution types in summary** - PASS
5. **should handle eval as builtin but flag Function constructor** - PASS (updated test)

## Verification

```bash
$ npm run build
# All packages build successfully

$ node --test test/unit/CallResolverValidator.test.js
# ok 1 - CallResolverValidator (13 suites, all passing)
```

## Files Modified

| File | Change |
|------|--------|
| `packages/core/src/data/builtins/jsGlobals.ts` | NEW - JS_GLOBAL_FUNCTIONS constant |
| `packages/core/src/data/builtins/index.ts` | Added export |
| `packages/core/src/plugins/enrichment/ExternalCallResolver.ts` | Import shared constant, remove local |
| `packages/core/src/plugins/validation/CallResolverValidator.ts` | Complete rewrite |

## Notes

- Matched existing code patterns in the codebase
- Used `BaseNodeRecord` to avoid TypeScript union type issues
- Maintained backward compatibility with existing test infrastructure
- All changes are minimal and focused on the task requirements

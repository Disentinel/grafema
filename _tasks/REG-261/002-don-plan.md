# Don Melton - Tech Lead Analysis: REG-261 Broken Import Detection

## Executive Summary

This is **exactly what Grafema should do**. Detecting broken imports is a core use case for untyped JS codebases where TypeScript isn't an option. The architecture is already 90% there - we just need to expose the data that `ImportExportLinker` and `FunctionCallResolver` already track as validation errors.

## Current State Analysis

### What Already Exists

1. **ImportExportLinker** (`packages/core/src/plugins/enrichment/ImportExportLinker.ts`)
   - Creates `IMPORTS_FROM` edges linking IMPORT nodes to EXPORT nodes
   - Already tracks `notFound` counter for unresolved imports
   - Line 165-167: When export not found, increments `notFound` but doesn't emit diagnostic

2. **FunctionCallResolver** (`packages/core/src/plugins/enrichment/FunctionCallResolver.ts`)
   - Follows import chains to resolve function calls
   - Tracks `skipped.missingImport` - calls where no matching import exists
   - Tracks `skipped.missingImportsFrom` - imports without IMPORTS_FROM edge
   - Tracks `skipped.reExportsBroken` - broken re-export chains

3. **Validation Infrastructure**
   - `ValidationError` class with configurable severity (error/warning/fatal)
   - `DiagnosticCollector` accumulates errors during analysis
   - `DiagnosticReporter` outputs to `diagnostics.log`
   - `CHECK_CATEGORIES` in check.ts already defines diagnostic groupings

### Graph Data Available

**IMPORT nodes have:**
- `id`: Semantic ID like `{file}:IMPORT:{source}:{name}`
- `source`: Module path (e.g., `./utils`, `lodash`)
- `importType`: `'default'` | `'named'` | `'namespace'`
- `imported`: Original name in source module
- `local`: Local binding name in this file
- `file`, `line`, `column`: Location info

**EXPORT nodes have:**
- `id`: Semantic ID like `{file}->global->EXPORT->{name}`
- `exportType`: `'default'` | `'named'` | `'all'`
- `local`: Local name of exported value
- `source`: Re-export source (for `export { foo } from './other'`)
- `file`, `line`, `column`: Location info

**Edges:**
- `IMPORTS_FROM`: IMPORT -> EXPORT (created by ImportExportLinker)
- `CALLS`: CALL -> FUNCTION (created by FunctionCallResolver)

## Two Distinct Problems

### Problem 1: Broken Import (ERR_BROKEN_IMPORT)

**Definition:** Import references an export that doesn't exist in the source module.

**Example:**
```javascript
import { nonExistentFunction } from './utils';  // utils.js doesn't export nonExistentFunction
```

**Detection Strategy:**
1. For each IMPORT node with relative source
2. Check if it has an IMPORTS_FROM edge
3. If not, the import is broken

**Why this works:** ImportExportLinker only creates IMPORTS_FROM edges when a matching EXPORT exists. If no edge was created, the export doesn't exist.

### Problem 2: Undefined Symbol (ERR_UNDEFINED_SYMBOL)

**Definition:** A symbol is used but is neither:
- Defined locally (FUNCTION, CLASS, VARIABLE in same module)
- Imported (IMPORT with matching local name)
- A global (console, setTimeout, process, etc.)

**Example:**
```javascript
existingFunction();  // Not imported, not defined, not global
```

**Detection Strategy:**
1. For each CALL node without `object` property (not a method call)
2. Check if it has a CALLS edge (already resolved to a function)
3. If not, check if callee name matches a local definition
4. If not, check if callee name is in globals list
5. If none match, the symbol is undefined

**Important:** This overlaps with what `CallResolverValidator` already does, but that validator only reports "unresolved calls" - it doesn't distinguish between "imported but broken" vs "not imported at all".

## Architectural Decision: Where to Implement

### Option A: Extend ImportExportLinker + FunctionCallResolver (WRONG)

Add ValidationError emission directly in enrichment plugins.

**Problems:**
- Violates phase separation (ENRICHMENT vs VALIDATION)
- Enrichment plugins should focus on graph building
- Error emission would be scattered across multiple plugins

### Option B: New Dedicated Validator (RIGHT)

Create `BrokenImportValidator` in VALIDATION phase.

**Why this is right:**
- Clean phase separation
- Single source of truth for import validation
- Can be run independently via `grafema check imports`
- Follows pattern of existing validators (DataFlowValidator, CallResolverValidator)
- Can accumulate all issues and report them coherently

## Proposed Architecture

### New Files

1. **`packages/core/src/plugins/validation/BrokenImportValidator.ts`**
   - Phase: VALIDATION
   - Priority: 85 (after data flow enrichment, before general validators)
   - Dependencies: ImportExportLinker, FunctionCallResolver

### Error Codes

| Code | Severity | Description |
|------|----------|-------------|
| `ERR_BROKEN_IMPORT` | error | Named/default import references non-existent export |
| `ERR_UNDEFINED_SYMBOL` | warning | Symbol used but not defined, imported, or global |
| `ERR_BROKEN_REEXPORT` | error | Re-export chain leads to missing export |

### Diagnostic Category

Add to `CHECK_CATEGORIES` in check.ts:
```typescript
'imports': {
  name: 'Import Validation',
  description: 'Check for broken imports and undefined symbols',
  codes: ['ERR_BROKEN_IMPORT', 'ERR_UNDEFINED_SYMBOL', 'ERR_BROKEN_REEXPORT'],
}
```

## Edge Cases to Handle

### 1. Re-exports / Barrel Files
```javascript
// index.js
export { foo } from './foo';
export { bar } from './bar';
```

**Handling:** Must follow IMPORTS_FROM chains through re-exports. ImportExportLinker already does this when creating edges - if the chain is broken, no edge is created.

### 2. Namespace Imports
```javascript
import * as utils from './utils';
utils.foo();  // Method call, not broken import
```

**Handling:** `importType === 'namespace'` creates IMPORTS_FROM to MODULE node. Method calls on namespace have `object` property - handled by method resolution, not this validator.

### 3. Dynamic Imports
```javascript
const utils = await import('./utils');
```

**Handling:** Currently not tracked as IMPORT nodes. Out of scope for v1 - track as future improvement.

### 4. CommonJS requires
```javascript
const { foo } = require('./utils');
```

**Handling:** JSASTAnalyzer creates IMPORT nodes for destructured requires. Should work with same logic.

### 5. TypeScript Type-Only Imports
```javascript
import type { MyType } from './types';
```

**Handling:** `importBinding === 'type'` should be skipped for runtime validation - these are erased at compile time.

### 6. Globals
```javascript
console.log('hello');
setTimeout(() => {}, 1000);
```

**Handling:** Need globals list. NodejsBuiltinsResolver already has this - can reuse or extend.

### 7. Implicit Globals (window, document in browser)
```javascript
document.getElementById('foo');
```

**Handling:** Environment-specific globals. For v1, include common browser globals. Config option for future.

## Algorithm (Pseudo-code)

```
BrokenImportValidator.execute():

  # Build indexes
  allImports = queryNodes({ type: 'IMPORT' })
  allCalls = queryNodes({ type: 'CALL' }).filter(c => !c.object)
  definitionsByFile = Map<file, Set<name>>  # FUNCTION, CLASS, VARIABLE
  importsByFile = Map<file, Map<localName, importNode>>
  globals = Set('console', 'setTimeout', 'process', ...)

  errors = []

  # Problem 1: Broken Imports
  for import in allImports:
    if import.source is external:  # npm package
      continue  # Skip external modules

    if import.importType == 'namespace':
      continue  # Namespace imports link to MODULE, not EXPORT

    if import.importBinding == 'type':
      continue  # Type-only imports erased at compile time

    importsFromEdges = getOutgoingEdges(import.id, ['IMPORTS_FROM'])
    if importsFromEdges.length == 0:
      errors.push(ValidationError(
        message: `Import "${import.imported}" from "${import.source}" - export doesn't exist`,
        code: 'ERR_BROKEN_IMPORT',
        context: { file: import.file, line: import.line }
      ))

  # Problem 2: Undefined Symbols
  for call in allCalls:
    if call has CALLS edge:
      continue  # Already resolved

    name = call.name
    file = call.file

    # Check local definitions
    if definitionsByFile[file].has(name):
      continue  # Locally defined

    # Check imports
    if importsByFile[file].has(name):
      continue  # Imported (even if broken - that's a different error)

    # Check globals
    if globals.has(name):
      continue  # Global function

    errors.push(ValidationError(
      message: `"${name}" is used but not defined or imported`,
      code: 'ERR_UNDEFINED_SYMBOL',
      context: { file: call.file, line: call.line }
    ))

  return errors
```

## Output Format

```
[ERR_BROKEN_IMPORT] Import "nonExistentFunction" from "./utils" - export doesn't exist
  /path/to/Invitations.tsx:3

[ERR_UNDEFINED_SYMBOL] "existingFunction" is used but not defined or imported
  /path/to/Invitations.tsx:45
```

## Integration Points

1. **DiagnosticReporter:** Add category mapping for new error codes
2. **check.ts:** Add 'imports' category to CHECK_CATEGORIES
3. **core/index.ts:** Export BrokenImportValidator
4. **Orchestrator:** Will auto-discover via phase registration

## Test Strategy

1. **Unit tests:**
   - Broken named import
   - Broken default import
   - Broken re-export chain
   - Valid import (no false positive)
   - Undefined symbol
   - Local definition (no false positive)
   - Global usage (no false positive)
   - Namespace import (should not error)
   - Type-only import (should not error)

2. **Integration test:**
   - Full analysis with broken imports
   - `grafema check imports` output verification

## Non-Goals for v1

1. **Dynamic imports** - Complex to track, defer to future
2. **Custom globals configuration** - Default list is sufficient for now
3. **Fixing suggestions** - Just detection, no auto-fix
4. **IDE integration** - Just CLI/diagnostics.log for now

## Risk Assessment

**Low risk:**
- Follows existing validator patterns exactly
- Data already available in graph
- No changes to enrichment plugins needed

**Medium risk:**
- False positives from missing globals
- Mitigation: Include comprehensive globals list, allow override

## Success Criteria

1. `grafema analyze` followed by `grafema check imports` detects:
   - Broken imports with non-existent exports
   - Undefined symbols (neither local nor imported nor global)

2. No false positives on valid code

3. Clear, actionable error messages with file:line locations

## Recommendation

**APPROVED for implementation.**

This is architecturally sound and aligns with Grafema's vision. The graph already contains the data; we just need to query it properly and report the results. Implementation should be straightforward following existing validator patterns.

---

**Next Steps:**
1. Joel expands into detailed tech spec
2. Kent writes tests first (TDD)
3. Rob implements the validator

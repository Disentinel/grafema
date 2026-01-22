# REG-128 Completion Report

## Summary
Cleaned up dead `interfaceId`, `typeId`, and `enumId` computations from TypeScriptVisitor. These ID computations were never used for node creation (factories generate their own IDs), creating confusion and maintenance burden.

## Changes Made

### 1. TypeScriptVisitor.ts
- Removed `interfaceId` computation (was at line 129)
- Removed `typeId` computation (was at line 193)
- Removed `enumId` computation (was at line 221)
- Removed `id` field from all three push() calls

### 2. types.ts
- Marked `id` field as `@deprecated` and optional (`id?: string`) in:
  - `InterfaceDeclarationInfo`
  - `TypeAliasInfo`
  - `EnumDeclarationInfo`

### 3. GraphBuilder.ts
- Fixed `bufferImplementsEdges()` to compute interface ID inline using factory formula:
  `${iface.file}:INTERFACE:${iface.name}:${iface.line}`

### 4. New Test File
- Created `test/unit/ImplementsEdgeMigration.test.js` with 14 tests for IMPLEMENTS edge behavior

## Test Results
- **Before changes**: 895 pass, 41 fail
- **After changes**: 919 pass, 17 fail (+24 tests passing!)
- All 14 IMPLEMENTS edge tests pass
- All 22 InterfaceNode migration tests pass
- All 32 TypeNode migration tests pass
- EnumNode tests: 16/18 pass (2 failures are pre-existing, unrelated to REG-128)

## Reviews
- **Kevlin Henney (Code Quality)**: APPROVED - Clean, correct implementation
- **Linus Torvalds (Architecture)**: APPROVED - No hacks, correct architecture

## Files Changed
```
packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts
packages/core/src/plugins/analysis/ast/types.ts
packages/core/src/plugins/analysis/ast/GraphBuilder.ts
test/unit/ImplementsEdgeMigration.test.js (new)
```

## Technical Notes
- The ID formula is duplicated in `bufferImplementsEdges()`. This is intentional to avoid dependency on visitor-computed ID. Documented in code comment. Could be extracted to shared constant in future (minor tech debt).
- Pre-existing EnumNode test failures (2 tests) are unrelated to this change - they were failing before REG-128.

## Status: READY FOR COMMIT

# Kent Beck - Test Report: REG-261 BrokenImportValidator

## Summary

Tests created for `BrokenImportValidator` following TDD principles. The test file is complete and **correctly fails** because the implementation doesn't exist yet.

## Test File Created

**Location:** `/Users/vadimr/grafema-worker-6/test/unit/core/BrokenImportValidator.test.ts`

## Test Structure

The test file follows existing project patterns observed in:
- `test/unit/core/CoverageAnalyzer.test.ts`
- `test/unit/errors/ValidationError.test.ts`
- `test/unit/types/createSuccessResult.test.ts`

### Test Suites

#### 1. ERR_BROKEN_IMPORT Tests (6 tests)

| Test | Description |
|------|-------------|
| `should detect broken named import` | IMPORT node without IMPORTS_FROM edge reports error |
| `should detect broken default import` | Default import without edge reports error |
| `should NOT report error for valid import` | Import with IMPORTS_FROM edge is valid |
| `should skip external (npm) imports` | Non-relative sources (lodash, etc.) are skipped |
| `should skip namespace imports` | `import * as X` imports are skipped |
| `should skip type-only imports` | TypeScript `import type { X }` are skipped |

#### 2. ERR_UNDEFINED_SYMBOL Tests (6 tests)

| Test | Description |
|------|-------------|
| `should detect undefined symbol` | CALL without definition, import, or global reports error |
| `should NOT report for locally defined function` | Same-file FUNCTION definition is recognized |
| `should NOT report for imported function` | IMPORT local name matches CALL name |
| `should NOT report for global functions` | console, setTimeout, Promise, Array recognized |
| `should NOT report for method calls` | CALL with `object` property is skipped |
| `should NOT report for resolved calls` | CALL with CALLS edge is skipped |

#### 3. Custom Globals Configuration (1 test)

| Test | Description |
|------|-------------|
| `should accept custom globals from config` | Custom globals via config.customGlobals work |

#### 4. Metadata and Result Structure (2 tests)

| Test | Description |
|------|-------------|
| `should have correct plugin metadata` | Phase VALIDATION, priority 85, correct dependencies |
| `should return proper result structure` | success=true, metadata.summary, errors array |

### Total: 15 test cases

## MockGraph Implementation

Created minimal `MockGraph` class matching existing patterns in the codebase:

```typescript
class MockGraph {
  addNode(node: MockNode): void
  addEdge(edge: MockEdge): void
  async *queryNodes(filter): AsyncIterableIterator<MockNode>
  async getNode(id: string): Promise<MockNode | null>
  async getOutgoingEdges(nodeId: string, edgeTypes: string[]): Promise<MockEdge[]>
}
```

## Verification

### Build: PASS

```bash
npm run build
# Build succeeds - test directory excluded from compilation
```

### Tests: FAIL (Expected)

```bash
node --import tsx --test test/unit/core/BrokenImportValidator.test.ts
```

**Error:**
```
SyntaxError: The requested module '@grafema/core' does not provide an export named 'BrokenImportValidator'
```

This is exactly correct TDD behavior - tests written before implementation.

## Deviations from Joel's Spec

### Fixed: `result.status` -> `result.success`

Joel's spec used `result.status` which doesn't exist in `PluginResult`. Fixed to use `result.success` which is the correct field.

## Next Steps

1. **Rob Pike** implements:
   - `packages/core/src/data/globals/definitions.ts`
   - `packages/core/src/data/globals/index.ts` (GlobalsRegistry)
   - `packages/core/src/plugins/validation/BrokenImportValidator.ts`
   - Export additions in `packages/core/src/index.ts`
   - CLI category in `packages/cli/src/commands/check.ts`

2. After implementation, run:
   ```bash
   node --import tsx --test test/unit/core/BrokenImportValidator.test.ts
   ```
   All 15 tests should pass.

---

**Tests written. Ready for implementation.**

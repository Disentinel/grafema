# Kent Beck — Test Report: REG-222 Phase 1 (InterfaceSchemaExtractor)

## Summary

Created test file for `InterfaceSchemaExtractor` following TDD principles. Tests are written first and fail because the implementation does not exist yet.

## Test File

**Location:** `/Users/vadimr/grafema-worker-1/test/unit/schema/InterfaceSchemaExtractor.test.ts`

## Tests Written

### `describe('InterfaceSchemaExtractor')`

#### `describe('extract()')`

| Test | Purpose |
|------|---------|
| should extract simple interface with flat properties | Verifies basic extraction of interface with `host: string` and `port: number` properties |
| should extract interface with optional properties | Verifies `required: false` for optional properties (marked with `?`) |
| should extract interface with readonly properties | Verifies `readonly: true` for readonly properties |
| should extract interface with extends | Verifies `extends` array contains parent interface names |
| should extract interface with method signatures (Phase 1: type=function) | Verifies methods are represented as `type: 'function'` (Phase 1 limitation) |
| should extract interface with type parameters | Verifies `typeParameters` array contains generic parameters |
| should return null for non-existent interface | Verifies graceful handling of missing interfaces |
| should throw error for ambiguous name (multiple files) | Verifies error when same interface name exists in multiple files |
| should resolve ambiguity with file option | Verifies `{ file: '/src/a.ts' }` option resolves ambiguity |
| should resolve ambiguity with partial file path | Verifies partial path like `'b.ts'` works for disambiguation |
| should produce deterministic checksum regardless of property order | Verifies checksum stability by sorting properties before hashing |
| should include source location in schema | Verifies `source.file`, `source.line`, `source.column` are correct |
| should sort properties alphabetically in output | Verifies properties are alphabetically sorted in schema output |

**Total: 13 tests**

## Test Infrastructure

Created `MockBackend` class that implements the minimal interface needed for testing:
- `addInterface(node)` - adds mock interface node
- `queryNodes(filter)` - async generator yielding nodes matching filter
- `connect()` / `close()` - no-op methods for interface compliance

## Current Status

**Tests fail as expected (TDD):**

```
SyntaxError: The requested module '@grafema/core' does not provide an export named 'InterfaceSchemaExtractor'
```

This is correct TDD behavior - implementation must be created to make tests pass.

## Run Command

```bash
node --import tsx --test test/unit/schema/InterfaceSchemaExtractor.test.ts
```

## Dependencies for Implementation

The implementation will need:
1. Create `/packages/core/src/schema/InterfaceSchemaExtractor.ts`
2. Create `/packages/core/src/schema/index.ts`
3. Export from `/packages/core/src/index.ts`:
   - `InterfaceSchemaExtractor`
   - `InterfaceSchema` type
   - `PropertySchema` type
   - `ExtractOptions` type

## Schema Interface (from tests)

Tests expect the following schema structure:

```typescript
interface InterfaceSchema {
  $schema: 'grafema-interface-v1';
  name: string;
  source: {
    file: string;
    line: number;
    column: number;
  };
  typeParameters?: string[];
  properties: Record<string, PropertySchema>;
  extends: string[];
  checksum: string; // format: 'sha256:...'
}

interface PropertySchema {
  type: string;
  required: boolean;
  readonly: boolean;
}

interface ExtractOptions {
  file?: string; // for disambiguation
}
```

## Pattern Notes

- Used Node.js test runner (`node:test`)
- Followed existing project patterns from `CoverageAnalyzer.test.ts` and `GrafemaError.test.ts`
- MockBackend pattern matches existing tests
- Import from `@grafema/core` as per project convention

---

*"Tests communicate intent. The implementation will make them pass."*

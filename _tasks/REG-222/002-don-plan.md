# Don Melton — Technical Analysis: REG-222 Phase 1 (Interface Schema Export)

## Executive Summary

**Verdict: We can build this, but not the way the user expects.**

The requirement asks for interface schema export with `default` values. But TypeScript interfaces don't have default values — they're structural type declarations, not runtime constructs. This reveals a deeper question: **what contract are we actually trying to track?**

---

## Current State Analysis

### 1. Graph Representation of Interfaces

Grafema already tracks TypeScript interfaces comprehensively:

**InterfaceNode** (`/packages/core/src/core/nodes/InterfaceNode.ts`):
```typescript
interface InterfacePropertyRecord {
  name: string;
  type?: string;
  optional?: boolean;
  readonly?: boolean;
}

interface InterfaceNodeRecord extends BaseNodeRecord {
  type: 'INTERFACE';
  column: number;
  extends: string[];
  properties: InterfacePropertyRecord[];
  isExternal?: boolean;
}
```

**TypeScriptVisitor** (`/packages/core/src/plugins/analysis/ast/visitors/TypeScriptVisitor.ts`):
- Handles `TSInterfaceDeclaration`
- Extracts properties via `TSPropertySignature`
- Handles method signatures via `TSMethodSignature`
- Tracks `optional` and `readonly` modifiers
- Resolves type annotations to string representation

**What's already captured:**
- Interface name, location (file:line:column)
- Properties with types (`string`, `number`, `MyType[]`, etc.)
- Optional markers (`?`)
- Readonly markers
- Inheritance (`extends`)
- Method signatures (typed as `function`)

### 2. What's NOT Captured (and why it's tricky)

**Default values don't exist in interfaces:**
```typescript
// This is NOT valid TypeScript:
interface ConfigSchema {
  port: number = 3000;  // ERROR: Interfaces cannot have initializers
}

// Defaults exist in:
// 1. Class properties
class Config {
  port: number = 3000;  // OK
}

// 2. Function parameters
function createConfig(port: number = 3000) { }

// 3. Object destructuring
const { port = 3000 } = options;
```

**The user request mentions:**
```json
"exclude": { "type": "string[]", "required": false, "default": [] }
```

This suggests they want to track not just the interface shape, but also how it's used — where defaults are applied when the interface is consumed.

### 3. CLI Command Structure

Current CLI uses Commander.js pattern (`/packages/cli/src/cli.ts`):
```typescript
import { Command } from 'commander';

export const someCommand = new Command('name')
  .description('...')
  .option('-p, --project <path>', '...')
  .action(async (options) => { ... });
```

Commands are registered in `cli.ts` and follow consistent patterns for:
- Project path resolution
- Graph database connection
- JSON/text output modes
- Error handling via `exitWithError()`

---

## The Real Question

The user's example output includes `default` values. But interfaces don't have defaults. So what are they actually trying to track?

**Three possible interpretations:**

1. **Just the interface structure** — Ignore defaults, track shape only
2. **Interface + common usage patterns** — Track where this interface is used and what defaults are applied there
3. **Configuration schema contract** — The interface is a proxy for a broader "config contract" that includes validation, defaults, etc.

**My recommendation: Start with interpretation #1, design for #3**

Phase 1 should extract interface structure cleanly. But the architecture should anticipate that "default" information might come from:
- Class implementations of the interface
- Factory functions that create objects matching the interface
- Validation schemas (Zod, Yup, Joi) that implement the same shape

---

## Architectural Decisions

### Decision 1: New `schema` subcommand vs extending existing commands

**Recommended: New `schema` subcommand**

```bash
grafema schema export --interface ConfigSchema
grafema schema export --graph  # Phase 2
```

Reasons:
- Clear namespace for schema-related operations
- Future expansion: `schema validate`, `schema diff`, `schema migrate`
- Doesn't pollute existing commands

### Decision 2: Output Format

**Recommended format:**
```json
{
  "$schema": "grafema-interface-v1",
  "name": "ConfigSchema",
  "source": {
    "file": "src/config/types.ts",
    "line": 15,
    "column": 1
  },
  "properties": {
    "entrypoints": {
      "type": "string[]",
      "required": true,
      "readonly": false
    },
    "exclude": {
      "type": "string[]",
      "required": false,
      "readonly": false
    }
  },
  "extends": [],
  "checksum": "sha256:a1b2c3..."
}
```

**Key differences from user's example:**
- No `default` field (interfaces don't have defaults)
- `required` derived from `optional?: boolean` (inverted)
- Added `readonly` which IS part of interface syntax
- Clear `source` object instead of single string
- Explicit schema version (`grafema-interface-v1`)

### Decision 3: Checksum Strategy

**Recommended: Content-based hash**

```typescript
// Hash the normalized interface content, not the output JSON
const content = {
  name: interface.name,
  properties: sortedProperties,  // Sorted for determinism
  extends: sortedExtends
};
const checksum = sha256(JSON.stringify(content));
```

This ensures:
- Same interface = same checksum (regardless of output format)
- Property order changes don't affect checksum
- Only structural changes trigger checksum change

### Decision 4: Interface Lookup

**Problem:** User provides name (`ConfigSchema`), but graph stores full ID (`/path/to/types.ts:INTERFACE:ConfigSchema:15`)

**Solution:** Query by name, handle ambiguity
```typescript
// 1. Query all INTERFACE nodes
// 2. Filter by name match
// 3. If multiple matches (same name, different files):
//    - Error with list of locations
//    - User can specify: --interface ConfigSchema --file src/config/types.ts
```

---

## Implementation Plan

### Phase 1.1: Core Schema Extractor

**File:** `packages/core/src/schema/InterfaceSchemaExtractor.ts`

```typescript
interface InterfaceSchema {
  $schema: 'grafema-interface-v1';
  name: string;
  source: { file: string; line: number; column: number };
  properties: Record<string, PropertySchema>;
  extends: string[];
  checksum: string;
}

interface PropertySchema {
  type: string;
  required: boolean;
  readonly: boolean;
}

class InterfaceSchemaExtractor {
  constructor(private backend: RFDBServerBackend) {}

  async extract(interfaceName: string, options?: ExtractOptions): Promise<InterfaceSchema>;
  async findInterface(name: string): Promise<InterfaceNodeRecord[]>;
}
```

### Phase 1.2: CLI Command

**File:** `packages/cli/src/commands/schema.ts`

```typescript
export const schemaCommand = new Command('schema')
  .description('Extract and manage code schemas');

const exportSubcommand = new Command('export')
  .description('Export schema to file')
  .option('--interface <name>', 'Extract TypeScript interface')
  .option('--graph', 'Extract graph schema (node/edge types)')
  .option('--format <type>', 'Output format: json|yaml|markdown', 'json')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-o, --output <file>', 'Output file (default: stdout)')
  .action(async (options) => { ... });

schemaCommand.addCommand(exportSubcommand);
```

### Phase 1.3: Format Converters

**File:** `packages/cli/src/schema/formatters.ts`

```typescript
interface SchemaFormatter {
  format(schema: InterfaceSchema): string;
}

class JsonFormatter implements SchemaFormatter { ... }
class YamlFormatter implements SchemaFormatter { ... }
class MarkdownFormatter implements SchemaFormatter { ... }
```

### Phase 1.4: Tests

**Files:**
- `test/unit/schema/InterfaceSchemaExtractor.test.ts`
- `test/unit/cli/schema-command.test.ts`

Test scenarios:
1. Extract simple interface (flat properties)
2. Extract interface with optional properties
3. Extract interface with readonly properties
4. Extract interface with extends
5. Extract interface with method signatures
6. Handle ambiguous name (same name in multiple files)
7. Handle non-existent interface
8. Verify deterministic output (sorted properties)
9. Verify checksum stability

---

## Open Questions (Require User Input)

### Q1: Default Values

The requirement shows `"default": []` in the output. Since interfaces don't have defaults, should we:

A) Omit defaults entirely (accurate to TypeScript)
B) Track defaults from common usage patterns (e.g., class implementations)
C) Add a separate `--with-implementations` flag for future

**Recommendation:** A for Phase 1, document B/C as future enhancement.

### Q2: Method Signatures

Current implementation marks method signatures as `type: 'function'`. Should we:

A) Keep simple `function` type
B) Extract full signature: `(arg1: T1, arg2: T2) => R`

**Recommendation:** B if we have the data. Check if TypeScriptVisitor captures method params.

### Q3: Generic Interfaces

```typescript
interface Response<T> {
  data: T;
  error?: string;
}
```

Should we:

A) Ignore generics (treat as `unknown`)
B) Include type parameters in schema

**Recommendation:** B, but may need TypeScriptVisitor enhancement.

---

## Dependencies

### Required (Phase 1):
- None — all infrastructure exists

### Nice to have:
- REG-??? (future): Track default values from class implementations

### Blocked by (Phase 2 — Graph Schema):
- REG-228: Object property literal tracking
- REG-230: Sink-based value domain query

---

## Risk Assessment

### Low Risk
- CLI command structure: Well-established pattern
- Interface node access: Already implemented
- JSON output: Trivial

### Medium Risk
- Property type resolution: TypeScriptVisitor uses simplified type strings
- Checksum stability: Need deterministic serialization

### High Risk
- None identified for Phase 1

---

## Alignment with Project Vision

**"AI should query the graph, not read code"**

This feature enables:
1. AI agents can query interface contracts without parsing source
2. Schema changes detected automatically (checksum diff)
3. Contract documentation generated from graph, always accurate

**Dogfooding value:**
- Grafema can track its own config schema contract
- Pre-commit hook validates schema hasn't changed unexpectedly
- Demonstrates Grafema's utility for contract tracking

---

## Next Steps

1. **User decision** on Q1-Q3 above
2. **Joel Spolsky** expands this into detailed implementation spec
3. **Kent Beck** writes tests based on spec
4. **Rob Pike** implements

---

*"I don't care if it works, is it RIGHT?"*

This plan is RIGHT because:
- It respects TypeScript semantics (no fake defaults)
- It builds on existing infrastructure (no new graph types needed)
- It's designed for extension (Phase 2 graph schema)
- It serves the project vision (graph as source of truth)

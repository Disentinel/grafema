# Joel Spolsky Technical Plan: REG-217

## Executive Summary

REG-217 requires enhancing the diagnostic output from `grafema analyze` to provide actionable, categorized warnings with corresponding check commands. This is a **presentation layer enhancement** - the diagnostic infrastructure is already solid.

## Current State Analysis

### 1. DiagnosticReporter
Current `summary()` method only returns severity counts: `Warnings: 8`

### 2. Diagnostic Codes Already Available
- **GraphConnectivityValidator**: `DISCONNECTED_NODES`
- **CallResolverValidator**: `UNRESOLVED_FUNCTION_CALL`
- **DataFlowValidator**: `MISSING_ASSIGNMENT`, `BROKEN_REFERENCE`, `NO_LEAF_NODE`

### 3. Check Command
Already supports `--guarantee` and `--list-guarantees` patterns.

---

## Implementation Plan

### Phase 1: Enhance DiagnosticReporter

**File: `packages/core/src/diagnostics/DiagnosticReporter.ts`**

#### 1.1 Add Category Mapping Interface and Constant

```typescript
export interface DiagnosticCategory {
  name: string;
  checkCommand: string;
}

const DIAGNOSTIC_CODE_CATEGORIES: Record<string, DiagnosticCategory> = {
  'DISCONNECTED_NODES': {
    name: 'disconnected nodes',
    checkCommand: 'grafema check connectivity'
  },
  'UNRESOLVED_FUNCTION_CALL': {
    name: 'unresolved calls',
    checkCommand: 'grafema check calls'
  },
  'MISSING_ASSIGNMENT': {
    name: 'missing assignments',
    checkCommand: 'grafema check dataflow'
  },
  'BROKEN_REFERENCE': {
    name: 'broken references',
    checkCommand: 'grafema check dataflow'
  },
  'NO_LEAF_NODE': {
    name: 'incomplete traces',
    checkCommand: 'grafema check dataflow'
  },
};
```

#### 1.2 Add Interfaces

```typescript
export interface CategoryCount {
  code: string;
  count: number;
  name: string;
  checkCommand: string;
}

export interface CategorizedSummaryStats extends SummaryStats {
  byCode: CategoryCount[];
}
```

#### 1.3 Add `getCategorizedStats()` Method

Groups diagnostics by code, returns `CategorizedSummaryStats`.

#### 1.4 Add `categorizedSummary()` Method

Output format:
```
Warnings: 8
  - 172 disconnected nodes (run `grafema check connectivity`)
  - 5 unresolved calls (run `grafema check calls`)

Run `grafema check --all` for full diagnostics.
```

---

### Phase 2: Add Check Subcommands

**File: `packages/cli/src/commands/check.ts`**

#### 2.1 Add Category Definitions

```typescript
const CHECK_CATEGORIES: Record<string, DiagnosticCheckCategory> = {
  'connectivity': {
    name: 'Graph Connectivity',
    description: 'Check for disconnected nodes in the graph',
    codes: ['DISCONNECTED_NODES'],
  },
  'calls': {
    name: 'Call Resolution',
    description: 'Check for unresolved function calls',
    codes: ['UNRESOLVED_FUNCTION_CALL'],
  },
  'dataflow': {
    name: 'Data Flow',
    description: 'Check for missing assignments and broken references',
    codes: ['MISSING_ASSIGNMENT', 'BROKEN_REFERENCE', 'NO_LEAF_NODE'],
  }
};
```

#### 2.2 Add Options
- `--list-categories` - List available diagnostic categories

#### 2.3 Add `runCategoryCheck()` Function
Reads stored diagnostics from `.grafema/diagnostics.log`, filters by category codes, displays results.

---

### Phase 3: Integrate into Analyze Output

**File: `packages/cli/src/commands/analyze.ts`**

Replace `reporter.summary()` with `reporter.categorizedSummary()`.

---

## Implementation Order

1. Add types and constants to DiagnosticReporter.ts
2. Add `getCategorizedStats()` method
3. Add `categorizedSummary()` method
4. Export new types from diagnostics/index.ts
5. Write tests for new DiagnosticReporter methods
6. Add category infrastructure to check.ts
7. Add `runCategoryCheck()` function
8. Write tests for check categories
9. Update analyze.ts to use `categorizedSummary()`
10. Run full test suite

---

## Test Plan

### DiagnosticReporter Tests
- `categorizedSummary()` returns "No issues found" when empty
- `categorizedSummary()` shows category counts with commands
- `categorizedSummary()` shows footer with --all command
- `categorizedSummary()` limits to top 5 categories
- `getCategorizedStats()` groups by code
- `getCategorizedStats()` sorts by count descending

### Check Command Tests
- `--list-categories` shows available categories
- Category subcommand shows filtered diagnostics
- `--all` shows all diagnostics

---

## Critical Files

| File | Changes |
|------|---------|
| `packages/core/src/diagnostics/DiagnosticReporter.ts` | Add `categorizedSummary()`, `getCategorizedStats()` |
| `packages/core/src/diagnostics/index.ts` | Export new types |
| `packages/cli/src/commands/check.ts` | Add category subcommands |
| `packages/cli/src/commands/analyze.ts` | Use `categorizedSummary()` |
| `test/unit/diagnostics/DiagnosticReporter.test.ts` | Add tests |

---

## Risk Mitigation

1. **Backward Compatibility**: `summary()` remains unchanged
2. **Missing Diagnostics File**: Clear error message
3. **Unknown Codes**: Fallback to generic "other" category

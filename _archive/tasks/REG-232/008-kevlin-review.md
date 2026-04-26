# Code Quality Review — REG-232 (Kevlin Henney)

## Files Reviewed
- `packages/core/src/plugins/enrichment/FunctionCallResolver.ts` (358 lines)
- `test/unit/FunctionCallResolver.test.js` (1,376 lines)

---

## Implementation Quality

### Strengths

**1. Clear Structure and Intent Communication**
- Class header comment (lines 1-12) excellently explains the plugin's purpose, execution order, and created edges
- Algorithm is broken into numbered steps (4.1, 4.2, etc.) making control flow obvious
- Private method `resolveExportChain` has thorough JSDoc explaining recursion, cycle detection, and base cases

**2. Type Safety**
- Proper use of TypeScript interfaces (`CallNode`, `ImportNode`, `ExportNode`) with optional fields marked correctly
- Type guards used appropriately (e.g., `as ExportNode | null` on line 187)
- Generic type `FunctionNode` is simple but adequate

**3. Error Handling**
- Graceful handling of missing data at each step (lines 73-77, 88-89, 102-103)
- Detailed skip counters track different failure modes separately (lines 152-160)
- Re-export chain resolution returns `null` on multiple failure paths, allowing caller to handle gracefully

**4. Index Building Pattern**
- Pre-builds three indices (importIndex, functionIndex, exportIndex) for O(1) lookups
- Prevents repeated graph queries in hot loop
- `knownFiles` set enables fast module path resolution

---

## Issues and Concerns

### 1. **Inconsistency in Export Key Building (MINOR)**

**Location:** Lines 110-118 vs lines 340-342

The export key construction appears in two places with slightly different logic:

```typescript
// Initial index build (lines 112-118)
if (exp.exportType === 'default') {
  exportKey = 'default';
} else if (exp.exportType === 'named') {
  exportKey = `named:${exp.name}`;
} else {
  exportKey = `named:${exp.name || 'anonymous'}`;
}

// Re-export chain resolution (lines 340-342)
const exportKey = exportNode.exportType === 'default'
  ? 'default'
  : `named:${exportNode.local || exportNode.name}`;
```

**Issues:**
- Line 115 uses `exp.name` but line 342 uses `exportNode.local || exportNode.name`
- The else clause (line 117) handles undefined with 'anonymous' fallback, but this isn't tested
- Reference to ImportExportLinker lines 207-217 (line 110) suggests pattern should match exactly

**Recommendation:** Extract export key generation to a private helper method. This ensures single source of truth and makes the logic testable in isolation.

```typescript
private buildExportKey(exportNode: ExportNode): string {
  if (exportNode.exportType === 'default') return 'default';
  const name = exportNode.local || exportNode.name;
  return `named:${name || 'anonymous'}`;
}
```

---

### 2. **Ambiguous Skip Counter (MINOR)**

**Location:** Lines 158-159

```typescript
reExportsBroken: 0,    // Re-export chain broken (missing export, file not found)
reExportsCircular: 0   // Circular re-export detected
```

**Issue:** The code (lines 205-210) treats all chain failures as `reExportsBroken`, but the logic distinguishes between:
- Circular (visited set would detect it)
- Broken (file not found, export not found)

The comment on line 207-208 acknowledges this: "For simplicity, count as broken (can add nuance later)"

**Problem:** This makes the skip counters misleading. If someone later needs circular detection, they'll see `reExportsCircular > 0` is always 0 and might assume it's working.

**Recommendation:** Either:
- Actually implement the distinction (track visited set size, distinguish cycle from missing export)
- Remove `reExportsCircular` counter and document why it's not tracked

Prefer removing it now rather than adding dead metrics.

---

### 3. **Missing `file` Validation in Key Step (MINOR)**

**Location:** Line 166

```typescript
const file = callSite.file;
if (!calledName || !file) continue;
```

This guards against missing file, but earlier at line 168 there's already a guard. The check is fine but creates slight redundancy in thinking.

**Not a bug**, just slightly inelegant. The check is correct.

---

## Test Quality

### Strengths

**1. Excellent Coverage**
- 16 test cases covering main paths and edge cases
- Each test has clear setup comments explaining the scenario
- Tests are independent (no shared state between tests)

**2. Clear Test Organization**
- Grouped by feature (Named imports, Default imports, Re-exports, etc.)
- Section headers make navigation easy
- Test names clearly describe what's being tested

**3. Proper Assertion Messages**
- All assertions include descriptive messages (e.g., "Should point to the function")
- Makes failures immediately understandable

**4. Good Edge Case Coverage**
- External/scoped packages (lines 417-503)
- Circular re-exports (lines 737-811)
- Missing IMPORTS_FROM edges (lines 509-558)
- Already resolved calls (lines 340-411)
- Multiple calls to same function (lines 1043-1132)

### Issues and Concerns

### 1. **Test Structure Duplication (MINOR)**

**Pattern appears ~15 times:**
```javascript
try {
  const resolver = new FunctionCallResolver();
  // ... setup and assertions ...
} finally {
  await backend.close();
}
```

**Better approach:**
```javascript
async function setupResolver() {
  const resolver = new FunctionCallResolver();
  return resolver;
}

// Then use with proper teardown in beforeEach/afterEach
```

**Why it matters:** The current pattern works but makes tests harder to read. The setup/teardown is noise obscuring the test logic.

**Note:** Node's test runner has `afterEach` hooks since node 20+. Check if this project supports them.

---

### 2. **Weak Assertion on Circular Re-export (MINOR)**

**Location:** Lines 801-805

```javascript
assert.ok(
  result.metadata.skipped.reExportsBroken > 0 ||
  result.metadata.skipped.reExportsCircular > 0,
  'Should report circular/broken chain in skipped counters'
);
```

**Problem:** Tests that `reExportsBroken > 0` (which always happens) but `reExportsCircular` is never incremented in code (as noted in implementation issue #2 above).

**Better:**
```javascript
assert.strictEqual(
  result.metadata.skipped.reExportsBroken, 1,
  'Should report 1 broken/circular chain'
);
```

---

### 3. **Missing Test: Export Named as Different Name (MINOR)**

No test covers:
```javascript
export { foo as bar } from './other'  // local != imported
```

The code (line 342) uses `exportNode.local || exportNode.name` suggesting this pattern is handled. Worth testing explicitly.

---

### 4. **No Test for maxDepth Safety (MINOR)**

The `resolveExportChain` has `maxDepth` limit (lines 309-311) but no test verifies it stops at exactly depth 10 or returns null. Chain tests go 1-2 hops but not edge case.

---

## Naming and Structure

**Excellent:**
- `FunctionCallResolver` - clear, specific
- `resolveExportChain` - verb-noun pattern, clear direction
- `resolveModulePath` - matches pattern in ImportExportLinker
- Index names: `importIndex`, `functionIndex`, `exportIndex` - consistent, descriptive
- `skipped` object groups related counters

**Minor:**
- `CallNode` interface has `object?: string` but could be `callObject?: string` to avoid confusion with JS `object` type. But context makes it clear.

---

## Overall Assessment

This is **high-quality, production-ready code**. The implementation is clean, well-documented, and handles edge cases gracefully. Tests are comprehensive and well-organized.

### Issues Found
- 1 logic inconsistency (export key building) — **minor, use helper method**
- 1 misleading metric (`reExportsCircular` counter) — **minor, remove or implement**
- Test setup duplication — **minor, refactor with beforeEach**
- Missing edge case tests — **minor, 1-2 new tests**

None of these prevent merging. They're improvements, not blockers.

---

## Verdict: **APPROVE**

The code is ready. If time permits, apply the export key helper and remove the unused counter before merging to keep the codebase clean.

### Recommended Follow-up (Future PR)
- Extract `buildExportKey()` helper to eliminate duplication
- Remove or fully implement `reExportsCircular` counter
- Add test for `export { foo as bar }` pattern
- Consider refactoring test setup/teardown

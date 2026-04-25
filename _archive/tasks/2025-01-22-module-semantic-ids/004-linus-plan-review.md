# Linus Torvalds - High-Level Review of REG-126 Implementation Plan

## Verdict: APPROVED WITH CRITICAL CONCERNS

The plan is fundamentally correct but INCOMPLETE. They missed critical places where MODULE IDs are constructed.

---

## What They Got RIGHT

1. **Pattern Alignment** - Following established `createWithContext()` pattern
2. **Semantic ID Format** - `{file}->global->MODULE->module` is correct
3. **Infrastructure Exists** - `computeSemanticId()` already works
4. **contentHash Separation** - Keeping it as attribute, not in ID

---

## What They MISSED (Critical)

### CRITICAL MISS #1: ExpressAnalyzer Hard-Coded ID Construction

**File:** `packages/core/src/plugins/analysis/ExpressAnalyzer.ts:381`

```typescript
const targetModuleId = `${targetModulePath}:MODULE:${targetModulePath}:0`;
```

Using LEGACY colon format. If MODULE IDs change but ExpressAnalyzer still uses old format, MOUNTS edges won't connect.

### CRITICAL MISS #2: Five Different ID Formats Currently in Use

1. **ModuleNode.ts:42** - `MODULE:${contentHash}`
2. **JSModuleIndexer.ts** - `MODULE:${fileHash}`
3. **IncrementalModuleIndexer.ts** - `${file}:MODULE:${file}:0`
4. **ExpressAnalyzer.ts** - `${targetModulePath}:MODULE:${targetModulePath}:0`
5. **VersionManager.ts** - `MODULE:${file}`

**FIVE different formats.** Not three.

### CRITICAL MISS #3: VersionManager Uses Absolute Path

VersionManager receives `node.file` (absolute path), not relative path. Semantic IDs MUST use relative paths for portability.

**Fix:** Use `node.name` which stores relative path for MODULE nodes.

---

## Missing Tests

1. **Edge Reference Consistency** - Verify DEPENDS_ON edges connect correctly
2. **Cross-Indexer Consistency** - JSModuleIndexer and IncrementalModuleIndexer produce same IDs
3. **ExpressAnalyzer Edge Creation** - MOUNTS edges connect to correct MODULE nodes

---

## Required Changes to Plan

### MUST ADD:

1. **ExpressAnalyzer.ts** to file modification list
2. **Relative path handling** in VersionManager (use `node.name`)
3. **Edge consistency tests**
4. **Breaking change warning**

---

## Final Verdict

**APPROVED** - Core approach is correct.

**BLOCKED UNTIL:**
1. ExpressAnalyzer.ts added to scope
2. VersionManager path handling clarified
3. Edge consistency tests added

**Rob:** When you implement, grep for EVERY place `MODULE:` appears. Don't trust the plan - verify.

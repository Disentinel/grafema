# Uncle Bob Review: REG-350 CLI Progress Visibility

## Files Under Review

- **packages/cli/src/commands/analyze.ts**
  - Lines 215: `log` function assignment
  - Lines 279-293: Orchestrator instantiation with `onProgress` callback
  - Lines 301-305: Timing/summary display

---

## Current State Analysis

### 1. Log Function Assignment (Line 215)
```typescript
const log = options.quiet ? () => {} : console.log;
```

**Assessment:** Clean, idiomatic ternary. No issues. This will remain unchanged.

### 2. Orchestrator Instantiation (Lines 279-293)

```typescript
const orchestrator = new Orchestrator({
  graph: backend as unknown as import('@grafema/types').GraphBackend,
  plugins,
  serviceFilter: options.service || null,
  entrypoint: options.entrypoint,
  forceAnalysis: options.clear || false,
  logger,
  services: config.services.length > 0 ? config.services : undefined,
  strictMode,
  onProgress: (progress) => {
    if (options.verbose) {
      log(`[${progress.phase}] ${progress.message}`);
    }
  },
});
```

**Current Assessment:**
- **Callback length:** 3 lines (trivial, no extraction needed)
- **Parameter count:** 9 parameters (reasonable, no Parameter Object needed)
- **Nesting depth:** 1 level (clean)
- **Problem identified:** The callback logic will be REPLACED by `renderer.update(progress)`, not extended

### 3. Summary Display Area (Lines 301-305)

```typescript
const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
const stats = await backend.getStats();

log('');
log(`Analysis complete in ${elapsed}s`);
log(`  Nodes: ${stats.nodeCount}`);
log(`  Edges: ${stats.edgeCount}`);
```

**Current Assessment:**
- Straightforward, no refactoring needed
- Will add one line: `log(renderer.finish(parseFloat(elapsed)))`

---

## Refactoring Opportunity Analysis

### Option 1: Extract Orchestrator Configuration
**Current approach (9 params inline):**
```typescript
const orchestrator = new Orchestrator({
  graph: backend as unknown as import('@grafema/types').GraphBackend,
  plugins,
  serviceFilter: options.service || null,
  entrypoint: options.entrypoint,
  forceAnalysis: options.clear || false,
  logger,
  services: config.services.length > 0 ? config.services : undefined,
  strictMode,
  onProgress: (progress) => renderer.update(progress),
});
```

**Proposed extraction:**
```typescript
const orchestratorConfig = createOrchestratorConfig({
  backend,
  plugins,
  options,
  config,
  logger,
  renderer,
});
const orchestrator = new Orchestrator(orchestratorConfig);
```

**Analysis:**
- **Benefit:** Reduces line count in `action` handler from ~95 to ~85 lines
- **Risk:** Creates intermediate function in same module (1-2 uses total)
- **Cost/Benefit:** Marginal win for local scope
- **Recommendation:** **SKIP** — The Orchestrator construction is clear as-is. Parameter Object pattern is best when:
  1. Same object passed to multiple functions (here: just 1)
  2. More than 5-6 params with semantic relationships (here: 9 params, but each is distinct)

  Extracting would add a helper we use once. Not worth it.

### Option 2: Extract Final Summary Display
**Current code (lines 301-307):**
```typescript
const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
const stats = await backend.getStats();

log('');
log(`Analysis complete in ${elapsed}s`);
log(`  Nodes: ${stats.nodeCount}`);
log(`  Edges: ${stats.edgeCount}`);
```

**Proposed extraction:**
```typescript
const printAnalysisSummary = (startTime: number, backend: RFDBServerBackend, log: (msg: string) => void, renderer: ProgressRenderer) => {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  const stats = await backend.getStats();

  log('');
  log(renderer.finish(parseFloat(elapsed)));
  log(`  Nodes: ${stats.nodeCount}`);
  log(`  Edges: ${stats.edgeCount}`);
};
```

**Analysis:**
- **Current scope:** 5 lines
- **Extracted scope:** 7 lines + 1 line call site
- **Benefit:** None — local scope is clear, only appears once
- **Risk:** Adds indirection for trivial operation
- **Recommendation:** **SKIP** — Keep it inline. The code is self-documenting at 5 lines.

---

## Code Quality Issues Found

### Issue 1: Mixed Concerns in Action Handler
**Location:** Lines 206-373 (168 lines in single `action` handler)

**Assessment:** This is a KNOWN limitation of this module, not specific to our changes. The entire `action` callback is large but handles coherent flow: setup → load config → create plugins → instantiate orchestrator → run → report results → cleanup.

**Should we refactor before touching this?**
- No. Our changes are surgical (replacing 3-line callback with 1-line callback call)
- Refactoring the entire handler is outside PREPARE phase scope
- Risk of unrelated changes breaking tests

**Verdict:** **SKIP** — Out of scope for REG-350.

---

## Integration Points Review

### Where ProgressRenderer will be instantiated (new line ~277):
```typescript
const renderer = new ProgressRenderer({ isInteractive: !options.quiet });
```

**Assessment:** Clean. Constructor option is clear.

### Where callback will change (line 288-292):
**OLD:**
```typescript
onProgress: (progress) => {
  if (options.verbose) {
    log(`[${progress.phase}] ${progress.message}`);
  }
},
```

**NEW:**
```typescript
onProgress: (progress) => renderer.update(progress),
```

**Assessment:** ✓ Simpler, clearer intent. No logic to extract further.

---

## Final Recommendation

## **RECOMMENDATION: SKIP REFACTORING**

### Rationale:
1. **No refactoring candidates:** Callback is being replaced (not extended), summary display is 5 lines
2. **Parameter Object not justified:** Only 1 use of Orchestrator config in this file
3. **Methods we'll modify are already clean:**
   - Line 215: Idiomatic ternary, no change
   - Line 288-292: 3-line callback → 1-line callback call (improvement, no extraction needed)
   - Lines 301-305: 5-line summary display, self-documenting

4. **Risk assessment:** The code being modified is already at appropriate complexity level
5. **Safe to proceed:** Changes are substitution-based, not structural

### Why we avoid premature refactoring:
- Parameter Object would add a function used once
- Extracting summary display would add indirection to 5 lines
- The handler length (168 lines) is separate concern for another task
- Our modification **improves** clarity by delegating progress to ProgressRenderer

---

## Change Impact Summary

**Lines affected by REG-350 implementation:**
- **~277 (NEW):** Add `const renderer = new ProgressRenderer(...)`
- **~288-292:** Simplify callback from 3 lines to 1 line
- **~305 (MODIFIED):** Add `log(renderer.finish(...))` call
- **~2 (IMPORT):** Add `ProgressRenderer` import

**Total: 4 line modifications, 2 additions. Clean, surgical changes.**

---

## Sign-Off

**Current code quality:** ✓ Good
**Proposed changes quality:** ✓ Improves clarity
**Refactoring needed before implementation:** ✗ No
**Safe to proceed:** ✓ Yes

No pre-implementation refactoring required. Code is ready for implementation.

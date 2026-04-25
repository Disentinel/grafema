# Auto-Review: REG-259 Plan v2 — Coverage Tracking Architecture

**Date:** 2026-02-15
**Reviewer:** Combined Auto-Review (Sonnet)
**Plan Version:** v2 (revised)

## Verdict: **REJECT**

While the coverage tracking architecture is well-designed and follows Grafema patterns, there are **critical signal-to-noise ratio problems** that will make the feature unusable in practice.

---

## Part 1 — Vision & Architecture

### Alignment with Project Vision ✓

**Does coverage tracking align with "AI should query the graph, not read code"?**

YES. Coverage reporting as ISSUE nodes is exactly right:
- AI can query `issue:coverage` nodes to understand analysis gaps
- MCP commands can surface coverage warnings without reading code
- Graph becomes self-documenting about its own limitations

**Does using ISSUE nodes for coverage gaps fit Grafema's architecture?**

YES. Perfect fit:
- ISSUE nodes are the standard pattern for reporting analysis gaps (see `UnconnectedRouteValidator`)
- VALIDATION phase is the right place for coverage checking
- `context.reportIssue()` API is proven and works well

### MANDATORY Complexity Check ✓

**Iteration space analysis:**

From plan (lines 848-859):
```
1. Collect coverage: O(p) where p = loaded plugins (10-20)
2. Collect imports: O(i) where i = IMPORT nodes (100-500)
3. Compare: O(m) where m = unique package names (10-50)
4. Create issues: O(u) where u = uncovered packages (0-10)
Total: O(p + i + m + u) — linear in all inputs ✓
```

**Assessment:** ACCEPTABLE. Not a brute-force scan.
- Query-based (queries IMPORT nodes, not all nodes)
- Forward registration (plugins declare `covers`, validator reads)
- Extending existing pattern (VALIDATION plugin + ISSUE nodes)
- No new iteration overhead

**Grafema doesn't brute-force.** ✓

### ResourceRegistry Approach

**From plan (lines 403-431):**

Three options for passing loaded plugins to validator:
- **Option A:** ResourceRegistry (recommended)
- **Option B:** PluginContext.config
- **Option C:** Static registry (rejected — global state)

**Assessment of Option A (ResourceRegistry):** ✓

Evidence from Orchestrator.ts (line 167):
```typescript
private resourceRegistry = new ResourceRegistryImpl();
```

Evidence from PhaseRunner.ts (lines 109-120):
```typescript
const pluginContext: PluginContext = {
  ...baseContext,
  resources: resourceRegistry,
};
```

ResourceRegistry is already wired through the entire pipeline. Using it for `loadedPlugins` is architecturally correct.

---

## Part 2 — Practical Quality: **CRITICAL ISSUES**

### Issue 1: Node.js Built-ins Will Spam Warnings ❌

**The problem:**

Every Node.js project imports built-in modules:
```typescript
import fs from 'fs';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
```

These are external imports (no `.` prefix), so:
1. JSASTAnalyzer creates IMPORT nodes with `source: 'fs'`, `source: 'http'`, etc.
2. PackageCoverageValidator sees them as external packages
3. No analyzer declares `covers: ['fs', 'http', 'path', ...]`
4. **ISSUE created for every built-in module in every file**

**Impact:** A typical Express app imports 10-15 built-in modules. With 50 files:
- 500-750 false-positive coverage warnings
- Signal-to-noise ratio destroyed
- Users will ignore or disable the validator

**From plan:**

Don mentions scoped packages (`@tanstack/react-query`) and package extraction (lines 369-384), but **does not address built-ins at all**.

### Issue 2: Utility Packages Will Spam Warnings ❌

**The problem:**

Most projects import utility libraries that don't need semantic analysis:
```typescript
import _ from 'lodash';
import dayjs from 'dayjs';
import { v4 as uuid } from 'uuid';
import clsx from 'clsx';
import chalk from 'chalk';
```

These are semantic no-ops:
- Lodash: pure utility functions (no database, no HTTP, no framework logic)
- dayjs: date manipulation
- uuid: identifier generation
- chalk: terminal colors

**None of these need analyzers**, but validator will warn about all of them.

**Impact:** Typical project has 20-50 utility packages. Every one triggers coverage warning.

**What SHOULD be covered:**
- Database packages: `sqlite3`, `@prisma/client`, `pg`, `mysql2`
- Framework packages: `express`, `@tanstack/react-query`, `next`
- External service clients: `aws-sdk`, `@google-cloud/*`

**What should NOT be covered:**
- Node.js built-ins (`fs`, `http`, `path`)
- Pure utility libraries (`lodash`, `dayjs`, `uuid`)
- Dev-only packages (`eslint`, `prettier`, `typescript`)

### Issue 3: Signal-to-Noise Ratio Catastrophe ❌

**Real-world scenario:**

Typical Express + React monorepo:
- **20 utility packages** (lodash, dayjs, uuid, chalk, clsx, etc.)
- **15 Node.js built-ins** (fs, path, http, crypto, etc.)
- **50+ dev dependencies** (eslint, prettier, webpack, etc.)
- **2-3 packages that need analyzers** (sqlite3, express, react-query)

**Without filtering:**
- 85+ warnings per project
- 2-3 real gaps buried in noise
- Users will **immediately disable the validator**

**Quote from plan (lines 346-357):**
```typescript
if (uncoveredPackages.size > 0) {
  logger.warn('Uncovered packages detected', {
    count: uncoveredPackages.size,
    packages: Array.from(uncoveredPackages.keys())
  });
  logger.warn(
    `${uncoveredPackages.size} external packages used but not covered by semantic analysis. ` +
    `Results may be incomplete.`
  );
}
```

If `uncoveredPackages.size = 85`, this warning is **useless**.

### Issue 4: No Filtering Strategy Proposed ❌

**What the plan provides:**

Plan correctly identifies package name extraction (lines 366-384):
```typescript
private extractPackageName(source: string): string | null {
  if (!source) return null;

  // Scoped package: @scope/package or @scope/package/subpath
  if (source.startsWith('@')) {
    const parts = source.split('/');
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return null;
  }

  // Unscoped package: package or package/subpath
  const parts = source.split('/');
  return parts[0];
}
```

**What the plan DOES NOT provide:**

- Built-in module detection
- Utility vs semantic package classification
- Filtering mechanism for noise reduction

**What's needed:**

```typescript
// REQUIRED: Built-in module whitelist
const NODE_BUILTINS = new Set([
  'fs', 'path', 'http', 'https', 'crypto', 'stream', 'events',
  'util', 'os', 'child_process', 'cluster', 'net', 'dns',
  // ... full list of Node.js core modules
]);

// REQUIRED: Heuristic for utility packages
function isLikelyUtilityPackage(packageName: string): boolean {
  // Common utility prefixes
  if (packageName.startsWith('lodash')) return true;
  if (packageName.startsWith('@types/')) return true; // TypeScript definitions

  // Known utilities
  const UTILITIES = new Set(['dayjs', 'uuid', 'clsx', 'chalk', 'debug', 'ms', ...]);
  return UTILITIES.has(packageName);
}

// Filtering in validator
for (const [pkg, files] of importedPackages.entries()) {
  // SKIP built-ins
  if (NODE_BUILTINS.has(pkg)) continue;

  // SKIP known utilities (with opt-out via config)
  if (isLikelyUtilityPackage(pkg) && !config.warnUtilityPackages) continue;

  // Only warn about packages that SHOULD have analyzers
  if (!coveredPackages.has(pkg)) {
    uncoveredPackages.set(pkg, files);
  }
}
```

**Without this filtering, the feature is DOA.**

---

## Part 3 — Code Quality

### `covers` Field Design ✓

From types validation (PluginMetadata interface, lines 187-203):

```typescript
export interface PluginMetadata {
  name: string;
  phase: PluginPhase;
  creates?: { nodes?: NodeType[]; edges?: EdgeType[] };
  dependencies?: string[];
  fields?: FieldDeclaration[];
  consumes?: EdgeType[];
  produces?: EdgeType[];

  // NEW: Package coverage declaration
  covers?: string[];  // npm package names this analyzer handles
}
```

**Assessment:** Clean design.
- Optional field (doesn't break existing plugins)
- String array (simple, no over-engineering)
- Clear semantic: "this plugin covers these packages"
- Migration path for multi-language support (v0.5+) acknowledged

**Example usage (lines 208-220):**
```typescript
export class SQLiteAnalyzer extends Plugin {
  get metadata(): PluginMetadata {
    return {
      name: 'SQLiteAnalyzer',
      phase: 'ANALYSIS',
      creates: { nodes: ['db:query'], edges: ['EXECUTES_QUERY'] },
      dependencies: ['JSModuleIndexer', 'JSASTAnalyzer'],
      covers: ['sqlite3', 'better-sqlite3']  // NEW
    };
  }
}
```

Perfect. ✓

### ResourceRegistry Approach: Justified or Over-Engineering?

**Plan's recommendation (lines 403-431):** Use ResourceRegistry.

**Current evidence:**

From Orchestrator.ts (lines 257-280):
```typescript
private async registerPluginNodes(): Promise<void> {
  const pluginNodes: Array<{ id: string; name: string; dependencies: string[] }> = [];

  for (const plugin of this.plugins) {
    const meta = plugin.metadata;
    if (!meta?.name) continue;
    // ... creates grafema:plugin nodes
  }
}
```

Orchestrator already has `this.plugins` list. Why not pass it directly?

**Alternative approach (simpler):**

```typescript
// In Orchestrator, before VALIDATION phase:
const coveredPackages = new Set<string>();
for (const plugin of this.plugins) {
  const covers = plugin.metadata.covers ?? [];
  for (const pkg of covers) {
    coveredPackages.add(pkg);
  }
}

// Store in ResourceRegistry as Set<string>, not Plugin[]
await this.resourceRegistry.set('coveredPackages', coveredPackages);

// Validator reads Set<string>, not Plugin[]
const coveredPackages = await context.resources.get<Set<string>>('coveredPackages') ?? new Set();
```

**Assessment:** ResourceRegistry is NOT over-engineering here, but storing `Set<string>` is better than `Plugin[]`.
- Validator only needs package names, not full Plugin objects
- Smaller footprint in resource registry
- Clearer contract (validator doesn't need to inspect plugin metadata)

**Recommendation:** Use ResourceRegistry, but store `Set<string>` not `Plugin[]`.

---

## Specific Recommendations

### MUST FIX before approval:

1. **Built-in module filtering (CRITICAL)**
   - Add `NODE_BUILTINS` constant with all Node.js core modules
   - Skip built-ins when checking coverage
   - **Without this, feature is unusable**

2. **Utility package filtering (HIGH PRIORITY)**
   - Either:
     - **Option A:** Maintain curated list of known utilities (lodash, dayjs, etc.)
     - **Option B:** Add config option `warnUtilityPackages: false` (default false)
     - **Option C:** Only warn about packages matching semantic patterns (database, framework, HTTP client)
   - **Recommended:** Option A + Option B (curated list + opt-in for utilities)

3. **Signal-to-noise optimization (HIGH PRIORITY)**
   - Target: <10 warnings per typical project
   - Only warn about packages that SHOULD have analyzers
   - Group warnings by category (e.g., "3 database packages, 1 HTTP client, 2 frameworks")

4. **ResourceRegistry optimization (NICE TO HAVE)**
   - Store `Set<string>` not `Plugin[]`
   - Validator extracts package names directly from set

### Edge Cases from Plan Review

**Q1: Package imported but not used?** (lines 556-574)

Plan says: Track IMPORT nodes (catches unused imports).

**Assessment:** Reasonable. Unused imports are potential dead code, worth flagging.

**Q2: Dynamic require?** (lines 576-591)

Plan says: Won't be detected (acceptable gap).

**Assessment:** Correct. Static analysis limitation, acceptable trade-off.

**Q3: Ecosystem collisions?** (lines 593-634)

Plan says: Defer to v0.5+ multi-language support.

**Assessment:** Correct. No collision risk for JavaScript-only Grafema v0.2.

**Q4: Should `covers` be required?** (lines 636-656)

Plan says: No. Only package-specific analyzers declare `covers`.

**Assessment:** Correct. ExpressRouteAnalyzer doesn't need `covers`, only SQLiteAnalyzer does.

**Q5: Analyzer configured but package not imported?** (lines 658-675)

Plan says: No issue created (correct behavior).

**Assessment:** Correct. No false positives for over-configuration.

---

## Summary

### What's Right ✓

1. **Architecture:** ISSUE nodes + VALIDATION phase is perfect fit
2. **Complexity:** O(p + i + m) is acceptable, not brute-force
3. **Plugin pattern:** Extends existing patterns correctly
4. **`covers` field:** Clean, simple, extensible design
5. **ResourceRegistry:** Justified (but optimize to `Set<string>`)

### What's Wrong ❌

1. **Node.js built-ins:** Will spam 15+ warnings per project
2. **Utility packages:** Will spam 20-50 warnings per project
3. **Signal-to-noise ratio:** 85+ warnings vs 2-3 real gaps = unusable
4. **No filtering strategy:** Plan doesn't address noise problem at all

### Root Cause

**The plan treats all external imports as equal**, but they're not:
- **Semantic packages** (databases, frameworks) SHOULD be covered
- **Utility packages** (lodash, dayjs) DON'T NEED coverage
- **Built-in modules** (fs, http) CAN'T be covered

**Without distinguishing these, the validator becomes spam.**

---

## Action Required

**REJECT** this plan version.

**Required changes for approval:**

1. Add **Built-in Module Filtering**
   - Maintain `NODE_BUILTINS` constant (all Node.js core modules)
   - Skip built-ins when comparing imported vs covered packages
   - Test: `import fs from 'fs'` should NOT create coverage issue

2. Add **Utility Package Filtering**
   - Add `KNOWN_UTILITIES` constant (lodash, dayjs, uuid, chalk, etc.)
   - Add config option `warnAboutUtilities: boolean` (default: false)
   - Skip utilities unless `warnAboutUtilities: true`
   - Test: `import _ from 'lodash'` should NOT create coverage issue (by default)

3. Update **Implementation Plan Phase 2** (lines 705-720)
   - Add filtering logic to validator algorithm (STEP 3.5)
   - Update tests to verify built-ins and utilities are skipped

4. Update **CLI Warning Integration** (lines 741-771)
   - Only show warnings for packages that SHOULD have analyzers
   - Group by category if showing details

5. Add **Documentation Section** (new)
   - Explain what packages trigger warnings
   - Explain built-in and utility filtering
   - Show how to opt-in to utility warnings via config

**Estimated scope increase:** +50-80 LOC (built-in list + utility list + filtering logic + tests)

**Risk:** Still LOW-MEDIUM. Filtering is straightforward, just needs comprehensive testing.

---

## Complexity & Architecture (Final Check)

**Does the plan (with required fixes) meet Grafema standards?**

- ✓ Uses existing abstractions (ISSUE nodes, VALIDATION phase, ResourceRegistry)
- ✓ No brute-force iteration (queries IMPORT nodes)
- ✓ Forward registration (plugins declare `covers`)
- ✓ Extensible (new analyzer = add `covers` to metadata)
- ❌ **Needs filtering** to maintain high signal-to-noise ratio

**After fixes:** YES, will meet Grafema standards.

**Before fixes:** NO, will spam users and be disabled immediately.

---

## Conclusion

Don's architectural design is excellent. The use of ISSUE nodes, VALIDATION phase, and ResourceRegistry is exactly right. The `covers` field is clean and extensible.

**But the plan is incomplete.** It doesn't address the signal-to-noise problem that will make the feature unusable in practice.

**Add built-in and utility filtering, then re-submit.**

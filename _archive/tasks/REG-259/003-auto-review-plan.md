# Auto-Review: REG-259 Plan

**Date:** 2026-02-15
**Reviewer:** Combined Auto-Review (Sonnet)

## Verdict: REJECT

## Summary

Don's plan is architecturally sound and well-researched, but has **scope creep** that conflates two distinct tasks:

1. **Architecture definition** (what REG-259 is supposed to be)
2. **Implementation work** (renaming SQLiteAnalyzer, updating config)

The plan also has one **naming collision risk** that needs addressing.

---

## Vision & Architecture: OK with Concerns

### ✅ Strengths

1. **Aligns with existing patterns** — Flat naming matches framework analyzers (ExpressAnalyzer, NestJSAnalyzer)
2. **Reuses existing infrastructure** — No new base classes, uses existing Plugin contract
3. **Well-researched** — WebSearch found prior art (ESLint plugins), validated approach
4. **Complexity: O(m × n)** where m=modules, n=AST nodes — same as existing analyzers ✓
5. **Plugin architecture:** Forward registration (MODULE nodes from JSModuleIndexer), not backward scanning ✓
6. **Extensibility:** Adding new package = new analyzer file + register in builtinPlugins ✓

### ⚠️ Concerns

#### 1. Naming Collision Risk (CRITICAL)

**The Plan Says:**
> Flat naming, no prefix. `Sqlite3Analyzer`, not `NpmSqlite3Analyzer`.

**Problem:**
What happens when two ecosystems have packages with the same name?

**Real-world example:**
- `npm/sqlite3` (Node.js)
- `pypi/sqlite3` (Python built-in)

Both would become `Sqlite3Analyzer` → **collision** in `BUILTIN_PLUGINS` registry.

**Solution:**
Flat naming works ONLY if we ensure uniqueness. Two options:

**Option A: Registry prefix (npm-, maven-, pypi-)**
```typescript
// Built-in plugins registry
Sqlite3Analyzer: () => new Sqlite3Analyzer()  // Assumes npm ecosystem by default
PySqlite3Analyzer: () => new PySqlite3Analyzer()  // Python sqlite3
JDBCAnalyzer: () => new JDBCAnalyzer()  // Maven (no collision, unique name)
```

**Option B: Ecosystem suffix (Sqlite3NpmAnalyzer, Sqlite3PyAnalyzer)**
```typescript
Sqlite3NpmAnalyzer: () => new Sqlite3NpmAnalyzer()
Sqlite3PyAnalyzer: () => new Sqlite3PyAnalyzer()
```

**Recommendation:** Option A (registry prefix) for ecosystem, class name stays clean:
- Class: `Sqlite3Analyzer` (npm ecosystem implied)
- Class: `PySqlite3Analyzer` (Python ecosystem explicit)
- Registry: both coexist
- Config: users write `Sqlite3Analyzer` (npm) or `PySqlite3Analyzer` (Python)

**Counter-argument to "package name is self-documenting":**
`sqlite3` is NOT self-documenting. It exists in both npm and Python. JDBC is self-documenting (only Maven). Postgres/Prisma are npm-only (today, but what about future?).

**Decision needed:** How do we avoid collisions when same package exists in multiple ecosystems?

---

#### 2. Adding `deprecated` to PluginMetadata — Is it worth it?

**The Plan Says:**
```typescript
interface PluginMetadata {
  deprecated?: boolean;
  deprecationMessage?: string;
}
```

**Concern:**
This is a type change for a **single usage** (DatabaseAnalyzer deprecation).

**Simpler alternative:**
Just log the warning in `execute()` and document in README. No type change needed.

```typescript
async execute(context: PluginContext): Promise<PluginResult> {
  context.logger?.warn('DatabaseAnalyzer is deprecated. Use Sqlite3Analyzer, PrismaAnalyzer, etc.');
  // ... rest
}
```

**Trade-off:**
- **Type change:** More structured, machine-readable, can be used by orchestrator for warnings
- **No type change:** Simpler, works today, achieves same user-facing result

**Recommendation:** If deprecation fields will be used by orchestrator/CLI to **show warnings during plugin loading**, then it's worth adding. If it's just for docs/logging → skip the type change, use comments + runtime warning.

**Decision needed:** Will orchestrator check `metadata.deprecated` and warn during plugin loading? Or is this just for documentation?

---

## Practical Quality: REJECT (Scope Creep)

### Problem: REG-259 vs REG-260 Boundary Confusion

**REG-259 (this task):** "Establish architecture for package-specific analyzer plugins"
**REG-260 (blocked):** "Create npm/sqlite3 analyzer plugin"

**What REG-259 SHOULD include:**
- ✅ Design decisions (naming convention, config syntax, no auto-detection)
- ✅ Document pattern for future analyzers
- ✅ Architecture validation (complexity, extensibility)
- ✅ Decide on deprecation strategy for DatabaseAnalyzer

**What REG-259 should NOT include (belongs in REG-260):**
- ❌ Renaming SQLiteAnalyzer → Sqlite3Analyzer
- ❌ Adding `metadata.package` field to nodes
- ❌ Updating DEFAULT_CONFIG
- ❌ Updating builtinPlugins.ts
- ❌ Updating tests

**The plan mixes both.** Section "Implementation Plan" (lines 342-404) is implementation work, not architecture.

**Why this matters:**
1. **REG-259 = decision document**, deliverable is `002-don-plan.md` (approved design)
2. **REG-260 = implementation**, deliverable is code changes
3. Mixing them creates ambiguity: "Is this task done when plan is approved, or when code is merged?"

**Correct scope for REG-259:**
- Document architecture decisions
- Get approval from user
- **Output:** Approved design doc → unblocks REG-260
- **No code changes in REG-259**

**REG-260 then implements:**
- Rename SQLiteAnalyzer → Sqlite3Analyzer
- Add `metadata.package: 'sqlite3'` to created nodes
- Update DEFAULT_CONFIG, builtinPlugins, tests
- **Output:** Working Sqlite3Analyzer as reference implementation

---

## Code Quality: N/A

No code to review (REG-259 is planning task).

---

## Required Changes

### 1. Resolve Naming Collision Strategy (CRITICAL)

**Question:** How do we handle packages with same name across ecosystems (sqlite3 in npm vs PyPI)?

**Options:**
- A) Registry prefix: `Sqlite3Analyzer` (npm), `PySqlite3Analyzer` (Python)
- B) Ecosystem suffix: `Sqlite3NpmAnalyzer`, `Sqlite3PyAnalyzer`
- C) Directory-based namespacing (rejected in plan, but solves collision)

**Requirement:** Plan must define CLEAR naming convention that prevents collisions.

---

### 2. Clarify `deprecated` Field Purpose

**Question:** Will orchestrator/CLI check `metadata.deprecated` during plugin loading and show warnings?

**If YES:** Add fields to PluginMetadata, implement orchestrator check
**If NO:** Skip type change, use runtime warning in `execute()` only

**Requirement:** Don must clarify if deprecation is structural (type change) or just docs/logging.

---

### 3. Reduce Scope to Architecture Only

**Remove from REG-259 plan:**
- Implementation Plan section (lines 342-404) — move to REG-260
- "Files to Create/Modify" list — move to REG-260
- "Scope Estimate" for code changes — move to REG-260

**Keep in REG-259 plan:**
- Design decisions (naming, config, auto-detection, deprecation strategy)
- Prior art search results
- Architecture validation (complexity, extensibility)
- Answers to design questions

**Deliverable for REG-259:** Approved design doc that answers all architectural questions
**Deliverable for REG-260:** Working code that implements the design

---

## Positive Notes

1. **Excellent research** — WebSearch for prior art (ESLint, SonarQube) grounds the design
2. **Clear rationale** — Every decision has "why" explained
3. **Complexity analysis** — O(m × n) validated, not brute-force ✓
4. **Extensibility** — Adding new package = one file + one registry entry ✓
5. **Backward compatibility** — DatabaseAnalyzer kept as deprecated fallback (graceful migration)

The plan is 90% correct. Just needs:
- Naming collision strategy finalized
- Deprecation field decision
- Scope reduced to architecture-only (no implementation work in REG-259)

---

## Recommendation

**REJECT** — Fix scope creep and resolve naming collision strategy, then re-submit for approval.

**Next iteration should:**
1. Define naming convention that handles collisions (sqlite3 in npm vs PyPI)
2. Decide if `deprecated` field is structural or just docs
3. Remove implementation details (those belong in REG-260)
4. Focus on: "What are the rules for package-specific analyzers?" not "How do we implement Sqlite3Analyzer?"

Once these are fixed, architecture is solid and can be approved.

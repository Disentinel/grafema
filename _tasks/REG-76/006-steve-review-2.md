# Steve Jobs Review #2: REG-76 Multi-Repo Workspace (Revision)

**Date:** 2026-02-06  
**Reviewer:** Steve Jobs (High-level Review)  
**Status:** 🟢 **APPROVE** (with notes)

---

## Executive Summary

Don's revision addresses the fundamental architectural concerns from my previous rejection. The **Storage Key Prefix** (Option C) is the right solution.

**Core insight:** Semantic IDs are for meaning. Storage keys are for RFDB. Separating these concerns solves the collision problem without breaking ID stability.

The plan now aligns with Grafema's architecture and avoids the O(R²) complexity trap.

---

## Critical Issues - Resolution Status

### ✅ ISSUE 1: Node ID Pollution - RESOLVED

**Don's solution:**
```typescript
interface NodeRecord {
  id: string;           // Semantic ID (unchanged)
  storageKey: string;   // Repo-prefixed for RFDB
  repo?: string;        // Attribute for queries
}
```

**Why this WORKS:**

1. **Semantic ID stays stable** — `src/utils.js->global->FUNCTION->formatDate` doesn't change
2. **Storage collision prevented** — `backend|src/utils.js->...` vs `frontend|src/utils.js->...`
3. **No "default" hack** — Single-repo doesn't need prefix at all
4. **Backward compatible** — Existing graphs keep working

This is the right abstraction. Semantic identity vs storage identity.

**APPROVED.**

---

### ✅ ISSUE 2: O(R²) Complexity - RESOLVED

**Don's solution:** Extend `ImportExportLinker`, don't create `CrossRepoLinker`.

```typescript
// O(i + e) — same as single-repo
for (const imp of imports) {
  if (isWorkspacePackage(imp.source)) {
    // O(1) lookup in packageToRepo map
    const providerRepo = packageToRepo.get(imp.source);
  }
}
```

**Why this WORKS:**

1. **No new iteration pass** — reuses existing enrichment
2. **O(1) package lookup** — HashMap not scan
3. **Forward registration** — mark during INDEXING, resolve during ENRICHMENT

**Complexity:** O(i + e) — acceptable.

**APPROVED.**

---

### ✅ ISSUE 3: Package-to-Repo Mapping - ACCEPTABLE

**Vadim's constraint:** Grafema supports Go, Rust, C, not just JS. Can't rely on package.json.

**Don's solution:** Manual config for MVP, auto-discovery deferred to v0.3.

```yaml
workspace:
  repos:
    - path: ./backend
      packages: ["@company/backend-api"]  # Manual for now
```

**Why this is ACCEPTABLE (not ideal, but correct):**

1. **Language-agnostic** — works for JS, Go, Rust equally
2. **Minimal config** — just path + optional packages
3. **Clear path forward** — v0.3 can add auto-discovery per language
4. **User control** — explicit better than wrong inference

This is NOT elegant, but it's CORRECT for multi-language support. The alternative (infer from package.json) only works for JS.

**APPROVED for MVP.**

---

### ✅ ISSUE 4: Workspace Config Schema - FIXED

**Don's revised schema:**
```yaml
workspace:
  repos:
    - path: ./backend
    - path: ./frontend
      packages: ["@company/frontend-lib"]
```

**What's gone:**
- ❌ `name` field (derive from path)
- ❌ `config` overrides (no deep merge complexity)
- ❌ Git URLs (deferred to v0.3)

**Validation:**
1. Path must exist
2. Repo names from basename
3. Duplicate names = error
4. Duplicate packages = error

This is **minimal**. Good.

**APPROVED.**

---

### ✅ ISSUE 5: CrossRepoLinker Plugin - ELIMINATED

Don explicitly states: **"DO NOT create CrossRepoLinker."**

Instead: Extend `ImportExportLinker` with cross-repo logic.

This reuses existing iteration, avoids duplication, matches Grafema's "extend don't build" principle.

**APPROVED.**

---

### ✅ ISSUE 6: CLI Flag Design - IMPROVED

Plan no longer proposes `--workspace` flag. Auto-detection from config.

If `.grafema/config.yaml` contains `workspace.repos[]` → workspace mode.

Simple, no extra flags.

**APPROVED.**

---

### ✅ ISSUE 7: MVP Limitations - ALIGNED WITH VADIM

**Vadim's clarification:**
- Git URLs = nice-to-have, not blocker
- User has CVS, not git
- Local paths = primary use case

With this context, "local paths only for v0.2" is acceptable.

**APPROVED for MVP.**

---

## Complexity Check

| Operation | Single Repo | Multi-Repo (R repos) |
|-----------|-------------|---------------------|
| INDEXING | O(n) | O(R*n) |
| ENRICHMENT | O(i + e) | O(R*i + R*e) |
| Cross-repo linking | N/A | O(c) — c = cross-repo imports only |

**Linear in number of repos.** No R² blowup.

✅ **PASSES Complexity Checklist**

---

## Architecture Alignment

### Reuse Before Build ✅

| Need | Don't Build | Instead |
|------|-------------|---------|
| Cross-repo linking | CrossRepoLinker | Extend ImportExportLinker ✅ |
| Repo disambiguation | New node type | `repo` attribute ✅ |
| Storage collision | Compound keys in RFDB | Storage key prefix ✅ |

**FOLLOWS Grafema patterns.**

---

## Robert Tarjan Consultation - Validated ✅

Don correctly applies **partitioned graph** pattern:
- Prefix vertices with partition ID (storageKey prefix)
- O(1) lookup by full key

Graph-theoretically sound.

---

## Vision Alignment

**"AI should query the graph, not read code."**

| Criterion | Assessment |
|-----------|------------|
| Unified cross-repo graph | ✅ YES |
| O(1) queries by repo | ✅ YES (`node_attr(Id, 'repo', X)`) |
| Stable semantic IDs | ✅ YES (unchanged) |
| No manual config burden | ⚠️ PARTIAL (packages[] manual, but justified) |

**ALIGNS with vision.**

---

## Remaining Concerns (Non-Blocking)

### 🟡 Package Discovery is Manual

For MVP, users must list packages:
```yaml
packages: ["@company/shared-lib"]
```

**Risk:** User forgets to update config when adding package.

**Mitigation:** Clear error messages when cross-repo import unresolved:
```
ERROR: Import '@company/new-package' not found in workspace.
Did you forget to add it to repos[].packages?
```

**Action:** Defer auto-discovery to v0.3 when language-specific analyzers mature.

**NON-BLOCKING for MVP.**

---

### 🟡 No Version Pinning

Same semantic ID in two repos at different versions:
```
Repo A: utils.js (v1.0) -> formatDate() returns string
Repo B: utils.js (v2.0) -> formatDate() returns Date object
```

Both have same semantic ID. Graph sees both, but can't distinguish versions.

**Risk:** Type inference confusion when repos use different versions.

**Mitigation:** v0.3 adds `version` attribute to nodes.

**NON-BLOCKING for MVP** (Vadim confirmed).

---

## Implementation Plan - Validated

| Phase | Days | Risk |
|-------|------|------|
| 1. Storage Key Separation | 1-2 | LOW |
| 2. Workspace Config | 1 | LOW |
| 3. Multi-Repo Orchestration | 1-2 | MEDIUM (plugin context changes) |
| 4. ImportExportLinker Extension | 1 | LOW |
| 5. Datalog + CLI | 1 | LOW |

**Total: 5-7 days**

Realistic. Phases are sequential and testable.

**APPROVED.**

---

## Critical Files - Verified

1. ✅ `SemanticId.ts` — Add storageKey generation
2. ✅ `RFDBServerBackend.ts` — Use storageKey for RFDB
3. ✅ `ImportExportLinker.ts` — Extend for cross-repo
4. ✅ `ConfigLoader.ts` — Add workspace schema
5. ✅ `id_gen.rs` — No changes needed (verify only)

These are the RIGHT files to touch. No scope creep.

---

## Questions Answered

From my previous review:

1. **Can RFDB store attributes separate from node IDs?**
   → YES. `repo` attribute stored separate from storageKey.

2. **What's the performance of node_attr() queries?**
   → O(1) with proper indexing (RFDB already supports this).

3. **Extend ImportExportLinker or separate?**
   → EXTEND. Don confirms.

4. **Should repos be first-class?**
   → NO. Storage-level concern, not semantic-level. Correct.

5. **Real user scenario?**
   → Vadim clarified: CVS, local paths, multiple codebases. This plan fits.

---

## Verdict

**🟢 APPROVE**

**Why:**
1. ✅ Semantic ID collision solved correctly (storageKey prefix)
2. ✅ O(R²) complexity eliminated (extend ImportExportLinker)
3. ✅ Minimal config (no overengineering)
4. ✅ No new plugins (reuse existing)
5. ✅ Aligns with Grafema architecture
6. ✅ Meets Vadim's constraints (language-agnostic, local paths)

**Remaining concerns are NON-BLOCKING:**
- Manual package config → deferred to v0.3
- No version pinning → deferred to v0.3

These are acceptable MVP limitations that don't defeat the feature's purpose.

---

## Next Steps

1. **Present to Vadim** — Escalate for final confirmation
2. If Vadim APPROVE → proceed to Joel for detailed tech plan
3. Joel must include:
   - Exact storageKey format (prefix syntax)
   - Migration path for existing single-repo graphs (if any)
   - Error messages for unresolved cross-repo imports

**NOTE:** This is a fundamental architecture decision. If Vadim has concerns, address them BEFORE Joel's detailed planning.

---

**Signature:** Steve Jobs  
**Role:** High-level Reviewer / Vision Gatekeeper  
**Action:** ESCALATE TO VADIM (user confirmation)

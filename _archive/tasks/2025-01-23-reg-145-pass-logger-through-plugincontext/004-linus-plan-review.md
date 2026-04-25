# Linus Torvalds' Plan Review - REG-145: Pass Logger through PluginContext

## Executive Summary

**The plan is SOLID and directionally correct.** Don and Joel have done their homework. The architectural decisions are sound, the scope is appropriately bounded, and the implementation sequence makes sense.

However, there are **three critical gaps** that must be addressed before implementation begins:

1. **Discovery phase logger propagation is missing** - Joel mentions it in edge cases but it's not integrated into the main Orchestrator updates
2. **OrchestratorConfig vs OrchestratorOptions confusion** - Two different interfaces, both need updating
3. **CLI option naming needs verification** - `--log-level` vs `logLevel` field name mismatch

---

## The Right Things - Approve These

### 1. Logger as Optional (CORRECT)
Yes. Backward compatible, allows incremental migration. This is pragmatic. Can be required in v2.0 if needed.

### 2. Logger Interface in @grafema/types (CORRECT ARCHITECTURE)
This is the RIGHT decision. Types should never import from core. The fact that ConsoleLogger will implement it through structural typing is perfect - no coupling, clean separation.

### 3. Three-Layer Propagation (CORRECT DESIGN)
CLI → Orchestrator → PluginContext. Clear separation of concerns at each level. CLI owns mapping flags to log level, Orchestrator owns creating the logger, plugins own using it.

### 4. Phase 1/Phase 2 Split (SMART SCOPE)
Don't boil the ocean. Get infrastructure in place now (types + Orchestrator + CLI), migrate plugins incrementally. This allows shipping value quickly while maintaining quality.

### 5. Worker Threads Deferred to Phase 2 (CORRECT)
Don't over-reach. Serialization is a separate problem. These are behind a flag anyway.

---

## The Problems - Must Fix These

### PROBLEM 1: Discovery Phase Logger is Missing

**Location:** `packages/core/src/Orchestrator.ts`, discover() method

**Issue:** Discovery plugins execute with a context that DOES NOT include the logger. But `runPhase()` DOES include it. This is inconsistent.

**Required Fix:** Add `logger: this.logger` to the discovery context.

### PROBLEM 2: OrchestratorConfig vs OrchestratorOptions Confusion

**Current state:**
- **OrchestratorConfig** in `@grafema/types/src/plugins.ts` - config OBJECT
- **OrchestratorOptions** in `packages/core/src/Orchestrator.ts` - constructor parameter

**Required Fix:** BOTH interfaces must be updated. They are separate.

### PROBLEM 3: CLI Option Naming Needs Verification

Commander.js converts `--log-level` to `logLevel` automatically. Verify this works.

### PROBLEM 4: Discovery Logger Not in Test Plan

Must add test: "Discovery plugins receive logger in context"

---

## Implementation Sequence - CORRECTED

Add between Joel's steps 2.5 and 2.6:

**2.5.5 - Update discover() method**

```typescript
const context = {
  projectPath,
  graph: this.graph,
  config: this.config,
  phase: 'DISCOVERY',
  logger: this.logger,  // ADD THIS
};
```

---

## Final Verdict

**APPROVE WITH CORRECTIONS.**

This is clean, pragmatic work. Right architecture, right scope, right boundaries.

Fix these four things, then execute:
1. Add logger to Discovery phase context
2. Clarify that BOTH OrchestratorConfig and OrchestratorOptions need updating
3. Verify CLI option name conversion
4. Add Discovery logger to test plan

**SHIP IT.**

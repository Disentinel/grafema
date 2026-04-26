# RFD-2: Enricher Contract v2 -- Steve Jobs Review

**Verdict: REJECT**

This plan has serious architectural problems. Don and Joel got lost in the details and forgot to ask the fundamental questions. Let me walk you through what's wrong.

---

## The Core Problems

### 1. We're Building Infrastructure for a Future That Doesn't Exist

The entire V2 contract adds THREE new capabilities:
- `consumes`/`produces` declarations for auto-dependency inference
- `relevantFiles()` for per-file incremental enrichment
- `processFile()` for per-file processing

**What gets used in RFD-2?** Only `consumes`/`produces`.

**What gets used by the 14 enrichers?** None of them implement `relevantFiles()` or `processFile()`.

Joel admits this in Step 2:
> "This is a FUTURE hook for incremental enrichment. No enricher implements this in the initial RFD-2 delivery."

And again:
> "No enricher implements this in the initial RFD-2 delivery."

**This is YAGNI on steroids.** We're building 40% of the interface (2 of 5 methods) for theoretical future use. If we need per-file enrichment later, we can add it THEN. Ship what you need NOW.

**Recommendation:** Drop `relevantFiles()` and `processFile()` entirely. If we need them in v0.3, add them then. The V2 contract should be ONLY about `consumes`/`produces`.

---

### 2. The Nested Object Structure is Over-Engineering

Joel proposes:
```typescript
consumes: {
  edges: EdgeType[];
  nodes?: NodeType[];
}
produces: {
  edges: EdgeType[];
  nodes?: NodeType[];
}
```

Don's original spec was simpler:
```typescript
consumes: EdgeType[];
produces: EdgeType[];
```

Joel's justification (Step 1):
> "It mirrors the existing `creates: { nodes?: NodeType[], edges?: EdgeType[] }` pattern"

**This is cargo-culting.** Just because `creates` uses nested objects doesn't mean `consumes`/`produces` should.

**The difference:**
- `creates` genuinely needs both nodes AND edges because analyzers create both
- `consumes`/`produces` only uses **edges** for dependency inference

Joel admits this:
> "nodes?: NodeType[] -- documentation/validation only, NOT used for dependency inference"

**If it's not used, don't build it.** Documentation-only fields are comments, not code.

**What about the 4 enrichers that consume node types?**
- MountPointResolver
- ExpressHandlerLinker
- PrefixEvaluator
- RustFFIEnricher

They ALREADY use `dependencies` arrays to order themselves after the analysis plugins that create their node types. This works perfectly. Adding `consumes.nodes` doesn't help them.

**Recommendation:** Use flat arrays. Don was right the first time. If we need node tracking later (for validation/docs), add it AS A SEPARATE OPTIONAL FIELD.

---

### 3. Dynamic Import in Orchestrator is a Code Smell

Joel's Orchestrator change (Step 5):

```typescript
if (phaseName === 'ENRICHMENT') {
  const { buildDependencyGraph } = await import('./core/buildDependencyGraph.js');
  const { isEnricherV2 } = await import('./plugins/enrichment/EnricherV2.js');
  const { V1EnricherAdapter } = await import('./plugins/enrichment/V1EnricherAdapter.js');
  // ... use them
}
```

**Why dynamic imports?** Joel's explanation:
> "Using dynamic imports prevents loading V2 infrastructure for non-ENRICHMENT phases. This is a zero-cost abstraction."

**This is premature optimization.** The "cost" we're avoiding is loading ~200 LOC of JavaScript (the V2 infrastructure). On Node.js startup, loading 200 LOC is microseconds. We're not building for embedded systems.

**The real cost** is code complexity:
- 3 dynamic imports in the hot path (runPhase)
- Every ENRICHMENT run pays the cost of async module loading
- Harder to debug (dynamic imports break static analysis)
- Harder to test (need to mock module resolution)

**What's the actual benefit?** DISCOVERY, INDEXING, ANALYSIS, VALIDATION phases don't load the enricher adapter. So what? Those phases load their own plugins. The total memory savings is negligible (<1 KB).

**Recommendation:** Use static imports. The Orchestrator already imports dozens of things. Three more won't hurt.

```typescript
import { buildDependencyGraph } from './core/buildDependencyGraph.js';
import { isEnricherV2 } from './plugins/enrichment/EnricherV2.js';
import { V1EnricherAdapter } from './plugins/enrichment/V1EnricherAdapter.js';
```

If we were building a browser bundle, dynamic imports might matter. We're not. We're building a CLI that analyzes million-line codebases. The 200 LOC module load is noise.

---

### 4. RejectionPropagationEnricher Ordering Change Needs Proof

Joel claims (Step 6.14):
> "RejectionPropagationEnricher consumes `CALLS` edges, which are produced by FunctionCallResolver, MethodCallResolver, AliasTracker, etc. Currently it only declares `dependencies: ['JSASTAnalyzer']` which is insufficient -- it should arguably depend on the call resolvers. With V2, `buildDependencyGraph()` will automatically infer dependency on ALL enrichers that produce `CALLS`, giving it correct ordering for free. **This is a concrete example of the V2 contract improving correctness.**"

**This is a BIG claim.** We're changing the execution order of RejectionPropagationEnricher, which has been running successfully in its current position.

**Questions:**
1. Does RejectionPropagationEnricher actually BREAK if it runs before the call resolvers?
2. Or does it just produce incomplete results, which later enrichers fix?
3. If it's broken, why haven't we seen test failures?
4. If it's not broken, why are we changing it?

**The plan doesn't answer these questions.** Joel labels this as "correct behavior" but provides NO evidence that the current behavior is incorrect.

**Recommendation:** Before changing enricher ordering, PROVE the current order is wrong:
1. Write a test that demonstrates the bug
2. Show that the bug is fixed by running RejectionPropagationEnricher after the call resolvers
3. THEN update the dependencies

If we can't demonstrate a bug, we shouldn't change the order. "More correct" isn't good enough. We need "fixes an actual problem."

---

### 5. V1EnricherAdapter Creates Two Classes of Enrichers

The adapter pattern creates a split:
- **V2 enrichers**: declare `consumes`/`produces`, get automatic dependency inference
- **V1 enrichers**: wrapped in adapter, `consumes.edges = []`, fall back to manual `dependencies`

Joel says this is backward compatible. It is. But it also creates **two ways to do the same thing**, which violates KISS.

**The migration path is unclear:**
- Do we update all 14 enrichers to V2 metadata in RFD-2? (Step 6 says YES)
- Then what is the adapter FOR? (Backward compat for... what? We're updating everything.)

**If we're updating all enrichers in RFD-2**, the adapter is only useful for:
1. External plugins (do they exist?)
2. Unregistered enrichers (3 of them, which we also update in Step 7)

**So the adapter exists for external plugins that don't exist yet.**

**Recommendation:** If we're updating all enrichers in RFD-2, we don't need the adapter YET. Add it when the first external plugin appears, or when we need to support V1/V2 mixed deployments. YAGNI.

---

## What This Plan DOES Get Right

### 1. The Core Insight is Correct

**"AI should query the graph, not read code"** applies to enrichers too. Right now, enricher ordering is manual and fragile. Automatic inference from `consumes`/`produces` is the right abstraction.

### 2. Reuse Before Build

The plan correctly reuses the existing `toposort()` instead of building a new dependency resolver. `buildDependencyGraph()` is just a translator from `consumes`/`produces` to `ToposortItem[]`. Clean separation.

### 3. Small, Mechanical Changes

Steps 6-7 (updating enricher metadata) are mechanical. 5 lines per enricher, no behavior change. This is the right scope for "add metadata fields."

### 4. Test Coverage is Thorough

24 tests covering:
- Type guards
- Adapter wrapping
- Dependency inference
- Cycle detection
- Integration with Orchestrator
- Real enricher metadata validation

This is solid. The testing methodology is right.

---

## The REAL Question Nobody Asked

**Why are we building Enricher Contract v2?**

The issue says:
> "Enricher Contract v2 (Track 2, TS). Orchestrator Phase A. New enricher contract -- no RFDB v2 dependency."

**What problem does this solve?**

The plan says:
- Automatic dependency inference (instead of manual `dependencies` arrays)
- Future per-file incremental enrichment

**Are these real problems?**

**Manual dependencies:**
- Have we had ordering bugs? (The plan mentions RejectionPropagationEnricher but provides no proof of actual failure)
- Are dependency arrays hard to maintain? (They're one line per enricher)
- Do new enrichers break because of wrong ordering? (No evidence provided)

**Per-file incremental enrichment:**
- Do we need it in v0.2? (No, Joel explicitly says it's not implemented)
- Do we have a concrete design for how it works? (No, `relevantFiles()` and `processFile()` are stubs)
- Is incremental enrichment even on the v0.2 roadmap? (Not mentioned in the issue)

**I suspect this entire task exists because:**
1. Someone looked at enrichers and thought "these dependencies could be automatic"
2. Someone else thought "incremental enrichment would be nice someday"
3. Nobody asked "what problem are we solving RIGHT NOW?"

**This is architecture astronautics.** We're building elegant abstractions for problems we don't have yet.

---

## What I Would Approve

A **minimal version** of this plan:

### Scope
1. Add `consumes: EdgeType[]` and `produces: EdgeType[]` to `PluginMetadata` (flat arrays, not nested objects)
2. Add `buildDependencyGraph()` that merges inferred deps (from consumes/produces) with explicit deps
3. Update Orchestrator to use `buildDependencyGraph()` for ENRICHMENT phase (static imports, not dynamic)
4. Update all 14 enrichers with `consumes`/`produces` metadata
5. Write tests for dependency inference and cycle detection

### Excluded
- `relevantFiles()` -- add when we actually need per-file enrichment
- `processFile()` -- add when we actually need per-file enrichment
- `EnricherV2` interface -- not needed if consumes/produces are part of `PluginMetadata`
- `V1EnricherAdapter` -- not needed if we update all enrichers in one PR
- `consumes.nodes`/`produces.nodes` -- not used for dependency inference, so don't build it
- Dynamic imports in Orchestrator -- premature optimization

### Result
- ~250 LOC (half the current estimate)
- ~15 tests (instead of 24)
- Zero unused infrastructure
- Same functional benefit (automatic dependency inference)

### When to Add the Rest
- **`relevantFiles()`/`processFile()`**: When we design incremental enrichment (Track 2, Phase C?)
- **`EnricherV2` interface**: When we need to distinguish V1 from V2 (external plugins)
- **V1EnricherAdapter**: When we have external plugins that can't be updated
- **`consumes.nodes`/`produces.nodes`**: When we need node-type validation (v0.3 stability?)

**This is how you build infrastructure: one step at a time, driven by real needs.**

---

## Mandatory Checklist Violations

Going back to my checklist from CLAUDE.md:

### 1. Complexity Check
**PASS.** `buildDependencyGraph()` is O(E + P) where E = enrichers (14), P = produces entries (~20). No graph-wide iteration. Clean.

### 2. Plugin Architecture
**PASS.** Forward registration (enrichers declare what they produce, consumers declare what they need). No backward scanning. This is the right pattern.

### 3. Extensibility
**PASS.** Adding a new enricher requires only:
- Declare `consumes`/`produces` in metadata
- Implement `execute()`

No changes to Orchestrator or dependency graph builder. Good.

### 4. Does it Align with Vision?
**PARTIAL PASS.** The `consumes`/`produces` insight is correct: enrichers should declare their data dependencies explicitly, not hide them in code. But the execution is bloated with YAGNI features.

### 5. Did We Cut Corners?
**YES.** The plan includes:
- Features that won't be used (relevantFiles, processFile)
- Infrastructure that isn't needed yet (V1EnricherAdapter)
- Over-engineering (nested objects, dynamic imports)

This is the OPPOSITE of cutting corners. It's **gold-plating.**

### 6. Are There Fundamental Gaps?
**YES.** The RejectionPropagationEnricher ordering change is unsupported by evidence. We're changing execution order based on "arguably should" instead of "demonstrably must."

---

## Specific Changes Required for Approval

If you want to keep this plan close to Joel's version, these changes are MANDATORY:

### 1. Remove YAGNI Features
- Delete `relevantFiles()` from `EnricherV2` interface
- Delete `processFile()` from `EnricherV2` interface
- Remove all mentions of "per-file incremental enrichment" from docs
- If we need these later, add them in a separate RFD

### 2. Simplify the Data Model
- Use flat arrays: `consumes: EdgeType[]`, `produces: EdgeType[]`
- Remove nested objects with `edges`/`nodes`
- If we need node tracking later, add `consumesNodes?`/`producesNodes?` as SEPARATE optional fields

### 3. Use Static Imports
- Replace dynamic `await import()` in Orchestrator with static imports at top of file
- Remove the "zero-cost abstraction" justification from comments

### 4. Prove the RejectionPropagationEnricher Fix
- Write a test that demonstrates incorrect behavior with current ordering
- Show that new ordering (running after call resolvers) fixes it
- If no bug exists, don't change the ordering

### 5. Reconsider V1EnricherAdapter
- If we're updating all 14 enrichers + 3 unregistered enrichers in RFD-2, who is the adapter for?
- If the answer is "nobody right now," remove it and add it when needed
- If the answer is "external plugins," document which plugins and test against them

### 6. Update Scope Estimate
After cutting YAGNI:
- Implementation: ~250 LOC (was ~510 LOC)
- Tests: ~15 (was ~24)
- Time: probably 1-2 days instead of 3-4 days

---

## Final Judgment

**Would I ship this?** No.

**Would I show this on stage?** No. I'd have to explain why 40% of the interface isn't used. "We might need it later" is not a product story.

**Is the core idea RIGHT?** Yes. Automatic dependency inference from `consumes`/`produces` is correct and elegant.

**Is the execution RIGHT?** No. It's bloated with features we don't need yet, over-engineered in places (nested objects, dynamic imports), and includes an unproven ordering change.

---

## Recommendation

**REJECT this plan.**

Send it back to Don and Joel with clear instructions:

1. **Strip it down to the minimum viable change:**
   - Add consumes/produces to PluginMetadata (flat arrays)
   - Build dependency graph from them
   - Update enrichers
   - Test

2. **Remove all YAGNI:**
   - No relevantFiles()
   - No processFile()
   - No V1EnricherAdapter (unless proven necessary)
   - No nested objects
   - No dynamic imports

3. **Prove the RejectionPropagationEnricher fix or revert it**

4. **Come back with a plan that does ONE thing well:** automatic enricher ordering from data dependencies.

**If they do this, I'll approve.** The core insight is solid. The execution just needs to be ruthlessly simplified.

---

**Steve Jobs**
High-level Reviewer

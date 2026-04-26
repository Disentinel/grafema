# RFD-4: Semantic ID v2 -- Steve Jobs Review

## VERDICT: APPROVE (with required fixes)

This is a genuinely important architectural change. The v1 ID format has a fundamental design flaw -- positional encoding disguised as identity -- and v2 fixes it correctly. The plan is well-researched, the scope is realistic, and the team did their homework. I'm approving, but there are three issues that must be addressed before implementation. None require architectural redesign.

---

## Vision Alignment: STRONG

**"AI should query the graph, not read code."**

Stable IDs are foundational infrastructure for this vision. If every code edit cascades ID changes through the graph, then:
- AI agents can't cache node references across edits
- Incremental analysis becomes unreliable (which nodes changed vs. which just got new IDs?)
- Cross-session reasoning breaks (the `response` variable the agent was tracking yesterday has a different ID today because someone added a debug log)

v1 IDs pretend to be stable but aren't. v2 makes them actually stable. This is the kind of infrastructure that makes everything else work better. It's not flashy, but it's RIGHT.

---

## Detailed Analysis

### 1. The Core Design: Named Parent + Content Hash + Counter

This graduated disambiguation strategy is elegant:
1. Base ID (unique by name + type + parent) -- handles 95% of cases
2. Content hash (FNV-1a) -- handles remaining collisions (e.g., multiple `console.log`)
3. Counter -- handles the pathological case of identical calls

The key insight is correct: most node types DON'T collide. Functions, classes, variables, constants, interfaces, types, enums -- all unique by language semantics. Only CALL, METHOD_CALL, and PROPERTY_ACCESS need disambiguation. Joel's analysis of this (Section 4) is thorough and accurate.

**Complexity check: PASS.** CollisionResolver is O(n) per file where n = nodes-in-file. This is acceptable -- we already do a full AST traversal per file, so an additional O(n) fixup pass is negligible. No global scanning. No backward pattern matching. Forward registration with post-hoc resolution. This is the right pattern.

### 2. The `_parentCallRef` Pattern

Joel spent a lot of words wrestling with the cross-reference problem (Section 4, pages of back-and-forth). The final answer is correct: store a reference to the parent CallSiteInfo object, and resolve `parentCallId` after CollisionResolver runs.

This is NOT a hack. It's a well-known pattern: deferred resolution. The `_` prefix convention for build-pipeline-only fields is clean. The field is stripped before GraphBuilder sees it. No production code carries this temporary state.

**One concern:** Joel's spec shows the `_parentCallRef` pattern but doesn't explicitly state where the field is stripped. The JSASTAnalyzer orchestration section (5.7) shows the loop that resolves it, but the cleanup (`delete arg._parentCallRef`) needs to be explicit in the implementation plan. Minor -- but enforce it.

### 3. The `namedParent` = Nearest Ancestor Question

Don's plan and Joel's spec both acknowledge this: `render` inside `Widget` inside `Dashboard` gets `namedParent: Widget`, losing the `Dashboard` context. Is this a problem?

**My assessment: No, for the ID use case.**

The ID's job is IDENTITY, not LOCATION. Two different `render` methods:
- `render[in:Widget]` -- inside Widget class
- `render[in:Panel]` -- inside Panel class

These are distinct. The only collision scenario is two nested classes with the same method name AND the same immediate parent:

```javascript
class Dashboard {
  Widget = class {
    render() {}
  }
}
class Settings {
  Widget = class {
    render() {}  // Same namedParent: Widget, same name: render
  }
}
```

But these are in different files (or if same file, the `render` methods are in different `Widget` classes with different IDs, and the `Widget` classes have different parents). The file prefix in the ID handles different-file cases. Same-file same-parent-name is pathological -- and the content hash handles it.

**HOWEVER:** There's a real concern for SCOPE resolution in GraphBuilder. But Joel already addressed this: resolution uses the full `scopePath` field (not the ID), and the ID uses `namedParent` only for identity. These are correctly separated. Good.

### 4. The CollisionResolver Approach: Sound

Not a hack. This is a standard two-pass compilation pattern:
1. First pass: collect all symbols with provisional names
2. Second pass: resolve collisions and assign final names

Compilers, linkers, and symbol table builders have used this pattern for 50 years. The fact that it's called "CollisionResolver" instead of "SymbolTable" doesn't change the fundamental soundness.

**Plugin architecture check: PASS.** Adding new visitor types does NOT require CollisionResolver changes. The resolver operates on `PendingNode` objects generically. A new `FooVisitor` just needs to call `idGenerator.generateV2()` or `idGenerator.generateV2Simple()`. The CollisionResolver never knows what produced the nodes.

**Extensibility check: PASS.** New language/framework support = new analyzer plugin. CollisionResolver is language-agnostic.

### 5. The "Big Bang" Commit 4

Joel identifies this risk correctly: Visitors + GraphBuilder must be committed together because v2 IDs flow from visitors to GraphBuilder. Committing them separately would break the pipeline.

**Is this too risky?** No, for two reasons:
1. The blast radius is well-understood (Joel's Section 4 exhaustively catalogs every cross-reference)
2. The v1 fallback in GraphBuilder means partial migration is safe -- any node without `scopePath` falls back to v1 parsing

This is the right call. Trying to decompose it further would introduce fragile intermediate states that are harder to test than the atomic change.

### 6. Content Hash Sufficiency

Using first literal arg + arity for CALL disambiguation. Is this sufficient?

For real-world code: yes. The common collision cases are:
- `console.log("start")` vs `console.log("end")` -- different first literal arg
- `console.log(x)` vs `console.log(y)` -- non-literal args, fall through to counter
- `app.get("/users")` vs `app.get("/posts")` -- different first literal arg

The 16-bit hash space (65536 buckets) with counter fallback means we never produce duplicate IDs, we just might produce slightly less semantic ones in pathological cases. Acceptable.

### 7. v1 Fallback in GraphBuilder

Joel's approach: check `v.scopePath` first (new field), fall back to `parseSemanticId(v.id)` for backward compat.

This is a clean transition strategy, NOT permanent tech debt. The fallback exists so that:
- Incremental migration works (some files analyzed with v1, some with v2)
- Existing test fixtures don't all break simultaneously

The fallback should be tracked for removal in a future cleanup issue. It should NOT be left indefinitely.

---

## Issues Found

### Issue 1: SCOPE Node ID Collision (Must Fix)

Joel's spec says SCOPE nodes use `generateV2Simple`:
```typescript
const functionBodyScopeId = idGenerator.generateV2Simple('SCOPE', 'body', module.file);
```

But SCOPE nodes named `body` will collide! Every function has a `body` scope. If two functions are in the same file with no named parent (both top-level), their scope IDs are:
```
file->SCOPE->body          // function A's body
file->SCOPE->body          // function B's body -- COLLISION!
```

In v1 this worked because the scope path included the function name: `file->functionA->SCOPE->body`. In v2, `namedParent` should be the function name.

**Wait** -- at the point where the scope is created, ScopeTracker already has the function pushed. So `getNamedParent()` returns the function name. Let me re-check...

Actually, this depends on WHEN `enterScope` is called relative to scope body creation. Looking at FunctionVisitor:
1. Function declaration creates function node
2. `scopeTracker.enterScope(functionName, 'FUNCTION')`
3. Then body scope is created

So `getNamedParent()` at step 3 returns `functionName`. The SCOPE ID would be `file->SCOPE->body[in:functionName]`. This is correct and unique.

**But Joel's code example doesn't show the namedParent:**
```typescript
const functionBodyScopeId = idGenerator.generateV2Simple('SCOPE', 'body', module.file);
```

`generateV2Simple` calls `this.scopeTracker?.getNamedParent()` internally. So it DOES get the parent. The code example is misleading but correct. The function signature includes `namedParent` automatically.

**Verdict:** Not actually a bug, but the spec is confusing. Joel should clarify that `generateV2Simple` automatically includes `namedParent` from ScopeTracker -- it's not the caller's job to pass it.

**Downgrading this to a documentation fix.**

### Issue 2: IdGenerator Must Be Shared Per File (Must Fix)

Currently, every visitor creates `new IdGenerator(scopeTracker)` locally:
```
CallExpressionVisitor.ts: new IdGenerator(scopeTracker)  -- 5 instances
FunctionVisitor.ts: new IdGenerator(scopeTracker)  -- 2 instances
VariableVisitor.ts: new IdGenerator(scopeTracker)  -- 1 instance
```

That's 8 separate IdGenerator instances PER FILE. For v2, the CollisionResolver needs ALL pending nodes from ALL visitors for a file. If each visitor has its own IdGenerator, the pending nodes are fragmented.

Joel identifies this in Section 5.5:
> "This means the IdGenerator must be created at the file level (in JSASTAnalyzer) and passed to all visitors."

But this is listed as an observation, not as an explicit Phase/Commit item. This is a **prerequisite refactor** that must happen BEFORE Phase 5 visitors can use v2 IDs. It's non-trivial -- it requires changing how visitors receive their IdGenerator.

**Required:** Add an explicit step (Phase 4.5 or expand Phase 4) for refactoring IdGenerator instantiation from per-visitor to per-file. This must be its own commit with its own tests (verify that v1 behavior is unchanged after the refactoring).

### Issue 3: PropertyAccessVisitor Has No Shared IdGenerator (Must Fix)

Related to Issue 2 but worse. PropertyAccessVisitor currently:
1. Is not integrated with the visitor framework the same way as others
2. Creates `new IdGenerator(scopeTracker)` per property access

Joel's spec for Section 5.5 actually shows this problem and then hand-waves:
> "Alternatively, PropertyAccessVisitor could use computeSemanticIdV2 directly and register with a shared collision resolver, but using IdGenerator keeps the pattern consistent."

For PropertyAccessVisitor specifically, it needs access to the same shared IdGenerator. This is part of Issue 2's refactor but deserves explicit attention because PropertyAccessVisitor's integration pattern differs from the other visitors.

---

## Required Changes Before Implementation

1. **Clarify generateV2Simple auto-includes namedParent** -- Update Joel's code examples in Phases 5.1, 5.3 to show that namedParent comes from ScopeTracker automatically. Not a code change, just spec clarity to prevent implementer confusion.

2. **Add explicit "Shared IdGenerator" refactor step** -- Before Phase 5, there must be a commit that:
   - Creates a single IdGenerator per file in JSASTAnalyzer
   - Passes it to all visitors
   - Verifies v1 behavior is unchanged
   This is the riskiest part of the refactor and deserves isolation.

3. **Track v1 fallback removal** -- Create a Linear issue (or add to tech debt backlog) for removing the v1 fallback paths in GraphBuilder and CLI after migration stabilizes. Don't let this become permanent scaffolding.

---

## What I'd Show On Stage

The stability demo. Parse a file. Add an if-block. Show that zero IDs changed for existing nodes. Then show v1 doing the same thing and watch the cascade. That's the killer demo.

The graduated collision resolution is also demo-worthy: "Here's what happens with three `console.log` calls. Watch how each gets a unique, meaningful ID without arbitrary counters."

---

## Summary

The plan is architecturally sound. It correctly identifies the root cause (positional encoding in IDs), proposes the right fix (semantic identity based on name + type + named parent), handles edge cases properly (graduated disambiguation), and maintains backward compatibility (v1 fallback during transition).

The three issues I found are execution-level concerns, not architectural ones. Fix them and proceed.

*"Semantic ID v2 makes the ID what it should have been from the start: a name, not an address."*

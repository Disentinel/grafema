# Linus Torvalds: Plan Review

## Verdict
**APPROVED** (with minor concerns noted below)

## Assessment

### What's Right

1. **Correct architectural decision: New plugin, not patch**
   Don nailed this. ServiceDetector is in the wrong phase (INDEXING instead of DISCOVERY), uses static patterns instead of declarative configs, and mixing concerns would make both worse. A dedicated WorkspaceDiscovery plugin is the right call.

2. **Proper separation of concerns**
   The decomposition is sensible:
   - `detector.ts` - workspace type detection
   - `parsers/*.ts` - config file parsing (pnpm/npm/lerna)
   - `globResolver.ts` - pattern resolution
   - `WorkspaceDiscovery.ts` - orchestration

   Each piece does one thing. No god objects.

3. **Aligns with project vision**
   The user's complaint is textbook Grafema: "I ran `grafema analyze` and got 1 service instead of 3." This directly blocks the "AI should query the graph, not read code" thesis. Without workspace support, the graph lies about project structure.

4. **No new dependencies**
   Using `yaml` (already present) and implementing glob resolution with `minimatch` (already present) avoids dependency bloat. Good.

5. **Non-breaking approach**
   WorkspaceDiscovery returns `skipped: true` on non-workspace projects, letting lower-priority plugins handle the fallback. Existing behavior preserved.

6. **Comprehensive test matrix**
   Joel's test cases cover the major scenarios including negation patterns, nested workspaces, missing package.json, and edge cases like Unicode package names.

### What's Wrong

1. **Minor: Reinventing glob resolution**
   Joel's `expandGlob` implementation is custom code. I understand avoiding dependencies, but `minimatch` (which we already have) doesn't expand globs - it only matches them. The plan says "use minimatch" but then shows custom traversal code.

   The implementation is fine and has appropriate depth limits, but let's be clear: we're writing glob expansion, not using an existing library. This is ~50 lines of file system traversal code that could have bugs.

   **Verdict:** Acceptable risk. The code is straightforward and well-bounded. Just don't pretend we're "using minimatch" when we're building our own glob expander.

2. **Phase mismatch mentioned but not fixed**
   Don correctly identifies that ServiceDetector is in the wrong phase (INDEXING instead of DISCOVERY). Joel's plan adds WorkspaceDiscovery to DISCOVERY but leaves ServiceDetector in INDEXING with priority 90.

   This creates a weird situation: two service detection mechanisms in different phases that might interact unpredictably.

   **Recommendation:** Document this explicitly as tech debt for a future cleanup. Don mentioned "deprecate ServiceDetector eventually" - make that a concrete Linear issue, not a vague future plan.

3. **Priority hierarchy is fragile**
   The plan proposes:
   ```
   WorkspaceDiscovery      (priority: 110, DISCOVERY)
   MonorepoServiceDiscovery (priority: 100, DISCOVERY)
   ServiceDetector         (priority: 90, INDEXING)
   SimpleProjectDiscovery  (priority: 50, DISCOVERY)
   ```

   But ServiceDetector is in INDEXING phase, so priority comparison with DISCOVERY plugins is meaningless - they run in different phases!

   Looking at the Orchestrator, DISCOVERY plugins run first, then INDEXING. So the actual execution order is:
   1. All DISCOVERY plugins by priority (WorkspaceDiscovery, Monorepo, Simple)
   2. Then INDEXING phase including ServiceDetector

   This means if WorkspaceDiscovery finds services, ServiceDetector will ALSO run and potentially create DUPLICATE service nodes.

   **Critical question:** Does the graph deduplicate by path? If not, we have a bug waiting to happen.

   **Recommendation:** Either:
   - Add a skip condition to ServiceDetector: "if services already exist in graph, skip"
   - Or move ServiceDetector's service detection logic entirely into WorkspaceDiscovery and gut ServiceDetector
   - Or make ServiceDetector aware of workspace-discovered services

   Joel's plan mentions "Make ServiceDetector aware - if WorkspaceDiscovery found services, skip ServiceDetector's naive patterns" in Step 8 but doesn't specify HOW. This needs explicit detail.

### Questions

1. **How do plugins communicate "I found services, skip me"?**
   The plan shows WorkspaceDiscovery returning `{ services, workspaceType }` in metadata. How does ServiceDetector (different phase) know to skip? Via shared context? Graph query? Magic?

   Joel's step 6 says "Make ServiceDetector aware" but doesn't show the implementation. This is the key coordination point and it's hand-waved.

2. **What about Turborepo?**
   Modern monorepos often use Turborepo with `turbo.json`. It's not a workspace definition per se (it uses npm/pnpm/yarn workspaces underneath), but should we detect it as a signal?

   **Verdict:** Out of scope for this issue. Turborepo uses underlying workspace configs. But worth noting for completeness.

3. **Performance on large monorepos**
   The plan mentions "Add progress callbacks, consider caching" as a risk mitigation. For a 100+ package monorepo, how long will glob resolution take?

   **Verdict:** Acceptable for MVP. But should be measured during implementation. If it's > 1 second, we need progress reporting.

## Recommendations

1. **Clarify ServiceDetector coordination** (must do before implementation)
   Joel needs to specify exactly how ServiceDetector knows to skip when WorkspaceDiscovery has already run. Options:
   - ServiceDetector queries graph for existing SERVICE nodes by path
   - WorkspaceDiscovery sets a context flag
   - ServiceDetector is deprecated and removed entirely

   Pick one and write the code.

2. **Create tech debt ticket** (before starting implementation)
   "REG-XXX: Deprecate ServiceDetector in favor of WorkspaceDiscovery"
   This ensures we don't forget the cleanup.

3. **Measure glob performance** (during implementation)
   After globResolver is implemented, benchmark on a large monorepo (Grafema itself works). If > 500ms, add progress reporting.

4. **Don't call it "using minimatch"**
   The plan should say "implementing glob expansion with minimatch for pattern matching" - we're writing traversal code, not using a glob library.

## Final Word

This is a solid plan. The architecture is correct, the scope is reasonable, and it directly addresses a real blocker for onboarding.

The main concern is the ServiceDetector coordination gap - but that's a planning detail, not an architectural flaw. Joel just needs to fill in that section before Kent starts writing tests.

**Approved for implementation** once the ServiceDetector coordination is specified.

---

*"Talk is cheap. Show me the code."* - and make sure ServiceDetector doesn't create duplicate services.

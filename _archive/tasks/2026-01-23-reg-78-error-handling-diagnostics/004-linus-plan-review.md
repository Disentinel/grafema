# PLAN REVIEW — REG-78 Error Handling & Diagnostics

**Reviewer:** Linus Torvalds (High-level Reviewer)
**Date:** January 23, 2026
**Decision:** APPROVE (conditional)

---

## Summary

**APPROVE with two BLOCKING concerns that must be resolved before implementation.**

The architecture is fundamentally sound—the structured error system fills a real gap, the logger approach is pragmatic (custom, not heavyweight), and the phases are realistic. But there are architectural questions that must be answered before coding starts, and one scope decision that needs explicit confirmation.

---

## What's Good

1. **Diagnosis is accurate.** Don correctly identified the silent failure problem as CRITICAL. The 6+ catch blocks in GitPlugin, the JSModuleIndexer swallowing parse failures, and the complete absence of error visibility to users—these are real, painful gaps.

2. **Custom logger is the right call.** Joel's reasoning (Winston/Pino are 12+ MB overkill for a 200-line implementation) is correct. The codebase has no logging dependencies. Introducing one for this is adding unnecessary cognitive load and dependency risk.

3. **Phasing is realistic.** Two weeks for Phases 1 & 2 (error types + diagnostics plumbing + CLI flags) is reasonable. The deferral of Phase 3 (GitPlugin updates) and Phase 4 (recovery strategies) to later sprints avoids scope creep.

4. **PluginResult.errors[] reuse is smart.** The field already exists. Leveraging it instead of inventing DiagnosticCollector in Phase 1 keeps Phase 1 lean. Phase 2 adds real-time aggregation if needed.

5. **Logger in PluginContext is non-breaking.** Optional field, plugins check before using. Clean.

---

## BLOCKING CONCERN #1: PluginResult.errors[] Type Definition

**The problem:** Joel says "Phase 1 focused on types + logging. Phase 2 focused on diagnostics output." But I don't see the actual type definition for `PluginResult.errors[]`.

Currently, what IS `PluginResult.errors`?
- Is it `string[]`? (likely)
- Is it `GrafemaError[]`?
- Is it `{ code: string; message: string }[]`?

**Why it matters:** If it's currently `string[]`, then populating it with `GrafemaError` objects (or objects with `.code` property) will cause TypeScript errors when DiagnosticCollector tries to read `.code` and `.severity` from them. We need to either:

1. **Redefine PluginResult.errors as an object type** (has `code`, `severity`, `message`, `context`), OR
2. **Create a separate PluginResult.diagnostics field** with the new type, keep errors as backward-compatible `string[]`

**Action:** Joel must document the current type of PluginResult.errors[] and decide on backward compatibility. This blocks Phase 1 type definitions.

---

## BLOCKING CONCERN #2: Orchestrator Responsibilities — Who Owns Diagnostics?

**The problem:** Joel's Phase 2 spec shows:

```typescript
// In Orchestrator.runPhase()
this.diagnosticCollector.addFromPluginResult(phase, plugin.metadata.name, result);
```

But later, in the CLI:
```typescript
const diagnosticCollector = orchestrator.getDiagnostics();
const reporter = new DiagnosticReporter(diagnosticCollector);
console.log(reporter.summary());
```

**This creates ambiguity:** Is the Orchestrator responsible for:
- Just collecting diagnostics, OR
- Deciding whether to stop/continue based on severity?

**Current design:** The Orchestrator collects but doesn't decide. It always returns all results regardless of errors. The CLI decides what to do with them.

**Why it matters:** If a `fatal` error occurs (e.g., database corruption), should the Orchestrator:
- A) Stop immediately (throw error, halt analysis), OR
- B) Continue collecting, let CLI decide to report and exit?

Don's plan mentions "Fatal vs recoverable vs warning" but doesn't say WHERE the enforcement happens.

**My concern:** This boundary is unclear. If enforcement is in the CLI, then Orchestrator is just a data collector. If enforcement is in Orchestrator, the CLI becomes simpler but Orchestrator knows too much.

**Action:** Joel must clarify:
1. Does Orchestrator.run() throw on fatal errors?
2. If not, how does the CLI know to exit with code 1 vs 0?
3. Where does "stop analysis" decision live?

---

## Minor Concerns (Not Blocking, Address During Implementation)

1. **Logger interface lacks context objects.** Joel's design has `logger.error(message, context?)`. But context objects are untyped (`Record<string, unknown>`). This is fine for Phase 1, but by Phase 2, we'll want context to have predictable shape (file, line, plugin, phase). This is a refinement, not a blocker.

2. **DiagnosticReporter summary() string.** Joel shows text output like `"❌ ERR_PARSE_FAILURE (src/app.rs:12)"` but doesn't specify the exact format. Different team members might implement different formatting. Kent's tests will lock this in, but specify it now to avoid rework.

3. **Error codes as constants vs enum.** Joel mentions "error codes" but doesn't say if they're exported as constants or an enum. Recommend using `const ERROR_CODES = { ERR_PARSE_FAILURE: 'ERR_PARSE_FAILURE', ... }` for type safety. Minor, but Rob will ask.

4. **Phase 1 doesn't touch any plugins.** This means Phase 1 succeeds with no changes to GitPlugin, JSModuleIndexer, etc. They still return no errors. This is fine, but make clear that Phase 1 is infrastructure-only. Don't expect silent failures to be fixed until Phase 3.

5. **No mention of how logger handles errors in logger itself.** What if ConsoleLogger.error() throws? Does it swallow exceptions? Recommend: always wrap in try-catch, fallback to console.log if logger fails. Minor detail, Rob will handle.

---

## Questions for Joel (Before Implementation)

1. **PluginResult.errors type** — What is it now, and what should it be?
2. **Orchestrator vs CLI responsibility** — Who stops analysis on fatal errors?
3. **Exit codes** — How does CLI translate diagnostic severity to exit code?
4. **Logger fallback** — What happens if ConsoleLogger throws?

---

## Scope Assessment

**Is this in scope for REG-78?** Yes, with caveats:
- Error types + logging infrastructure ✓
- Diagnostic collection + reporting ✓
- CLI flags (--verbose, --debug) ✓

**NOT in scope (correctly deferred):**
- Fixing GitPlugin silent failures (Phase 3)
- Recovery strategies (Phase 4)
- Retry logic (future)
- Integration with all plugins (Phase 3+)

This is correct. REG-78 is about visibility and infrastructure, not fixing every plugin's error handling.

---

## Alignment with Vision

**Does this serve Grafema's core thesis: "AI should query the graph, not read code"?**

Partially. Error handling is infrastructure, not a graph feature. BUT:
- Better diagnostics mean agents can understand why analysis failed
- Structured errors enable programmatic recovery (future agents can parse error codes)
- Debug logs in `.grafema/diagnostics.log` give agents visibility into analysis internals

This doesn't directly enable "query the graph instead of read code," but it enables agents to understand and debug when the graph is incomplete or corrupted. Smart investment.

---

## Decision

**APPROVE Phase 1 and Phase 2 for implementation, CONDITIONAL ON:**

1. Joel clarifies PluginResult.errors[] type and backward compatibility (blocking)
2. Joel specifies Orchestrator vs CLI responsibility for fatal errors (blocking)
3. Kent and Rob address the minor concerns during implementation

**Timeline:** Two weeks is realistic if the blocking questions are answered immediately.

**Recommendation:** Have Joel answer the two blocking questions in writing (update the tech spec) before Kent starts writing tests. Then proceed.

**Risk level:** LOW. The architecture is sound, scope is clear, and implementation is straightforward. The blocking questions are administrative, not technical.

---

## Implementation Notes for Kent & Rob

- Kent: Write tests assuming the two blocking questions are answered. If not, ask before coding.
- Rob: Match the codebase style. Look at existing `PluginResult` usage patterns before implementing.
- Both: Remember—Phase 1 is infrastructure. GitPlugin and JSModuleIndexer don't change. Their errors won't be logged yet. That's Phase 3.

---

**Ready to proceed once blocking concerns are resolved.**

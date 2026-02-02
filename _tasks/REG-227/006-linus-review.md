# REG-227: Linus Torvalds - High-Level Review

## Verdict: APPROVED

This is a clean, focused implementation that does the right thing. No hacks, no shortcuts, proper architectural approach.

---

## Did We Do the RIGHT Thing?

**Yes.**

The original problem was clear: the validator was reporting false positives for JS built-ins and external package calls. Two options existed:

1. **Option A (Architectural)**: Add `resolutionType` attribute to CALL nodes during resolution phase
2. **Option B (Pragmatic)**: Validator detects resolution type at validation time

Don correctly chose Option B for now, with a clear rationale:
- Adding attributes would require modifying multiple plugins
- Migration path complexity for existing graphs
- Option A can be revisited in v0.3 when more resolution features are added

The key insight: **the validator can determine resolution type using the same logic as the resolvers**. This is NOT duplication - it's the validator verifying what the resolvers claim to have done.

---

## Does It Align with Project Vision?

**Yes.**

From CLAUDE.md: "AI should query the graph, not read code."

This change improves graph query quality by:
1. **Eliminating noise**: Built-ins and externals no longer pollute validation output
2. **Better categorization**: Summary now shows resolution breakdown (internal/external/builtin/method/unresolved)
3. **Actionable diagnostics**: Only truly unresolved calls are reported, and as warnings (not errors)

The validator becomes more useful for identifying actual issues.

---

## Did We Cut Corners?

**No.**

Specific checks:

1. **Shared constant instead of duplication**: `JS_GLOBAL_FUNCTIONS` is defined once in `/packages/core/src/data/builtins/jsGlobals.ts` and imported by both `ExternalCallResolver` and `CallResolverValidator`. No copy-paste.

2. **Proper type handling**: Rob correctly identified that `NodeRecord` is a union type and used `BaseNodeRecord` instead. This shows attention to TypeScript correctness.

3. **Clean separation**: The resolution detection logic is in a private method `determineResolutionType()` with clear priority order documented in JSDoc.

4. **Proper warning semantics**: Error code changed from `ERR_UNRESOLVED_CALL` to `WARN_UNRESOLVED_CALL`, severity explicitly set to `'warning'`.

---

## Do Tests Actually Test What They Claim?

**Yes.**

The 4 new tests (plus 1 updated) directly verify the acceptance criteria:

| Test | Verifies |
|------|----------|
| "should NOT flag JavaScript built-in function calls" | Built-ins recognized, `resolvedBuiltin` count correct |
| "should NOT flag external package calls with CALLS edges" | External calls to EXTERNAL_MODULE not flagged |
| "should flag truly unresolved calls as warnings (not errors)" | Severity is `'warning'`, code is `WARN_UNRESOLVED_CALL` |
| "should correctly categorize mixed resolution types in summary" | All 5 resolution types counted correctly |
| "should handle eval as builtin but flag Function constructor" | `eval` is builtin, `Function` is not |

Tests are specific, isolated, and verify the exact behavior described in the task. No hand-waving.

---

## Did We Forget Anything from the Original Request?

Checking against the original acceptance criteria:

- [x] External calls (with edge to EXTERNAL_MODULE) not reported
- [x] Built-in calls not reported
- [x] Only truly unresolved calls reported as warnings
- [x] Summary shows breakdown by resolution type

All criteria met.

---

## Code Quality Notes

### Good

1. **JSDoc is excellent**: Both `jsGlobals.ts` and `CallResolverValidator.ts` explain WHY, not just WHAT. The comment in `jsGlobals.ts` explicitly lists what is NOT included (constructors, objects with methods, environment globals) - this prevents future confusion.

2. **Clear priority order**: `determineResolutionType()` has explicit numbered comments showing the resolution priority. Anyone reading this code knows exactly what happens when.

3. **Defensive coding**: Line 158-159 handles edge case where CALLS edge exists but destination type is unknown - treats as resolved (conservative approach, avoids false positives).

4. **Logging**: Summary is logged at the right level (info), individual warnings limited to first 10 with overflow message.

### Minor Observation (Not a Blocker)

The `ValidationSummary` interface has redundant `warnings` field that equals `unresolvedCalls`. I understand why - it makes the summary self-documenting. But if we add more warning types later, this field name becomes misleading. Consider renaming to `unresolvedWarnings` in future refactor. Not worth blocking for now.

---

## Architectural Alignment

This implementation follows the plugin architecture correctly:

1. **Phase**: VALIDATION (correct - runs after ENRICHMENT)
2. **Priority**: 90 (runs late in validation phase)
3. **Dependencies**: Declares `['FunctionCallResolver', 'ExternalCallResolver']` - accurate and explicit

The dependency chain is clear: ANALYSIS creates CALL nodes -> ENRICHMENT (FunctionCallResolver, ExternalCallResolver) creates CALLS edges -> VALIDATION (CallResolverValidator) verifies resolution quality.

---

## Summary

This is how we should implement features:

1. Clear problem statement
2. Architectural options considered
3. Pragmatic choice with documented rationale
4. Shared constants instead of duplication
5. Tests that verify the actual requirements
6. Clean, readable code

**Approved for merge.**

---

## Recommendation

After merge, update Linear REG-227 to Done. No tech debt to track - this is a clean implementation.

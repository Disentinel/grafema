# Linus Torvalds - Plan Review: REG-261 BrokenImportValidator

## Verdict: APPROVED (with minor clarifications)

The plan is **solid and architecturally correct**. This is exactly the kind of feature Grafema should have. Let me address each review criterion.

---

## 1. Did we do the right thing?

**YES.**

The plan correctly identifies that:
- ImportExportLinker already creates IMPORTS_FROM edges only when exports exist
- The absence of IMPORTS_FROM edge = broken import (data already in graph)
- A new VALIDATION-phase plugin is the right place (not extending enrichment)

This follows Grafema's core principle: **query the graph, don't read code**. The validator queries existing graph data rather than re-analyzing source files.

---

## 2. Did we cut corners?

**NO.**

The plan:
- Separates concerns properly (ENRICHMENT builds graph, VALIDATION queries it)
- Handles all edge cases explicitly (namespace imports, type-only imports, external modules)
- Includes comprehensive globals list instead of a hacky whitelist
- Creates proper GlobalsRegistry class for extensibility

The decision to NOT extend ImportExportLinker is correct. Mixing validation into enrichment would violate phase separation and make the system harder to reason about.

---

## 3. Does it align with project vision?

**YES.**

This is textbook Grafema:
1. Graph already contains the data (IMPORT nodes, IMPORTS_FROM edges)
2. Validator just queries: "IMPORT with no IMPORTS_FROM edge = broken"
3. No code re-parsing needed
4. Works for untyped JS codebases (TypeScript users don't need this)

---

## 4. Did we add a hack?

**NO.**

The implementation follows existing patterns exactly:
- Same Plugin base class as CallResolverValidator, DataFlowValidator
- Same error reporting via ValidationError
- Same integration with DiagnosticCollector/DiagnosticReporter
- Same CHECK_CATEGORIES registration

---

## 5. Is it at the right level of abstraction?

**YES.**

- GlobalsRegistry is reusable (can be used by other validators)
- BrokenImportValidator is focused (only import validation)
- Error codes are specific (ERR_BROKEN_IMPORT vs ERR_UNDEFINED_SYMBOL)

One minor note: The validator does two related but distinct things:
1. Broken imports (missing export)
2. Undefined symbols (not imported, not local, not global)

I'm fine with both in one validator because:
- They share the same indexes (imports, definitions)
- They're semantically related (both about "where does this symbol come from?")
- Splitting would just add complexity without benefit

---

## 6. Do tests actually test what they claim?

**YES.**

Joel's test spec covers:
- Happy paths (broken named import, broken default import, undefined symbol)
- False positive prevention (valid imports, local definitions, globals, method calls)
- Edge cases (namespace imports, type-only imports)
- Configuration (custom globals)

The mock graph approach is correct for unit tests. Integration tests with fixtures will verify real-world behavior.

---

## 7. Did we forget something from the original request?

The original request asked for:
1. `ERR_BROKEN_IMPORT` for non-existent exports - **COVERED**
2. `ERR_UNDEFINED_SYMBOL` for undefined symbols - **COVERED**
3. Integration with `grafema check` - **COVERED** (new 'imports' category)

**One omission from Don's plan:** `ERR_BROKEN_REEXPORT` was mentioned but not included in Joel's spec. This is acceptable for v1 - re-export chains are already handled by ImportExportLinker. If the chain is broken, no IMPORTS_FROM edge is created, which is already detected as ERR_BROKEN_IMPORT.

---

## Minor Issues to Address During Implementation

### 1. Priority Value

Joel's spec says priority 85, which is fine. But let me verify the context:
- CallResolverValidator: priority 90
- DataFlowValidator: priority 100

BrokenImportValidator at 85 runs BEFORE these, which is correct - it validates import structure before call resolution validation. Good.

### 2. Graph Interface

The spec uses `graph.queryNodes({ nodeType: 'IMPORT' })` but existing code uses `graph.queryNodes({ nodeType: 'CALL' })`. Verify this matches the actual GraphBackend interface - it does based on existing validators.

### 3. Error Severity

- ERR_BROKEN_IMPORT: 'error' - **Correct** (this is definitely a bug)
- ERR_UNDEFINED_SYMBOL: 'warning' - **Correct** (might be false positive due to missing globals)

---

## Implementation Order

The spec correctly identifies:
1. First: GlobalsRegistry (no dependencies)
2. Second: BrokenImportValidator (depends on GlobalsRegistry)
3. Third: check.ts modifications (depends on validator)
4. Fourth: Tests

Kent should write tests first (TDD), but the implementation order above is logical.

---

## Conclusion

**APPROVED.**

This is a well-designed feature that:
- Follows existing patterns
- Aligns with Grafema's vision
- Handles edge cases properly
- Has comprehensive test coverage planned

No hacks, no shortcuts, no embarrassments.

Proceed to implementation.

---

**Next:** Kent Beck writes tests, Rob Pike implements.

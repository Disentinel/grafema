# Don Melton - Tech Lead Analysis: REG-332 Improve Strict Mode Error UX

**Date:** 2026-02-05
**Status:** High-Level Plan
**Related:** REG-330 (parent), Steve's demo report `_tasks/REG-330/010-steve-demo.md`

---

## Executive Summary

The strict mode implementation (REG-330) works correctly but has poor UX. Steve's demo identified four critical issues that prevent this feature from being demo-ready. This plan addresses each issue with specific implementation approaches grounded in prior art from Elm and Rust compilers.

**Key insight:** The current implementation treats strict mode as a debugging tool, but the error messages feel like compiler internals rather than user guidance. We need to shift from "what failed" to "why it failed and how to fix it."

---

## Current Implementation Analysis

### Error Flow Architecture

```
StrictModeError (thrown by enrichers)
    ↓
PluginResult.errors[] (collected)
    ↓
DiagnosticCollector.addFromPluginResult()
    ↓
Orchestrator.runPhase() → checks hasFatal() → throws Error
    ↓
analyze.ts catch block → prints error.message + reporter.report()
```

### Key Files

| File | Purpose |
|------|---------|
| `packages/core/src/errors/GrafemaError.ts` | StrictModeError class definition |
| `packages/core/src/diagnostics/DiagnosticCollector.ts` | Collects errors from plugins |
| `packages/core/src/diagnostics/DiagnosticReporter.ts` | Formats errors for output |
| `packages/core/src/Orchestrator.ts` | Throws on fatal errors (lines 423-442) |
| `packages/cli/src/commands/analyze.ts` | Catch block prints error (lines 385-415) |
| `packages/core/src/plugins/enrichment/MethodCallResolver.ts` | Creates StrictModeError with suggestion |

### The Duplication Problem

The duplication occurs because:
1. `Orchestrator.runPhase()` throws `new Error("Fatal error in X: message")` (line 732)
2. `analyze.ts` catch block prints `error.message` (line 398)
3. `analyze.ts` also prints `reporter.report()` which includes the same diagnostic (line 404)

Result:
```
✗ Analysis failed: Fatal error in MethodCallResolver: Cannot resolve method call: user.processData

[FATAL] STRICT_UNRESOLVED_METHOD (/tmp/test.js:3) Cannot resolve method call: user.processData
```

---

## Prior Art Research

### Elm Compiler - Friendly Error Messages

Elm's approach ([compiler-errors-for-humans](https://elm-lang.org/news/compiler-errors-for-humans)):
- First-person voice: "I see an error" makes compiler feel conversational
- **Show the chain**: When type inference fails, show the entire deduction path
- **Context-aware suggestions**: Analyze WHY resolution failed, not just THAT it failed
- **Links to documentation**: Error messages include links to guides

Example Elm error:
```
-- TYPE MISMATCH ----------------------- src/Main.elm

The `map` function expects this type of argument:

    (a -> b)

But I am seeing this type instead:

    (String -> Int -> String)

Hint: It looks like a function needs 1 more argument.
```

### Rust Compiler - Structured Errors

Rust's approach ([Rust error guide](https://blog.logrocket.com/error-handling-rust/)):
- Start with a verb, often "cannot"
- Use `rustc --explain E0001` for detailed explanations
- Show the exact code location with ASCII art underlines
- Provide `help:` suggestions for common fixes

Example Rust error:
```
error[E0382]: borrow of moved value: `x`
  --> src/main.rs:5:20
   |
3  |     let x = String::from("hello");
   |         - move occurs here
4  |     let y = x;
5  |     println!("{}", x);
   |                    ^ value borrowed here after move
   |
help: consider cloning the value
   |
4  |     let y = x.clone();
   |              ++++++++
```

### ESLint - Suppression Comments

ESLint's suppression pattern ([ESLint documentation](https://eslint.org/docs/latest/use/configure/rules)):
- `// eslint-disable-next-line rule-name`
- `/* eslint-disable rule-name */` for blocks
- Requires specifying the rule being disabled (good practice)

---

## Critical Issues and Solutions

### Issue 1: Error Message Duplication

**Root Cause:** Two output paths both print the same error.

**Solution:** Single structured output format.

```typescript
// In Orchestrator.runPhase() - throw with structured data, not concatenated message
if (this.diagnosticCollector.hasFatal()) {
  const fatal = this.diagnosticCollector.getAll().find(d => d.severity === 'fatal');
  // Don't include message in thrown error - let CLI format it
  throw new StrictModeFailure(fatal);
}

// In analyze.ts - single formatted output
catch (e) {
  if (e instanceof StrictModeFailure) {
    // Print ONLY the structured diagnostic, not error.message
    const reporter = new DiagnosticReporter(orchestrator.getDiagnostics());
    console.error(reporter.formatStrict(e.diagnostic));
  }
}
```

**Expected output (single message):**
```
STRICT_UNRESOLVED_METHOD /tmp/test.js:3

  Cannot resolve method call: user.processData

  Why: The variable `user` comes from getUser() which has unknown return type.

  Suggestion: Add JSDoc to getUser() or check if class is imported.

  Run without --strict for graceful degradation.
```

### Issue 2: Context-Aware Suggestions

**Root Cause:** `MethodCallResolver` generates generic suggestions without analyzing why resolution failed.

**Solution:** Pass failure reason through the error context.

```typescript
// In MethodCallResolver.ts
enum ResolutionFailureReason {
  UNKNOWN_OBJECT_TYPE = 'unknown_object_type',      // getUser() return unknown
  CLASS_NOT_IMPORTED = 'class_not_imported',        // User class not in scope
  METHOD_NOT_FOUND = 'method_not_found',            // Class exists but no such method
  EXTERNAL_DEPENDENCY = 'external_dependency',      // From node_modules
  CIRCULAR_REFERENCE = 'circular_reference',        // Alias chain too deep
}

// Track WHY resolution failed
const result = await this.resolveMethodCall(methodCall, ...);
if (!result.resolved) {
  const suggestion = this.generateContextualSuggestion(
    methodCall,
    result.failureReason,
    result.partialChain  // What we DID resolve before failing
  );

  errors.push(new StrictModeError(
    `Cannot resolve method call: ${methodCall.object}.${methodCall.method}`,
    'STRICT_UNRESOLVED_METHOD',
    {
      ...context,
      failureReason: result.failureReason,
      resolvedChain: result.partialChain,
    },
    suggestion
  ));
}
```

**Suggestion generation:**
```typescript
generateContextualSuggestion(call, reason, chain): string {
  switch (reason) {
    case 'unknown_object_type':
      return `Variable "${call.object}" comes from ${chain.source} which has unknown return type. ` +
             `Add JSDoc: /** @returns {{${call.method}: Function}} */`;
    case 'class_not_imported':
      return `Class "${call.object}" is not imported. Check your imports.`;
    case 'method_not_found':
      return `Class "${call.object}" exists but has no method "${call.method}". ` +
             `Available methods: ${chain.availableMethods.join(', ')}`;
    case 'external_dependency':
      return `This call is to an external library. Consider adding type stubs.`;
  }
}
```

### Issue 3: Show the Chain

**Root Cause:** Error shows leaf failure without showing what DID resolve.

**Solution:** Track resolution chain and include in error context.

```typescript
// Add to ErrorContext in GrafemaError.ts
export interface ErrorContext {
  // ...existing fields

  /** Resolution chain showing what was resolved before failure */
  resolutionChain?: Array<{
    step: string;      // "getUser() return"
    result: string;    // "unknown" or "User class"
    file?: string;
    line?: number;
  }>;
}

// In DiagnosticReporter - format chain for display
formatChain(chain: ErrorContext['resolutionChain']): string {
  if (!chain || chain.length === 0) return '';

  const lines = ['  Resolution chain:'];
  for (const step of chain) {
    const location = step.file ? ` (${step.file}:${step.line})` : '';
    lines.push(`    ${step.step} -> ${step.result}${location}`);
  }
  return lines.join('\n');
}
```

**Expected output:**
```
STRICT_UNRESOLVED_METHOD /tmp/test.js:3

  Cannot resolve method call: user.processData

  Resolution chain:
    getUser() return -> unknown (not declared)
    user variable -> inherits unknown type
    user.processData -> FAILED (no type information)

  Suggestion: Add return type to getUser() at line 1.
```

### Issue 4: Add Escape Hatch (grafema-ignore)

**Root Cause:** No way to suppress known false positives.

**Solution:** Comment-based suppression, similar to ESLint.

**Comment syntax:**
```javascript
// grafema-ignore-next-line STRICT_UNRESOLVED_METHOD
user.processData();

// grafema-ignore STRICT_UNRESOLVED_METHOD - known library call
someLibrary.unknownMethod();
```

**Implementation approach:**

1. **During INDEXING phase (JSModuleIndexer):**
   - Parse comments for `grafema-ignore` patterns
   - Store as metadata on CALL/METHOD_CALL nodes

2. **During ENRICHMENT phase:**
   - Before creating StrictModeError, check if node has ignore annotation
   - If ignored, skip error creation but log suppression

3. **Add to JSASTAnalyzer:** Parse and attach ignore comments to AST nodes.

```typescript
// In JSASTAnalyzer
const GRAFEMA_IGNORE_PATTERN = /grafema-ignore(?:-next-line)?\s+([\w_]+)/;

// When creating CALL node, check preceding comment
if (precedingComment?.match(GRAFEMA_IGNORE_PATTERN)) {
  node.metadata.grafemaIgnore = {
    code: match[1],  // e.g., 'STRICT_UNRESOLVED_METHOD'
    comment: precedingComment,
    line: commentLine
  };
}

// In MethodCallResolver
if (context.strictMode) {
  if (methodCall.metadata?.grafemaIgnore?.code === 'STRICT_UNRESOLVED_METHOD') {
    // Log but don't error
    logger.debug('Suppressed strict mode error', {
      call: `${methodCall.object}.${methodCall.method}`,
      reason: methodCall.metadata.grafemaIgnore.comment
    });
    continue;
  }
  // ... create error as before
}
```

---

## Nice-to-Have Improvements

### Better Error Subcodes

Current: `STRICT_UNRESOLVED_METHOD` (too generic)

Proposed subcodes:
- `STRICT_UNKNOWN_RETURN_TYPE` - source function has no return type
- `STRICT_CLASS_NOT_IMPORTED` - class reference not in scope
- `STRICT_METHOD_NOT_FOUND` - class exists but method doesn't
- `STRICT_EXTERNAL_CALL` - call to external/library code
- `STRICT_CIRCULAR_ALIAS` - alias chain too deep

This requires extending the `StrictModeError` codes and updating `categories.ts`.

### Link to Documentation

Add URL to error output:
```typescript
// In DiagnosticReporter
formatStrict(diagnostic: Diagnostic): string {
  const docUrl = `https://grafema.dev/docs/strict-mode#${diagnostic.code}`;
  return `${formatted}\n\n  Docs: ${docUrl}`;
}
```

Note: Requires documentation to exist first. May defer to v0.3.

### Progressive Disclosure

Default output is brief. `--verbose` shows full chain.

```typescript
// In analyze.ts
const reporter = new DiagnosticReporter(diagnostics, {
  verbose: options.verbose,  // Controls chain display
});
```

---

## Risk Assessment

| Issue | Complexity | Risk | Notes |
|-------|------------|------|-------|
| Deduplicate errors | Low | Low | Clean separation of concerns |
| Context-aware suggestions | Medium | Medium | Requires tracking failure reason in resolvers |
| Show the chain | Medium | Low | Extension of existing context |
| grafema-ignore | Medium | Medium | Touches INDEXING and ENRICHMENT phases |

**Main risks:**
1. **grafema-ignore comment parsing** - Must handle edge cases (multi-line, nested)
2. **Chain tracking** - Performance impact if chains are deep
3. **Backward compatibility** - New error format must not break CI integrations

---

## Estimated Complexity

| Component | Effort |
|-----------|--------|
| Deduplicate (Issue 1) | 2-3 hours |
| Context-aware (Issue 2) | 4-6 hours |
| Show chain (Issue 3) | 3-4 hours |
| grafema-ignore (Issue 4) | 4-6 hours |
| Tests | 4-6 hours |
| Documentation | 2 hours |
| **Total** | **19-27 hours** (~3-4 days) |

---

## Implementation Order

1. **Issue 1: Deduplicate** - Enables cleaner testing of remaining issues
2. **Issue 3: Show chain** - Builds infrastructure for Issue 2
3. **Issue 2: Context-aware** - Depends on chain infrastructure
4. **Issue 4: grafema-ignore** - Independent, can be parallel

---

## Alignment with Grafema Vision

**"AI should query the graph, not read code."**

Strict mode exists to reveal product gaps - places where Grafema SHOULD resolve references but doesn't. Better error UX means:
1. Users understand WHY Grafema couldn't resolve (not just THAT it couldn't)
2. Users can add type information to help Grafema
3. Users can suppress false positives without abandoning strict mode

This keeps users engaged with the tool rather than giving up on strict mode entirely (Steve's concern in the demo review).

---

## Questions for User/Review

1. Should `grafema-ignore` require specifying the error code, or allow blanket suppression?
   - **Recommendation:** Require code (like ESLint) to prevent abuse

2. Should we add `--strict=warn` mode (warn but don't fail)?
   - **Recommendation:** Defer to v0.2 (nice-to-have from Steve's review)

3. Priority of documentation links - do we have docs infrastructure?
   - **Recommendation:** Defer until docs exist

---

## Next Steps

1. Joel to expand into detailed technical specification
2. Review by Steve + Vadim for vision alignment
3. Kent to write tests for new error format
4. Rob to implement

---

## Sources

- [Elm: Compiler Errors for Humans](https://elm-lang.org/news/compiler-errors-for-humans)
- [Elm: Compilers as Assistants](https://elm-lang.org/news/compilers-as-assistants)
- [Error Handling in Rust - LogRocket](https://blog.logrocket.com/error-handling-rust/)
- [Effective Error Handling in Rust CLI Apps](https://technorely.com/insights/effective-error-handling-in-rust-cli-apps-best-practices-examples-and-advanced-techniques)
- [ESLint Configure Rules](https://eslint.org/docs/latest/use/configure/rules)
- [Scalafix Suppression](https://scalacenter.github.io/scalafix/docs/users/suppression.html)

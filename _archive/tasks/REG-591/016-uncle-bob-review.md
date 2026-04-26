## Uncle Bob — Code Quality Review

**Verdict:** APPROVE

**File sizes:** OK with one note
**Method quality:** OK with one note
**Patterns & naming:** OK

---

### File Sizes

| File | Lines | Status |
|------|-------|--------|
| `packages/core-v2/src/types.ts` | 258 | OK |
| `packages/core-v2/src/walk.ts` | 687 | NOTE (see below) |
| `packages/core-v2/src/visitors/expressions.ts` | 1417 | Pre-existing — NOT introduced by this PR |
| `packages/core/src/plugins/domain/ExpressPlugin.ts` | 295 | OK |
| `packages/core/src/plugins/analysis/CoreV2Analyzer.ts` | 239 | OK |
| `packages/core/src/plugins/domain/index.ts` | 1 | OK |

`walk.ts` is at 687 lines, which crosses the 500-line warning threshold. This is a pre-existing condition — the PR added approximately 65 lines (WalkOptions, domain plugin hook, runDomainPlugins). The additions themselves are clean and well-contained. The file is not doing unrelated things: it is a single-purpose walk engine. Not blocking for this PR, but the file is a candidate for extraction in a future cleanup step.

`expressions.ts` at 1417 lines is well above the critical threshold, but this is entirely pre-existing. The PR added fewer than 20 lines to it (argValues extraction). No action required from this PR.

---

### Method Quality

**`runDomainPlugins` (walk.ts, lines 591–633):** 43 lines, 4 parameters. Length and parameter count are both acceptable. The function has a single responsibility: run plugins in sequence, merge results, catch errors. Clean.

**`visitCallExpression` (expressions.ts, lines 45–497):** This is a pre-existing 450-line function — the PR added approximately 16 lines to it (the argValues loop, lines 107–133). The addition itself is well-placed and properly commented. The function as a whole is too long, but that is outside the scope of this PR.

**`_findExpressVarNames` (ExpressPlugin.ts, lines 114–202):** 89 lines. This is the longest new method introduced by the PR. It is long, but it is doing exactly one thing: a two-phase BFS alias-chain resolution. The phases are clearly documented and separated by comments. The logic is non-trivial and correctly sized for what it does. Acceptable.

**`analyzeFile` (ExpressPlugin.ts, lines 34–88):** 55 lines. Single responsibility, clear linear flow. The early-return guard on line 39 is clean. Acceptable.

**`_processMountPoint` (ExpressPlugin.ts, lines 234–272):** 39 lines, 5 parameters. Parameter count of 5 is at the boundary. The `nodes` and `edges` parameters are mutable out-params (push targets). This is a known JS pattern for accumulation without allocation overhead, consistent with how the rest of the codebase works. Acceptable given the context.

---

### Patterns and Naming

**DomainPlugin / DomainPluginResult interfaces (types.ts):** Naming is precise and consistent with existing `VisitorFn`, `VisitorRegistry`, `WalkContext` conventions. JSDoc is thorough — the "when to use / when not to use" section is exactly the kind of documentation an LLM-first tool needs. The `readonly name` constraint is the right design: prevents accidental mutation, signals intent.

**WalkOptions (walk.ts):** Well-named, consistent with the rest of the codebase. Optional fields with sensible defaults applied inline. The approach of a parameter object over positional arguments is the right call here.

**argValues (expressions.ts):** The name is clear and direct. The comment block explaining the TemplateLiteral cooked/raw fallback is valuable — this is a subtle Babel type subtlety that would otherwise confuse future readers. The invariant (`argValues.length === call.arguments.length`) is stated in the implementation report and preserved in code by construction.

**DOMAIN_PLUGIN_REGISTRY (CoreV2Analyzer.ts):** Naming is precise. The constant is declared `Readonly<Record<string, DomainPlugin>>`, which is the correct type. The comment "Add new domain plugin implementations here" is the right guidance for future contributors.

**ExpressPlugin class (ExpressPlugin.ts):** Private helper names use the `_` prefix convention consistently. `_findExpressVarNames`, `_createHttpRouteNode`, `_createExpressMountNode`, `_processMountPoint` — all clear, unambiguous, verb-noun or verb-noun-noun. The `Phase 1` / `Phase 2` / `BFS` comments in `_findExpressVarNames` are load-bearing documentation for a non-trivial algorithm.

---

### No Forbidden Patterns

Scanned all six files for: `TODO`, `FIXME`, `HACK`, `XXX`, empty implementations (`return null`, `{}`), commented-out code, mock/stub/fake outside tests. None found.

---

### One Minor Note: Inline Long Object in expressions.ts

Line 148 in `expressions.ts` has a long inline object literal in the metadata spread:

```typescript
...((call.callee.type === 'MemberExpression' || call.callee.type === 'OptionalMemberExpression') && call.callee.property.type === 'Identifier'
  ? { method: call.callee.property.name, object: call.callee.object.type === 'Identifier' ? call.callee.object.name : call.callee.object.type === 'ThisExpression' ? 'this' : call.callee.object.type === 'Super' ? 'super' : undefined }
  : {}),
```

This is a pre-existing long line, not introduced by this PR. The PR's argValues addition does not make it worse. Not blocking.

---

### Summary

The PR is well-scoped and disciplined. The new code introduced by REG-591 is:

- Correctly sized (no unnecessary abstractions, no bloat)
- Well-named throughout
- Properly documented — especially the DomainPlugin interface JSDoc, which is exemplary
- Consistent with existing patterns in the codebase
- Free of forbidden patterns

The design decisions (WalkOptions parameter object, runDomainPlugins extracted helper, data-flow over heuristic, BFS alias resolution by node ID) are all sound and match the project's principles.

**APPROVE.**

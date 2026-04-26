# Uncle Bob PREPARE Review — REG-516 (Blast Radius Panel)

**Reviewer:** Robert C. Martin
**Date:** 2026-02-19
**Scope:** Pre-implementation file hygiene check for files touched by REG-516.

---

## File 1: `packages/vscode/src/extension.ts`

**Actual line count:** 652 lines.

**Status:** CRITICAL — exceeds the 700-line hard limit is NOT yet breached (652 < 700), but it already exceeds the 500-line MUST-SPLIT threshold. This file is in the danger zone. REG-516 will add approximately 15–25 more lines (import, provider instantiation, TreeView registration, command registration). That brings the projected post-task line count to roughly **670–675**. Still under 700, but the trajectory is wrong: every panel added to this extension lands more code here.

### activate() function

Lines 40–188. That is **148 lines** — well over the 50-line method limit.

The function does the following distinct things, in sequence:
1. Workspace root resolution and config read (lines 44–56)
2. ClientManager + EdgesProvider init (lines 58–62)
3. StatusProvider registration (lines 64–65)
4. DebugProvider registration (lines 68–69)
5. TreeView creation (lines 72–75)
6. ValueTraceProvider registration (lines 78–82)
7. HoverProvider registration (lines 85–94)
8. CallersProvider registration (lines 97–101)
9. IssuesProvider registration + diagnostics (lines 104–111)
10. CodeLensProvider registration (lines 114–123)
11. Selection tracker (lines 126–128)
12. stateChange event handler (lines 131–146)
13. reconnected event handler (lines 149–154)
14. registerCommands() call (line 157)
15. connect() call (lines 160–165)
16. context.subscriptions.push() (lines 168–185)

REG-516 will add another block into this sequence (BlastRadiusProvider registration).

### registerCommands() function

Lines 194–582. That is **388 lines** — severely over the 50-line limit. This function registers 17 commands inline, each with its own closure. It is already extracted (good), but it is itself a monolith.

### Cursor tracking functions

`findAndTraceAtCursor()` — lines 588–614, **26 lines**. Clean.
`findAndSetCallersAtCursor()` — lines 620–644, **24 lines**. Clean.
`deactivate()` — lines 649–652, **3 lines**. Clean.

Yes, these were already extracted from `activate()` — that was the right call. The same discipline should apply here.

### RECOMMENDATION: REFACTOR (targeted, safe)

**Action:** Extract panel registrations from `activate()` into a dedicated helper.

Specifically: the repeated pattern of `new XxxProvider(clientManager)` + `registerTreeDataProvider(...)` or `createTreeView(...)` + optional setup calls is duplicated 6 times inside `activate()`. Extract it into a single private function:

```typescript
function registerPanels(
  clientManager: GrafemaClientManager,
  workspaceRoot: string,
  context: vscode.ExtensionContext
): { /* named references the rest of activate() needs */ } { ... }
```

This function would contain the StatusProvider, DebugProvider, ValueTraceProvider, HoverProvider, CallersProvider, IssuesProvider, CodeLensProvider blocks — and after REG-516, the BlastRadiusProvider block too. The function returns the provider references that `activate()` and `registerCommands()` need to close over.

**Expected size reduction in activate():** approximately 80 lines, bringing it from 148 to ~65–70 lines. Still slightly over 50, but acceptable given the bootstrapping nature of the function.

**Risk:** LOW. Pure mechanical extraction. No logic changes. The module-level `let` variables already hold the provider references — `registerPanels()` can simply assign to them, or return them. The existing pattern of capturing providers in closures inside `registerCommands()` is already working; this does not change that.

**Time estimate:** 20–30 minutes. Appropriate for PREPARE (well under 20% of task time assuming a 2–3 hour implementation).

---

## File 2: `packages/vscode/src/types.ts`

**Actual line count:** 219 lines.

**Status:** WITHIN LIMITS. No methods, only type definitions and small pure utility functions (parseNodeMetadata, parseEdgeMetadata, formatNodeLabel, formatEdgeLabel — all under 10 lines each).

Adding the `BlastRadiusItem` union type will add approximately 10–15 lines. Projected: ~230 lines. Comfortable.

The existing pattern is consistent and well-documented: a comment block naming the section, JSDoc on the type, then the union type definition. Follow that pattern exactly.

### RECOMMENDATION: SKIP

No refactoring needed or warranted.

---

## File 3: `packages/vscode/src/codeLensProvider.ts`

**Actual line count:** 287 lines.

**Status:** WITHIN LIMITS.

The file will be modified to replace `grafema.blastRadiusPlaceholder` command IDs with `grafema.openBlastRadius`. That change touches four locations — all straightforward string replacements:
- Line 156: placeholder lens command in `buildPlaceholderLenses()`
- Line 199: fallback placeholder in `buildResolvedLenses()`
- Line 212: resolved lens command in `buildResolvedLenses()`
- Line 247: `buildCommand()` fallback return

Method sizes:
- `provideCodeLenses()`: lines 46–94, **48 lines** — just under limit, acceptable.
- `resolveCodeLens()`: lines 96–119, **23 lines** — clean.
- `buildPlaceholderLenses()`: lines 124–164, **40 lines** — acceptable.
- `buildResolvedLenses()`: lines 169–221, **52 lines** — 2 lines over limit. Not worth splitting; the structure is clear.
- `buildCommand()`: lines 226–251, **25 lines** — clean.
- `batchFetchCounts()`: lines 257–286, **29 lines** — clean.

### RECOMMENDATION: SKIP

No refactoring needed. The command ID replacement is surgical and low-risk.

---

## Summary

| File | Lines | Hard Limit | Recommendation |
|------|-------|-----------|----------------|
| `extension.ts` | 652 | 500 (MUST) / 700 (CRITICAL) | **REFACTOR** — extract `registerPanels()` before implementing |
| `types.ts` | 219 | 500 (MUST) | SKIP |
| `codeLensProvider.ts` | 287 | 500 (MUST) | SKIP |

## Risk Assessment

The `extension.ts` refactoring is the only action required. The risk is LOW:

1. All provider variables are already declared at module scope as `let X: XProvider | null = null`.
2. The extraction does not change any logic — only where the instantiation code lives.
3. The `registerCommands()` closures reference the module-level variables directly; that pattern is unchanged.
4. The context.subscriptions.push() call at the end of `activate()` stays in `activate()` — `registerPanels()` returns the disposables to push.

Do the refactor first. Then implement REG-516 inside the clean `registerPanels()` function. Do not add BlastRadiusProvider registration directly into the still-bloated `activate()`.

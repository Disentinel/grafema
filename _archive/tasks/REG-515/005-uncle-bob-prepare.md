## Uncle Bob PREPARE Review

---

**File:** `extension.ts` — 634 lines — OK (below 700, but worth watching)
**Methods to modify:** `activate()` (lines 38-174, ~136 lines) — add ~5 lines for IssuesProvider registration

**File-level:** The file is a single activation/registration file doing one job. Acceptable.
**Method-level:** `activate()` at ~136 lines is long, but it is a registration function — a linear sequence of setup calls with no branching logic. Adding one more provider registration (3-4 lines) does not meaningfully worsen it. `registerCommands()` at ~383 lines is large but is also a flat list of command registrations with no complex logic.

**Recommendation:** SKIP
**Risk:** LOW

---

**File:** `types.ts` — 200 lines — OK
**Methods to modify:** Add `IssueItem` union type (estimated 5-8 lines)

**File-level:** Clean. Groups related types by section (VALUE TRACE TYPES, CALLERS PANEL TYPES). The new `IssueItem` type belongs here as `// === ISSUES PANEL TYPES ===` following the established pattern.
**Method-level:** N/A — type declarations only.

**Recommendation:** SKIP
**Risk:** LOW

---

**File:** `package.json` — 325 lines — OK
**Methods to modify:** Add `onView:grafemaIssues` activation event, new commands for Issues panel, menu entries for `grafemaIssues` view title.

**File-level:** `grafemaIssues` view is already declared in `views` (line 36) with a placeholder `viewsWelcome` message (lines 44-49). The activation event is the only missing piece in `activationEvents`. The plan adds real commands to replace the placeholder welcome message — that is straightforward.
**Method-level:** N/A — JSON config.

**Recommendation:** SKIP
**Risk:** LOW

---

**File:** `callersProvider.ts` — 413 lines — OK (template to follow)
**Pattern notes:** Clear structure: constants at top, `isTestFile()` helper, class with private state, `getTreeItem()` as switch, `getChildren()` split into root / section / call-node cases, one private async fetcher, one free tooltip builder. The new `IssuesProvider` should follow this exact layout.

**Recommendation:** SKIP
**Risk:** LOW

---

**Summary:** All four files are clean. No refactoring needed before implementation. The IssuesProvider should mirror the `callersProvider.ts` structure: constants, helper functions, class with `getTreeItem()` switch and `getChildren()` dispatch, one private async fetcher. `IssueItem` type goes in `types.ts` under a new `// === ISSUES PANEL TYPES ===` section.

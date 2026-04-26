## Dijkstra Plan Verification — REG-517

**Verdict:** APPROVE with mandatory gap fixes before Rob begins

**Completeness tables:** 7 tables built for 7 classification rules

---

## Table 1: `node.exported` field — all possible states

The `WireNode` interface declares `exported: boolean` (non-optional, `rfdb.ts` line 77).
The `BaseNodeRecord` in `nodes.ts` declares `exported?: boolean` (optional).
At the wire level the field is always `boolean`. However nodes arriving from the graph via
`getNode()` are typed as `WireNode` with `exported: boolean`.

The plan uses:

```typescript
node.exported ? '  $(pass) exported' : ''
```

| exported value | Plan output       | Correct? |
|---------------|-------------------|----------|
| `true`        | `  $(pass) exported` | Yes    |
| `false`       | `''` (empty)      | Yes      |

No gap here — `WireNode.exported` is `boolean`, not `boolean | undefined`. The wire protocol
guarantees this. The plan is correct for Feature 1 (search label) and Feature 4 (node
description).

---

## Table 2: `node.file` field — all possible states

`WireNode.file` is declared as `string` (non-optional, `rfdb.ts` line 76).
`BaseNodeRecord.file` is `string | undefined` (optional), but that is the in-memory model
before serialization. On the wire it is always a string. Empty string `""` is legal.

| file value        | Feature 1 plan output     | Feature 4 plan output    | Correct? |
|-------------------|--------------------------|--------------------------|----------|
| Non-empty string  | `${node.file}${loc}`     | shown in parts array     | Yes      |
| Empty string `""` | `""${loc}` — visible gap | `parts.push("")` adds empty segment, joined to `"  exported"` or just `""` | PARTIAL |
| `undefined`       | `"undefined${loc}"`      | NOT possible per WireNode type, so skip | N/A |

**Gap 1:** Feature 4 description check is `if (element.node.file) parts.push(...)`, which
correctly guards against empty string (falsy). This is fine.
Feature 1 search label uses `${node.file}${loc}` unconditionally — if `file` is `""` the
description shows an empty-looking prefix, which is ugly but not broken. This is a cosmetic
gap, not a functional one. No hard fix required.

---

## Table 3: Feature 2 (edge type filter) — QuickPick cancel semantics

The plan's command handler:

```typescript
const picked = await vscode.window.showQuickPick(items, { canPickMany: true });
if (picked) {
  // update hidden set
}
```

`showQuickPick` with `canPickMany: true` returns:
- `QuickPickItem[]` (possibly empty array `[]`) when user confirms
- `undefined` when user presses Escape / dismisses without confirming

| User action           | `picked` value | Guard `if (picked)` | Result        | Correct? |
|----------------------|----------------|---------------------|---------------|----------|
| Confirms selection   | `QuickPickItem[]` (0..N items) | truthy for non-empty array; **falsy for empty array `[]`** | Empty array causes `if ([])` — `[]` is truthy in JS! So it IS handled. | Yes (JS truthiness applies) |
| Confirms with zero checked | `[]` | `if ([])` → true — ALL edge types hidden | Correct per UX, but potentially surprising | Acceptable |
| Presses Escape       | `undefined` | `if (undefined)` → false — no change | Correct |          |

**Gap 2:** When user confirms with ZERO items checked, `shown` is empty set, and ALL listed
edge types go into `hiddenEdgeTypes`. The tree will show zero edges. There is no safeguard
or warning. This is an extreme case where the explorer becomes empty with no visible reason
why. The plan does not address this state.

**Recommendation:** Add a guard: if `picked.length === 0`, show a warning or treat as
"cancel" or show a message. This is not a blocker but should be noted for Rob.

---

## Table 4: Feature 2 — edge types NOT in hardcoded list

The plan hardcodes 14 edge types in `COMMON_EDGE_TYPES`. The actual graph (`edges.ts`) has
~60 edge types, plus `| string` allows custom types from plugins.

| Edge type category                  | In hardcoded list? | Visible in Explorer after filter? |
|-------------------------------------|-------------------|----------------------------------|
| Common call/data flow types         | Yes (14 types)    | Filterable                       |
| `YIELDS`, `CAPTURES`, `DECLARED`    | No                | Always visible (cannot hide)     |
| Branching: `HAS_CASE`, `HAS_BODY`   | No                | Always visible                   |
| HTTP/Route: `ROUTES_TO`, `GOVERNS`  | No                | Always visible                   |
| Plugin-defined custom types         | No                | Always visible                   |

**Gap 3 (already acknowledged in plan):** Edge types not in the hardcoded list can never be
hidden. The plan correctly identifies this as a future enhancement. No bug, but the filter
UX is incomplete for projects that primarily use non-listed edge types (e.g., a PHP project
where `ROUTES_TO` and `GOVERNED_BY` dominate). This should be documented in the PR.

---

## Table 5: Feature 2 — filter state persistence

| Scenario                              | Plan behavior            | Correct? |
|---------------------------------------|--------------------------|----------|
| User sets filter, switches views      | In-memory `Set` retained | Yes      |
| Extension restart / VS Code restart   | In-memory state lost, resets to `new Set()` (show all) | Acceptable — plan does not promise persistence for filter |
| User sets filter, bookmark section shown | Filter applies only to edge fetching in `getChildren`, bookmark-section items not filtered | Yes |

The plan does NOT persist `hiddenEdgeTypes` to `workspaceState`. This is an intentional
scope limit and is acceptable for v1. However it is unstated. No hard gap.

---

## Table 6: Feature 3 (Bookmarks) — all tree states

The plan modifies `getChildren()` (root level, no element) to prepend bookmark-section when
`bookmarks.length > 0`.

| State                               | Root level returns               | Correct? |
|-------------------------------------|----------------------------------|----------|
| `bookmarks.length > 0`, `rootNode` set | `[bookmark-section, node]`   | Yes      |
| `bookmarks.length > 0`, `rootNode` null | `[bookmark-section]`        | Yes      |
| `bookmarks.length === 0`, `rootNode` set | `[node]`                   | Yes      |
| `bookmarks.length === 0`, `rootNode` null | `[]`                       | Yes — existing behavior |

**Gap 4:** When `rootNode` is null AND no bookmarks exist, `getChildren` returns `[]`. The
tree shows the welcome message via `treeView.message`. With the plan as written, the
bookmark-section guard `if (bookmarks.length > 0)` means this case is unchanged. Correct.

**Gap 5 (HARD): What happens when user clicks a bookmark item?**

The plan says bookmark items get a `grafema.gotoLocation` command (go to file) and an
inline `setAsRoot` button. But what does a single click do?

Current behavior for regular node items: click fires `grafema.gotoLocation` (if line
metadata available).

The plan says:
> `Click command: grafema.gotoLocation` if line metadata available.

But bookmarks are `WireNode` objects. A bookmark's metadata (line, column) must be
re-parsed via `parseNodeMetadata(node)` at display time. The plan shows:

```typescript
{ kind: 'bookmark'; node: WireNode; metadata: NodeMetadata }
```

The `metadata: NodeMetadata` field exists on the bookmark item type, which means the plan
intends to parse it at `getTreeItem` time. This is consistent with how `kind: 'node'` items
work. The plan does not show the `getTreeItem` implementation for `kind: 'bookmark'` — only
the field list. Rob will need to implement this. It follows the existing pattern but it is
unspecified.

**Recommendation:** Plan should explicitly state `getTreeItem` logic for `bookmark` kind.

---

## Table 7: Feature 3 — `workspaceState` data integrity

| Scenario                             | Plan behavior                    | Correct? |
|--------------------------------------|----------------------------------|----------|
| First activation, no stored data     | `workspaceState.get('grafema.bookmarks', [])` returns `[]` | Yes |
| Normal stored `WireNode[]`           | Load and display                 | Yes      |
| Corrupted JSON (workspaceState corrupt) | VS Code stores values via its own JSON serialization; `get()` returns the stored value or default. If the stored value is not a `WireNode[]` array, TypeScript type assertion fails silently — the in-memory `bookmarks` will be a corrupt value. | GAP |
| Data from a different schema version (old `WireNode` shape) | Old nodes may be missing `semanticId` or have extra fields — graceful, since `WireNode` is additive | Acceptable |
| Stored array exceeds 20 items        | Plan suggests max 20 but does NOT enforce it in `loadBookmarks()` — enforcement only in `addBookmark()`. If someone manually edits state or loads from a migration, the cap is bypassed. | Minor gap |

**Gap 6 (MODERATE):** The plan does not include a type guard or validation in `loadBookmarks()`.
If `workspaceState.get()` returns a non-array (due to corruption or version mismatch), the
code should fall back to `[]`. The plan uses:

```typescript
loadBookmarks() — reads from context.workspaceState.get<WireNode[]>('grafema.bookmarks', [])
```

TypeScript generics on `workspaceState.get<T>()` are a type assertion only — they do NOT
validate the shape at runtime. A guard like:

```typescript
const raw = context.workspaceState.get('grafema.bookmarks');
this.bookmarks = Array.isArray(raw) ? raw as WireNode[] : [];
```

...is needed to prevent a crash if `raw` is not an array. This is a **mandatory fix** before
implementation.

---

## Table 8: Feature 3 — `ExtensionContext` constructor change

The plan changes `EdgesProvider` constructor from:

```typescript
constructor(clientManager: GrafemaClientManager)
```

to:

```typescript
constructor(clientManager: GrafemaClientManager, context: vscode.ExtensionContext)
```

| Caller location          | Current call                          | Will break? |
|--------------------------|---------------------------------------|-------------|
| `extension.ts` line 63   | `new EdgesProvider(clientManager)`    | YES — must add `context` arg |
| Test files               | Don's plan checks — no `edgesProvider.test.ts` exists | No tests to break |
| Any other callers        | Grep: only one instantiation in extension.ts | No other callers |

Don correctly identifies that no test file for EdgesProvider exists. The single breakage
point is `extension.ts` line 63, and it is the same file being modified. This is safe.

---

## Table 9: Feature 4 — `'← path'` description conflict with improved labels

Current logic in `getTreeItem` for `kind: 'node'`:

```typescript
if (isOnPath) {
  item.iconPath = new vscode.ThemeIcon('debug-stackframe', ...);
  item.description = '← path';
} else {
  item.iconPath = getNodeIcon(element.node.nodeType);
  // description is currently NOT set
}
```

The plan adds, in the `else` branch:

```typescript
const parts: string[] = [];
if (element.node.file) parts.push(element.node.file);
if (element.node.exported) parts.push('exported');
item.description = parts.join('  ') || undefined;
```

| Node state        | Description before | Description after (plan) | Conflict? |
|-------------------|-------------------|--------------------------|-----------|
| On navigation path | `'← path'`       | `'← path'` (unchanged)   | No        |
| Not on path, file present, exported | `undefined` | `"src/auth/login.js  exported"` | No |
| Not on path, file present, not exported | `undefined` | `"src/auth/login.js"` | No |
| Not on path, file empty/absent | `undefined` | `undefined` (parts empty, fallback to undefined) | No |
| Bookmark item     | Plan sets `node.file` as description | Bookmark items are `kind: 'bookmark'` not `kind: 'node'` — separate code path | No |

No conflict. The `'← path'` description is in the `if (isOnPath)` branch that the plan does
not modify. This is clean.

**Gap 7 (cosmetic):** The plan notes "shorten file path to last 2 segments" and suggests a
`formatFilePath()` helper. However the plan's concrete code snippet uses `element.node.file`
directly without shortening:

```typescript
if (element.node.file) parts.push(element.node.file);
```

This contradicts the stated intent to show only last 2 segments. The plan text and the plan
code disagree. Rob must decide which to implement. If full paths are shown, long paths
(`packages/vscode/src/auth/middleware/handleLogin.ts`) will make tree items visually noisy.
This should be resolved explicitly.

---

## Gaps Found

### MANDATORY (must fix before implementation)

**Gap 6:** `loadBookmarks()` lacks a runtime type guard. If `workspaceState` contains a
non-array, the code will assign a corrupt value to `this.bookmarks`, causing crashes or
silent failures. Must use `Array.isArray()` guard.

### IMPORTANT (should address in implementation)

**Gap 2:** When user confirms the edge type filter QuickPick with zero items checked, ALL
edge types are hidden and the Explorer tree goes blank. There is no warning or recovery path
visible to the user. At minimum, a VS Code info message should appear: "All edge types
hidden. Use Filter Edge Types to restore."

**Gap 5:** The plan's bookmark `getTreeItem()` implementation is unspecified — only the
field types are listed. The `bookmark` kind behavior (label, description, command, icon)
is described in prose but no code is shown. Rob must infer this from the prose description.
This is a risk for inconsistency. The plan should include the concrete `getTreeItem` logic
for `kind: 'bookmark'`.

**Gap 7:** The plan text says "shorten to last 2 segments" but the plan code uses the full
`node.file` path. These are contradictory. The plan must pick one and make it explicit.

### MINOR (acceptable for v1)

**Gap 1:** Feature 1 search description shows `""` for nodes with empty file string.
Cosmetic only.

**Gap 3:** Edge types not in the hardcoded 14-type list cannot be filtered. Acknowledged in
plan as future work. Should be documented in the PR description.

---

## Precondition Issues

**Precondition 1 (unverified):** The plan asserts that `$(pass)` icon syntax works in
`QuickPickItem.description` for `createQuickPick()`. The existing search code uses
`$(symbol-*)` in `label` (which works), but ThemeIcon interpolation in `description` text
behaves differently across VS Code versions. No verification has been done. If it fails,
the exported badge will display as literal text `$(pass) exported`. This is ugly but not
broken.

**Precondition 2 (verified safe):** `workspaceState.get<T>(key, defaultValue)` is
correctly used for persistence. The VSCode API guarantees the default is returned when the
key is absent. HOWEVER (see Gap 6), the TypeScript generic `<T>` does not validate shape
at runtime.

**Precondition 3 (unverified):** Don states the `bookmark-section` tree item will be
collapsible with a count badge. The plan does not specify whether `TreeItemCollapsibleState`
is `Collapsed` or `Expanded` by default for the bookmark section. If it defaults to
`Collapsed`, first-time users will not see their bookmarks until they expand the section
manually. This is a UX decision that should be explicit in the plan.

**Precondition 4 (verified):** Don correctly identifies there is no `edgesProvider.test.ts`
file. I confirmed: the test directory contains `callersProvider.test.ts`,
`blastRadiusProvider.test.ts`, etc., but NO `edgesProvider.test.ts`. The constructor change
will not break existing tests. However this also means the new bookmark and filter
functionality will have NO test coverage, which violates the project's TDD principle.
Rob should write tests for `loadBookmarks()` with corrupt data, and for
`setHiddenEdgeTypes()` filtering behavior.

---

## Summary

The plan is architecturally sound and the four features fit cleanly within the existing
extension structure. The EdgesProvider constructor change has exactly one call site. The
bookmark persistence mechanism is correct in principle.

The mandatory fix (Gap 6: runtime type guard in `loadBookmarks`) is small and must be
added. The two important gaps (Gap 2: empty filter result, Gap 7: path shortening
contradiction) should be resolved before Rob begins. The precondition around TDD (no
tests planned) is the most significant structural concern relative to project standards.

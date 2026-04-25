# REG-515: Kent Beck Test Report

**Date:** 2026-02-19
**Author:** Kent Beck (Test Engineer)
**File created:** `packages/vscode/test/unit/issuesProvider.test.ts`

---

## Test Inventory

16 test scenarios implemented across 9 describe blocks:

| ID | Scenario | Describe Block |
|----|----------|---------------|
| T1 | Empty graph, connected -- "No issues found." status | empty states |
| T2 | Not connected -- "Not connected to graph." status | empty states |
| T3 | Error severity nodes only -- violations section, badge=count | severity grouping |
| T4 | Mixed severity -- 3 sections in correct order, badge=total | severity grouping |
| T5 | Only warning/info nodes -- only warnings section | severity grouping |
| T6 | Section children -- getChildren(section) returns issue items | section children |
| T7 | Issue item WITH location -- gotoLocation command with args | getTreeItem |
| T8 | Issue item WITHOUT location -- no command | getTreeItem |
| T9 | DiagnosticCollection populated -- set() called with URI, severity, source | DiagnosticCollection |
| T10 | DiagnosticCollection skips no-file nodes -- only clear() | DiagnosticCollection |
| T11 | DiagnosticCollection cleared on refresh | DiagnosticCollection |
| T12 | Reconnect clears cache, fires change event | reconnect behavior |
| T13 | Unknown category (plugin-defined) -- getAllNodes fallback, lands in warnings | unknown categories |
| T14 | Badge tooltip singular/plural/undefined | badge |
| T15 | Section item -- Expanded state, icon, description=count | getTreeItem |
| T16 | Malformed metadata -- no crash, lands in warnings | malformed metadata (Dijkstra GAP 4) |

---

## Mock Infrastructure

### Pattern
Followed the exact pattern from `callersProvider.test.ts`:
- Module resolution override via `Module._resolveFilename` to intercept `'vscode'`
- `require.cache['vscode']` with mock classes
- `require()` to import the module under test (not ESM import)

### Additional Mocks (beyond callersProvider.test.ts)

1. **`MockRange`** -- `vscode.Range` constructor with start/end positions. Required by `updateDiagnostics()`.
2. **`MockDiagnostic`** -- `vscode.Diagnostic` constructor with range, message, severity, source, code. Required by `updateDiagnostics()`.
3. **`DiagnosticSeverity`** -- enum mock `{ Error: 0, Warning: 1, Information: 2, Hint: 3 }`.
4. **`MockTreeView`** -- object with `badge` property (settable) and `dispose()`. Used to verify badge updates.
5. **`MockDiagnosticCollection`** -- object with `set()`, `clear()`, `dispose()` that tracks calls via `setCalls[]` and `clearCalls` counter.

### Mock Client
The `IRFDBClient` mock implements three methods used by `IssuesProvider`:
- `countNodesByType()` -- returns a configurable `Record<string, number>`
- `queryNodes(query)` -- async generator yielding nodes for a given `nodeType`
- `getAllNodes()` -- returns all nodes (fallback for unknown categories)

### Helper
`createIssueNode(overrides)` generates a minimal `WireNode` with issue-specific metadata (`severity`, `line`, `column`, `plugin`, `category`, `message`) encoded as JSON in the `metadata` field.

---

## Design Decisions

1. **T14 tests all three badge states in one test case** -- singular (1 issue), plural (3 issues), and undefined (0 issues). This is intentional: the three states are a single logical concern (badge formatting) and testing them together is more readable than three separate one-line tests.

2. **T16 uses `'issue:security'` nodeType with malformed metadata** -- this tests the interaction between a nodeType that would normally produce a violation (if severity were 'error') but with unparseable metadata. Since `parseNodeMetadata` returns `{}` and `metadata.severity` is `undefined`, the node falls to the "unknown severity -> warnings" default. This exercises the exact path Dijkstra flagged in GAP 4.

3. **DiagnosticCollection mocks track calls, not state** -- `setCalls[]` records every call to `set()` with its arguments. This allows tests to inspect what was passed without needing a full Map implementation. `clearCalls` is a simple counter.

4. **No `onDidChangeTreeData` subscription in most tests** -- only T12 (reconnect) explicitly subscribes to verify the event fires. Other tests verify behavior through `getChildren()` return values and mock state, which is more robust than event counting.

5. **`createProvider()` always sets treeView and diagnosticCollection** -- all tests get both injected by default. This ensures badge and diagnostic assertions work without extra setup. Tests that don't care about these (T2, T13) simply ignore the mock state.

---

## Gaps Addressed

- **Dijkstra GAP 4 (T16):** Malformed metadata JSON test added. Verifies the node lands in warnings (not violations), getTreeItem returns a valid item, and no exception is thrown.

## Dependencies

These tests import from `../../src/issuesProvider.js` (compiled output). Rob must implement `issuesProvider.ts` and run `pnpm build` in the vscode package before tests can execute.

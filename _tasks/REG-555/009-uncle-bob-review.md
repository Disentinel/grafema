## Uncle Bob — Code Quality Review

**Verdict:** APPROVE

---

### File sizes

**OK.**

| File | Lines | Status |
|------|-------|--------|
| `types.ts` | 1293 | OK (pre-existing, 2 lines added) |
| `PropertyAccessVisitor.ts` | 421 | OK |
| `CoreBuilder.ts` | 363 | OK |
| `property-access.test.ts` | 1224 | OK (test file, size is intentional) |

`bufferPropertyAccessNodes` is 79 lines (222–300). That is 9 lines over the 70-line guideline. However, the excess is entirely structural — the method has a single `for` loop with one `if/else if/else` block that cleanly maps three distinct cases (`this`, chained/import.meta, variable/parameter). The structure is cohesive, not bloated. Not a rejection — but noted.

---

### Method quality

**`bufferPropertyAccessNodes` — OK with one observation.**

The logic is readable. Three cases are clearly separated:
1. `objectName === 'this'` — links to CLASS node
2. `objectName === 'import.meta' || objectName.includes('.')` — explicit skip with explanatory comment
3. else — variable, then parameter fallthrough

The intentionally empty `else if` branch (case 2) is unusual. It uses an empty body to signal an intentional no-op, which is better than a comment-only path. The inline comment is adequate.

Max nesting depth is 7 indentation levels (inside `for → if → if → if → bufferEdge`). This is at the edge of comfort for readability, but it mirrors the identical pattern in `MutationBuilder.bufferObjectMutations` verbatim. Consistency with existing codebase patterns takes precedence here.

**`extractPropertyAccesses` — OK.**

`currentScopePath` is computed once outside the loop (`const currentScopePath = scopeTracker?.getContext().scopePath ?? []`). Correct — no redundant calls per loop iteration.

`enclosingClassName` is populated only when `info.objectName === 'this'`, which is the only case it is needed. The conditional is inline and tight.

---

### Patterns and naming

**OK. No violations found.**

- No `TODO`, `FIXME`, `HACK`, `XXX` in any file.
- No `as any` in the implementation files. (Test file uses `as unknown as { ... }` which is the correct typed narrowing pattern for opaque `NodeRecord` in test helpers.)
- No commented-out code.
- No empty implementations.
- Variable names (`fileBasename`, `classDecl`, `scopePath`, `objectName`, `currentScopePath`) are all accurate and consistent with established naming in the codebase.

---

### Specific checks

**`this.prop` lookup uses `basename()` correctly — PASS.**

Gap 3 identified by Dijkstra is correctly handled. The implementation uses:
```ts
const fileBasename = basename(propAccess.file);
const classDecl = classDeclarations.find(c =>
  c.name === propAccess.enclosingClassName && c.file === fileBasename
);
```
This mirrors MutationBuilder.ts lines 198–200 exactly. The comment explaining the asymmetry is present and accurate.

**`basename` import is from `'path'` — PASS.**

`import { basename } from 'path'` on line 8 of CoreBuilder.ts. All three other builders that use basename (`MutationBuilder`, `UpdateExpressionBuilder`, `TypeSystemBuilder`) also import from `'path'`, not `'node:path'`. Consistent with codebase convention.

**`ClassDeclarationInfo` is properly imported — PASS.**

Added to the type import block at line 22, grouped with other `Info` types. Import list is clean.

**`getEnclosingScope` call does NOT use `as any` — PASS.**

Call at PropertyAccessVisitor.ts line 172:
```ts
enclosingClassName: info.objectName === 'this' ? scopeTracker?.getEnclosingScope('CLASS') : undefined
```
`getEnclosingScope(scopeType: string): string | undefined` is a typed method. Optional chaining (`?.`) correctly handles the `scopeTracker | undefined` case. No cast required or present.

---

### Test quality

**OK.**

The six REG-555 tests in the `'READS_FROM edges for PROPERTY_ACCESS (REG-555)'` describe block test the right things:

1. **Variable access** — verifies the READS_FROM edge exists with correct src/dst IDs, not just node presence.
2. **Parameter access** — same rigour for PARAMETER target.
3. **`this.prop` to CLASS** — tests that `this.val` in the read context (`getVal()`) produces the edge, and correctly notes that the write context (constructor assignment) does NOT create a PROPERTY_ACCESS node.
4. **Chained access** — tests that only the base link (`a.b`) gets a READS_FROM edge, and the chained link (`a.b.c`) explicitly does NOT.
5. **Unknown identifier** — tests graceful degradation: node created, no edge, no crash.
6. **Module-level access** — tests the `scopePath=[]` case, which is the degenerate edge of the scope resolution path.

Error messages in `assert.ok` calls include the relevant edge list as JSON, which provides actionable failure output.

The use of `let` (not `const`) to force VARIABLE (not CONSTANT) nodes is documented inline with a comment explaining the reason. This shows understanding of the graph's type system.

No `TODO`, no commented-out tests, no placeholder assertions.

---

### Summary

The implementation is clean, consistent with codebase patterns, and addresses Dijkstra's Gap 3 (basename) correctly. The 79-line method is 9 lines over guideline but not a structural problem. Tests communicate intent clearly and test the observable graph edges rather than just node existence.

**APPROVE.**

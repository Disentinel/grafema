## Вадим auto — Completeness Review

**Verdict:** REJECT

**Feature completeness:** Issues found
**Test coverage:** Critical gap — new tests are not executable
**Commit quality:** OK

---

## Issues

### Issue 1: Tests are unreachable — CRITICAL

The 13 new column tests were added to `test/unit/plugins/analysis/ast/destructured-parameters.test.ts`, which is a **TypeScript file with no compiled output**.

The standard test runner:
```bash
node --test --test-concurrency=1 'test/unit/*.test.js'
```

This glob:
1. Does not recurse into subdirectories (no `**`)
2. Does not match `.ts` files

Additionally, `test/unit/plugins/analysis/ast/` has no tsconfig covering it — the root tsconfig explicitly excludes the `test/` directory. There is no tsx or ts-node setup that would compile and run these tests.

**Verified:** `test/unit/plugins/analysis/ast/` contains only `.ts` files. No `.js` compiled equivalents exist. Running the full test suite (`pnpm test`) does not include these tests.

**Result:** Zero executable tests verify the fix. The column=0 regression could reappear undetected.

**Fix required:** Either:
- Add an executable test in an existing `.js` test file (e.g., `test/unit/Parameter.test.js`), or
- Compile the test file and confirm it runs via the standard test command

---

### Issue 2: Snapshot tests deliberately exclude `column` — observation only

`test/helpers/GraphAsserter.js` has `'column'` in `SNAPSHOT_SKIP_PROPS` (line 402). This means integration-level snapshot tests cannot verify the column fix either. This is not a new gap introduced by REG-550 (snapshots also excluded `line` and `column` before), but it means no integration-level regression detection exists.

This is informational — the primary fix is Issue 1.

---

### Issue 3: `ParameterNode.validate()` false-positive for column=0 — low severity

In `packages/core/src/core/nodes/ParameterNode.ts`, the `validate()` method uses `!nodeRecord[field]` (line 65) to check required fields. For `column = 0` (first parameter in a function at column 0), `!0 === true` would report a false "Missing required field: column" error.

`ParameterNode.validate()` is not called in any production path — it is dead code. This issue has no runtime impact. However, it is a latent correctness bug in the node definition introduced by REG-550 adding `column` to `REQUIRED` without updating the validation guard.

---

## Summary

The implementation is mechanically correct — `column` is properly captured from AST nodes in all 5 parameter creation cases in `createParameterNodes.ts`, and in the parallel path in `ASTWorker.ts`. The data flows correctly through `GraphBuilder._bufferNode()` → `RFDBServerBackend.addNodes()` → stored as `metadata` JSON → recovered in `_parseNode()` via `safeMetadata` spread.

The fatal gap is that the tests verifying this fix are not executable. The acceptance criteria requires "Unit test: function with multiple params, each gets correct column" — 13 tests were written but zero can be run.

**Required fix before approval:** Move at least the core column tests to an executable `.js` test file, or establish a path to run `.ts` tests in `test/unit/plugins/analysis/ast/`.

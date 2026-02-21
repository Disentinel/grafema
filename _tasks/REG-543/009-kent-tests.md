# REG-543: Kent Beck Test Report

## Test file

`packages/cli/test/impact-polymorphic-callers.test.ts`

## Patterns found in existing tests

### Source of truth: `impact-class.test.ts`

The existing impact test file (`packages/cli/test/impact-class.test.ts`) established the canonical pattern:

- **Test framework:** `node:test` (`describe`, `it`, `beforeEach`, `afterEach`)
- **File extension:** `.ts` (run via `node --import tsx --test test/*.test.ts`)
- **CLI invocation:** `spawnSync('node', [cliPath, ...args])` with `NO_COLOR=1` env
- **Fixture setup:** `mkdtempSync` for temp dirs, `writeFileSync` for fixture source files
- **Lifecycle:** `beforeEach` creates temp dir, `afterEach` removes it with `rmSync`
- **Project setup:** write source files + `package.json`, then `runCli(['init'])` + `runCli(['analyze', '--auto-start'])`
- **Assertions on text output:** regex match for `(\d+)\s+direct\s+callers`, `output.includes('functionName')`
- **Assertions on JSON output:** parse `result.stdout` with `JSON.parse()`, check `parsed.directCallers`, `parsed.target`, etc.
- **Timeout:** `{ timeout: 60000 }` on the top-level `describe`

### Confirmed details from `tsconfig.json`

Tests are NOT compiled by TypeScript. The `rootDir` is `./src` and `include` is `src/**/*`. Tests run directly via `tsx` loader: `node --import tsx --test test/*.test.ts`.

## What I wrote and why

### 6 test groups, 11 test cases

| # | Group | Purpose | Key assertions |
|---|-------|---------|---------------|
| 1 | JS class hierarchy | Primary REG-543 fix: subclass method called via untyped param | `useGraph` appears as caller; NOT `0 direct callers`; JSON `directCallers > 0` |
| 2 | Unresolved call fallback | No hierarchy present, pure `findByAttr` path | `useGraph` found via method name match; NOT `0 direct callers` |
| 3 | Known false positives | Two unrelated classes with same method name | Command doesn't crash; valid output produced; does NOT assert `useTree` is absent |
| 4 | CLASS target regression | `grafema impact "class GraphBackend"` | Valid JSON; target name correct; `directCallers >= 1` |
| 5 | Qualified name resolution | Bare vs. prefixed method name (`addNode` vs `function addNode`) | Both forms produce output referencing `addNode` |
| 6 | No callers (zero case) | Method exists but nobody calls it | Correctly shows `0 direct callers`; no false positives from expansion |

### Design decisions

1. **Separate `initAndAnalyze` helper** -- extracted the repeated init+analyze pattern into a shared helper since all test groups need it. The per-group `setupXxxProject` functions handle fixture-specific file creation.

2. **Test 3 does NOT assert absence of false positives** -- Per Don's v3 plan, `findByAttr` is intentionally broad. `useTree` WILL appear as a caller of `addNode` even though it calls `TreeBackend.addNode`, not `GraphBackend.addNode`. This is documented in the test with a comment explaining why.

3. **Test 6 added beyond the plan** -- Guards against over-expansion. If nobody calls `unusedMethod` at all, `findByAttr` should also find nothing, and the result should be `0 direct callers`. This prevents false positive regression in the other direction.

4. **No TypeScript interface test** -- The plan's Test 4 (TypeScript interface scenario with `IStorage`) was considered but omitted. The existing test infrastructure runs fixture files through `grafema analyze` which uses `JSASTAnalyzer`. TypeScript interface analysis requires the TypeScript visitor path AND correct IMPLEMENTS edge creation. This is a separate concern from the core REG-543 fix (which is about the `impact.ts` command logic, not the analyzer). Adding a TS interface fixture risks testing the analyzer rather than the impact command. If TypeScript interface support needs testing, it should be a separate test file focused on the analyzer's IMPLEMENTS edge creation.

5. **Matched `impact-class.test.ts` structure exactly** -- Same imports, same `runCli` helper signature, same `spawnSync` approach, same `beforeEach`/`afterEach` lifecycle, same assertion patterns.

## Concerns about testability

1. **Fixture sensitivity to analyzer behavior** -- These tests depend on the analyzer creating specific graph structures (CLASS nodes, FUNCTION nodes with correct names, CONTAINS edges, DERIVES_FROM edges). If the analyzer changes how it handles JS class hierarchies or method names, these tests could break even if the impact command logic is correct. This is inherent to integration testing.

2. **findByAttr query depends on CALL node attributes** -- The `findByAttr({ nodeType: 'CALL', method: 'addNode' })` fallback requires that the analyzer creates CALL nodes with a `method` attribute. If this attribute is named differently or missing, the fallback won't find anything. I verified by reading `impact.ts` that the existing code uses this exact query pattern.

3. **Method name ambiguity in findTarget** -- When running `grafema impact "addNode"`, `findTarget` iterates all FUNCTION nodes and returns the first one with a matching name. In Test 1 and Test 5, there are TWO functions named `addNode` (one in `GraphBackend`, one in `RFDBServerBackend`). Which one `findTarget` returns depends on iteration order. However, `expandTargetSet` should expand to include the other one regardless of which is found first, so the test assertions are robust to this.

4. **Test runtime** -- Each test group runs `grafema init` + `grafema analyze` which spawns the RFDB server. With 11 tests, total runtime could be 30-60 seconds. The 60-second timeout on the top-level `describe` should be sufficient since each individual test takes ~3-5 seconds.

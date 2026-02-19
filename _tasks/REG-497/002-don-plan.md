# Don's Plan: REG-497 — Add onProgress to validation plugins

## Assessment

**Config:** Mini-MLA (mechanical pattern application across 10 files)

This is a straightforward task: replicate BrokenImportValidator's `onProgress` pattern to 10 other validators. No architectural decisions needed — the pattern is well-established.

## Reference Pattern (BrokenImportValidator)

```typescript
const { graph, onProgress } = context;
// ...
if (onProgress && counter % INTERVAL === 0) {
  onProgress({
    phase: 'validation',
    currentPlugin: 'PluginName',
    message: `Description ${counter}/${total}`,
    totalFiles: total,
    processedFiles: counter,
  });
}
```

- `onProgress` comes from `context` (PluginContext)
- `onProgress` type: `(info: Record<string, unknown>) => void`
- Report every N items (validators are faster → 200-500 interval per task description)

## Plan per Validator

### 1. CallResolverValidator
- **Loop:** `for await (const node of graph.queryNodes({ nodeType: 'CALL' }))` — iterates ALL CALL nodes
- **Action:** After `summary.totalCalls++`, report every 500 items
- **Message:** `Resolving calls ${summary.totalCalls}/...` (no total available from stream, use counter only)
- **Note:** Stream-based iteration — no total count known upfront. Use `processed` counter without total.

### 2. EvalBanValidator
- **Loops:** 3 separate `queryNodes({ nodeType: 'CALL' })` loops
- **Action:** Add a single counter across all 3 loops, report every 500
- **Alternative:** Since all 3 loops iterate the same CALL nodes, these could be merged. BUT that's refactoring outside scope. Just add counters to each loop separately.
- **Message:** `Checking eval patterns (pass N/3): ${counter} calls scanned`

### 3. SQLInjectionValidator
- **Loops:** 2 — collection loop (gathers sqlCalls[]), analysis loop (analyzes each)
- **Action:** Report in both: collection (every 500) and analysis (every 100, since each involves graph traversal)
- **Message:** `Scanning for SQL calls: ${counter}` then `Analyzing SQL calls: ${i}/${sqlCalls.length}`

### 4. AwaitInLoopValidator
- **Loop:** `for await (const node of graph.queryNodes({ nodeType: 'CALL' }))` — stream
- **Action:** Add counter, report every 500
- **Message:** `Checking await-in-loop: ${counter} calls scanned`

### 5. ShadowingDetector
- **Loops:** 4 collection loops (CLASS, VARIABLE, CONSTANT, IMPORT) + 2 analysis loops
- **Action:** Report during collection (combined counter, every 500) and during cross-file check (every 500)
- **Message:** `Collecting declarations: ${counter}` then `Checking shadowing: ${i}/${total}`

### 6. GraphConnectivityValidator
- **Loops:** Node collection (all nodes) + BFS traversal
- **Action:** Report during collection (every 500) and BFS (every 1000 — BFS can be very large)
- **Message:** `Collecting nodes: ${counter}` then `BFS traversal: ${reachable.size} nodes reached`

### 7. DataFlowValidator
- **Loops:** Collection (VARIABLE + CONSTANT) + main validation loop
- **Action:** Report during validation loop every 200
- **Message:** `Validating data flow: ${i}/${variables.length}`

### 8. TypeScriptDeadCodeValidator
- **Loops:** Interface collection + interface analysis
- **Action:** Report in analysis loop every 200
- **Message:** `Checking interfaces: ${checked}/${interfaces.size}`

### 9. UnconnectedRouteValidator
- **Loop:** `for await (const node of graph.queryNodes({ type: 'http:route' }))` — stream
- **Action:** Add counter, report every 200 (route count is usually small)
- **Message:** `Checking routes: ${counter} routes scanned`

### 10. PackageCoverageValidator
- **Loops:** Import collection loop + issue reporting loop
- **Action:** Report in collection loop every 500
- **Message:** `Scanning package imports: ${counter}`

## Common Implementation Rules

1. Destructure `onProgress` from `context` at the top of `execute()` (like BrokenImportValidator)
2. For stream-based iteration (no upfront total): report counter only, no total
3. For array-based iteration (total known): report `counter/total`
4. Interval: 200 for small collections (routes, interfaces), 500 for large ones (all CALL nodes)
5. Always guard with `if (onProgress && counter % INTERVAL === 0)`
6. Use `phase: 'validation'` and `currentPlugin: ClassName` consistently

## Files to modify

All in `packages/core/src/plugins/validation/`:
1. `CallResolverValidator.ts`
2. `EvalBanValidator.ts`
3. `SQLInjectionValidator.ts`
4. `AwaitInLoopValidator.ts`
5. `ShadowingDetector.ts`
6. `GraphConnectivityValidator.ts`
7. `DataFlowValidator.ts`
8. `TypeScriptDeadCodeValidator.ts`
9. `UnconnectedRouteValidator.ts`
10. `PackageCoverageValidator.ts`

## Testing

No dedicated unit tests needed — `onProgress` is a fire-and-forget callback. Existing tests should pass unchanged since `onProgress` is optional and only fires when provided.

Run: `pnpm build && node --test --test-concurrency=1 'test/unit/*.test.js'`

## Skip STEP 2.5 (refactoring)

All validators are already clean and readable. No refactoring needed — just adding the pattern mechanically.

## Uncle Bob — Code Quality Review

**Verdict:** APPROVE

---

**File sizes:** OK

`ExternalCallResolver.ts` is 319 lines. Well within limits. No split needed.
`ExternalCallResolver.test.js` is 1700 lines, which is large, but test files are allowed to be comprehensive — each test is independent and self-contained.

---

**Method quality:** OK with one minor note

**`execute()` (~85 lines)** — Clean orchestrator. Delegates all real work to private methods. Reads as a numbered procedure: build index, collect calls, seed existing modules, resolve each call, report. The counter variables (`nodesCreated`, `edgesCreated`, `handledByEdgesCreated`, `callsProcessed`, `externalResolved`, `builtinResolved`) could technically be grouped into a stats object to reduce noise, but this is a minor style point, not a defect. The method does not violate SRP.

**`buildImportIndex()` (~18 lines)** — Tight, single-purpose. Does exactly one thing: stream IMPORT nodes, filter to non-relative only, index by `file:local`. Clear and correct.

**`collectUnresolvedCalls()` (~19 lines)** — Tight and focused. Streams CALL nodes, applies two filters (skip method calls, skip already-resolved), accumulates result. The async graph query per node for edge-check is a potential N+1 concern at scale, but that is an architectural concern for a future performance issue, not a code quality defect here.

**`resolveCall()` (~82 lines)** — Reasonable. The method has five distinct exit paths (missing data, builtin, dynamic, no import match, no package name), each documented by the discriminated union return type. The discriminated return type (`'external' | 'builtin' | 'unresolved'`) is the right pattern — it forces callers to handle all cases. One note: `handledByCreated` is a `0 | 1` integer used as a boolean count, then summed in the caller. This works but is a minor conceptual awkwardness. Not a blocker.

**`extractPackageName()` (~20 lines)** — Clean and complete. Handles all four documented cases (simple, scoped, subpath, scoped subpath) with clear branching. The JSDoc comment accurately describes behavior.

---

**Patterns and naming:** OK

The file follows the established plugin pattern faithfully: `Plugin` base class, `get metadata()`, `async execute(context)`, `createSuccessResult()`. The private helper method pattern (`buildImportIndex`, `collectUnresolvedCalls`, `resolveCall`) is consistent with how `FunctionCallResolver` is structured.

Naming is clear throughout. `importIndex`, `callsToProcess`, `createdExternalModules`, `externalModuleId`, `exportedName`, `handledByCreated` — all names communicate intent without abbreviation or ambiguity.

The `// === SECTION ===` separator convention matches the rest of the codebase.

---

**Test quality:** OK

Tests are well-structured with clear `describe` groupings: External Package Calls, Built-ins, Unresolved Calls, Skip Conditions, Mixed, HANDLED_BY Edges, Edge Cases, Idempotency, Plugin Metadata. Each test sets up its own isolated backend, runs the plugin, and tears down in `finally`. Coverage is thorough — happy paths, negative assertions, aliased imports, type-only imports, multi-file isolation, idempotency, and the documented known limitation (re-exported externals).

One pattern worth noting: every test opens with `if (!ExternalCallResolver) { console.log('SKIP: ...'); return; }`. This guard is appropriate for TDD-first test files where the implementation was written after the tests. It is not production code and causes no harm.

---

**Summary**

The refactoring is a solid extract-method exercise. `execute()` is now a clean orchestrator. The three extracted methods each have clear, narrow responsibility. The new `HANDLED_BY` edge creation is properly isolated inside `resolveCall()` with correct type-guard logic (`importBinding !== 'type'`). No duplication introduced. No forbidden patterns. No technical debt added.

APPROVE.

## Dijkstra Correctness Review

**Verdict:** APPROVE

**Functions reviewed:**

| Scope | Verdict |
|---|---|
| `run()` — plugin registry construction (line 131) | PASS |
| `run()` — custom plugin merge (lines 134–136) | PASS |
| `run()` — plugin lookup `if (builtinPlugins[name])` (line 142) | PASS |
| `run()` — factory invocation and cast `() as Plugin` (line 143) | PASS |
| `run()` — `else if (customPlugins[name])` branch (lines 144–146) | DEAD CODE — pre-existing, unchanged |
| Import graph — `analysis-worker.ts` → `./config.js` → `@grafema/core` | PASS |

---

**Issues found:**

**None that are introduced by this change.**

---

**Reasoning by enumeration:**

**1. Falsy factory values (line 142: `if (builtinPlugins[name])`)**

Every value in `BUILTIN_PLUGINS` is an arrow function of the form `() => new SomeClass()`. Arrow functions are always truthy. The custom plugin path (lines 134–136) stores `() => new PluginClass()` — also an arrow function, always truthy. There is no path by which a key in `builtinPlugins` can hold a falsy value. The guard is safe.

**2. Spread creates a proper mutable copy (line 131)**

`{ ...BUILTIN_PLUGINS }` performs a shallow copy of the `BUILTIN_PLUGINS` object. The values are function references — shallow copy is sufficient because functions are not mutated, only the container object is written to (lines 134–136 add new keys). `BUILTIN_PLUGINS` is never modified. The copy is independent. This is correct.

**3. Type safety of `as Plugin` cast (line 143)**

The declared type of `builtinPlugins` is `Record<string, () => unknown>` (line 131). The cast to `Plugin` at line 143 suppresses the `unknown` return. At runtime, every factory in `BUILTIN_PLUGINS` returns `new SomeConcreteClass()` where each class implements `Plugin` (verified by the import list in `config.ts`, all originating from `@grafema/core`). Custom plugin factories are stored as `() => new PluginClass()` where `PluginClass` is typed `new () => Plugin` (line 98 in `analysis-worker.ts`). The cast is safe for all reachable inputs.

**4. Import cycle**

The dependency chain is:

```
analysis-worker.ts
  → ./config.js  (imports BUILTIN_PLUGINS)
      → @grafema/core  (imports plugin classes + loadConfig + GrafemaConfig)
  → @grafema/core  (imports Orchestrator, RFDBServerBackend, ParallelConfig, Plugin)
```

Both `analysis-worker.ts` and `config.ts` import from `@grafema/core`, but neither imports from the other's dependents. `config.ts` does not import from `analysis-worker.ts`. There is no cycle.

**5. Dead code branch `else if (customPlugins[name])` (lines 144–146)**

This branch is unreachable. Custom plugins are registered into `builtinPlugins` at lines 134–136 under their class name. At line 142, `builtinPlugins[name]` will already match any custom plugin name, so the `else if` at line 144 can never be entered. However, this dead code is **pre-existing** — it existed before this change with the same logical structure — and is outside the scope of this task. Its presence here causes no incorrect behavior; it is simply never executed.

**6. Behavioral equivalence to the previous inline map**

The old inline `builtinPlugins` map listed the same set of plugin constructors. `BUILTIN_PLUGINS` in `config.ts` is a superset-compatible replacement: same keys, same factory pattern. The spread copy at line 131 faithfully replicates what the inline definition achieved, plus gains future plugin additions automatically.

**Summary:** The change is correct. It removes duplication without introducing any new defect. All correctness properties hold by enumeration.

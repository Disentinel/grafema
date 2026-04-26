# Steve Jobs Review: REG-386 Plan

## Verdict: APPROVE

## Reasoning

This is one of the most architecturally clean proposals I have reviewed. It directly serves the project vision -- "AI should query the graph, not read code" -- and it does so by making Grafema self-describing. The user literally could not answer "What does HTTPConnectionEnricher do?" using Grafema, which is embarrassing for a tool whose entire thesis is that the graph should be the way to understand code. This fixes that.

### Complexity Checklist -- PASSED

1. **Iteration space:** O(p) where p = number of plugins (20-35). This is a tiny, fixed set. No scanning of graph nodes. No O(n) anywhere. This is the ideal case.

2. **Plugin architecture:** This is **forward registration** at its purest. The Orchestrator already has the plugin list in memory. It writes metadata to the graph before analysis begins. No backward scanning, no pattern matching, no searching. The data flows forward from the source of truth (the plugin instances) into the graph.

3. **Extensibility:** Adding a new plugin automatically gets a `grafema:plugin` node -- zero changes to the registration code. Custom plugins from `.grafema/plugins/` are handled identically. This is the correct abstraction.

4. **No brute-force:** Confirmed. The proposal iterates only the plugin list, not the graph.

### Architectural Alignment -- STRONG

The plan follows existing patterns precisely:

- **Node contract class** (`PluginNode.ts`) follows the exact pattern of `GuaranteeNode.ts` and `IssueNode.ts` -- static class with `create()`, `validate()`, `parseId()`, `generateId()`. This is not an invention; it is pattern reuse.

- **NodeFactory.createPlugin()** delegates to `PluginNode.create()` and wraps with `brandNode()`, exactly like every other factory method. The validate() extension follows the existing dynamic type check pattern (alongside `IssueNode.isIssueType()`).

- **Namespaced type** `grafema:plugin` follows the established convention (`guarantee:*`, `issue:*`, `http:*`, etc.). The `isGrafemaType()` helper mirrors `isGuaranteeType()`.

- **ID format** `grafema:plugin#HTTPConnectionEnricher` follows the `guarantee:queue#orders` and `issue:security#hash` patterns. Plugin names are unique within a pipeline, so no hash is needed -- this is correctly identified.

- **DEPENDS_ON edges** reuse an existing edge type. No new edge types invented.

### The Plan is Grounded in Reality

I verified every codebase reference in both Don's and Joel's plans:

- `PluginMetadata` interface (line 40 of `packages/types/src/plugins.ts`) -- confirmed. Has `name`, `phase`, `priority`, `creates`, `dependencies` exactly as described.
- `NAMESPACED_TYPE` in `NodeKind.ts` (lines 56-92) -- confirmed. The plan correctly identifies where to add the new constant.
- `NodeFactory.validate()` (lines 669-713) -- confirmed. The validators map and the dynamic `IssueNode.isIssueType()` check are where the plan says they are.
- `Orchestrator.run()` (line 220) -- confirmed. The graph clear block (lines 232-237) and the subsequent progress call are the correct insertion point.
- `Orchestrator.runMultiRoot()` (line 482) -- confirmed. The graph clear block (lines 489-493) needs the same registration call.
- `nodes/index.ts` exports (line 52-69) -- confirmed. The plan correctly identifies where to add exports.
- `core/index.ts` exports (lines 130-144) -- confirmed. The `isGuaranteeType` export on line 131 is the correct place to add `isGrafemaType`.
- `query.ts` `parsePattern()` (lines 236-273) -- confirmed. The `typeMap` is exactly as shown. The plan correctly identifies this as the place for the `plugin` alias.

### What Convinced Me to Approve

1. **This is dogfooding the product vision.** The user was doing Grafema work and had to read source files because Grafema could not answer questions about itself. The fix is to put the metadata into the graph where it belongs. This is not a feature -- it is filling a vision gap.

2. **Minimal surface area.** ~240 lines of production code, ~305 lines of tests. All following established patterns. No new abstractions, no new subsystems, no new dependencies. This is extending existing infrastructure, which is exactly what the "Reuse Before Build" principle demands.

3. **The data is already there.** Every plugin already declares `PluginMetadata` with phase, priority, creates, and dependencies. This data is computed at runtime but never persisted to the graph. The plan simply writes it to the graph. There is no data to invent or compute -- only data to expose.

4. **Query infrastructure needs zero changes.** Once `grafema:plugin` nodes are in the graph, existing `grafema query --type grafema:plugin` and `grafema query --raw` Datalog queries work immediately. The optional `plugin` type alias in `parsePattern()` is a convenience, not a requirement.

## Issues Found

### Minor Issue 1: PluginNodeRecord Duplication

The plan defines `PluginNodeRecord` in two places -- once in `packages/core/src/core/nodes/PluginNode.ts` (Step 2) and once in `packages/types/src/nodes.ts` (Step 9). These are independent interface definitions that must stay in sync. This is the same pattern used by `GuaranteeNodeRecord` (defined in both `GuaranteeNode.ts` and `types/nodes.ts`), so it follows precedent, but it is worth noting as a maintenance concern.

**Verdict:** Acceptable. Follows existing pattern. Not a blocker.

### Minor Issue 2: Empty `file` Field for Built-in Plugins

For built-in plugins, the `file` field will be empty string. The plan acknowledges this as Risk #1 and recommends deferring source file resolution for builtins. I considered whether this defeats the acceptance criteria ("return its source file path and line").

However: the acceptance criteria says "can locate a plugin by name and return its source file path." The primary value is locating by name and getting metadata (phase, creates, dependencies). The source file for builtins is computable from the convention `packages/core/src/plugins/{phase}/{ClassName}.ts` -- and this can be added trivially in a follow-up without architectural changes. The empty string does NOT defeat the feature for >50% of use cases because the metadata (what the plugin does, what it creates, what it depends on) is the critical queryable data.

**Verdict:** Acceptable for initial implementation. Does not defeat the feature's purpose.

### Minor Issue 3: Test Accesses Private Method

The `OrchestratorPluginNodes.test.ts` calls `(orchestrator as any).registerPluginNodes()` directly. This is a pragmatic choice -- testing the private method in isolation avoids needing a full analysis run. However, there should also be an integration test that verifies plugin nodes appear after a real `orchestrator.run()` call, even if it is a minimal one. The current test plan does not include this.

**Verdict:** Not a blocker for plan approval. Kent should consider adding a minimal integration test during implementation.

## Recommendations

1. **Implementation order is correct.** Types first, then contract, then factory, then Orchestrator integration, then query support. TDD at each boundary. No objections.

2. **The `plugin` type alias decision is correct.** NOT adding `grafema:plugin` to the default search types is the right call. Plugin nodes should only appear when explicitly requested. Users searching for "HTTP" do not want plugin metadata in their results.

3. **Consider a follow-up issue** for built-in plugin source file resolution. It is a natural enhancement: compute `packages/core/src/plugins/{phase_lowercase}/{ClassName}.ts` in `registerPluginNodes()` when `builtin` is true. This should be a separate ticket, not scope creep for REG-386.

4. **The `isGrafemaType()` helper is forward-looking.** When Grafema adds more self-describing nodes (e.g., `grafema:rule` for Datalog rules, `grafema:config` for configuration), this helper will already work for them. Good anticipation without over-engineering.

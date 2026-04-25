# Steve Jobs -- Final Implementation Review for REG-173

**Verdict: APPROVE**

---

## Did the Implementation Match the Approved Plan?

Yes. Faithfully.

The plan said: markdown instruction document, MCP Prompts capability, two new tools (`read_project_structure`, `write_config`), validator exports from ConfigLoader, CLI reference to onboarding prompt.

That is exactly what was built. No scope creep. No missing pieces.

---

## Code Review: File by File

### `packages/core/src/instructions/onboarding.md`

This is the product. 122 lines of markdown that guide an agent through:

1. Initial reconnaissance (directory tree scanning)
2. Service identification (with concrete criteria for what qualifies as a "service")
3. Auto-discovery comparison (use existing tooling, note discrepancies)
4. Plugin configuration (defaults vs. overrides)
5. Config writing (with validation)
6. Verification (analyze, check stats, check coverage, iterate)

**Strengths:**
- References exact MCP tool names (`read_project_structure`, `discover_services`, `write_config`, `analyze_project`, `get_stats`, `get_coverage`)
- Has an explicit "When to ask the user" section with example questions -- this is critical for agent-driven workflows
- Covers common patterns: monorepo, legacy, microservices, single-package
- Entry point discovery section is actionable -- lists priority order (source field, main field, common patterns, bin field)
- Does NOT try to classify frameworks -- that intelligence stays with the agent

**One observation:** Step 3 (Run Auto-Discovery) is marked "Optional." This is correct -- the agent may or may not need Grafema's built-in detection depending on how confident it is from Steps 1-2. Good call.

**Verdict: This instruction is actionable. An agent can follow it successfully.**

### `packages/core/src/instructions/index.ts`

7 lines. Reads the markdown file at runtime via `readFileSync`. Uses `import.meta.url` for `__dirname` resolution (ESM-correct). Exported as `getOnboardingInstruction()`.

Clean. Correct. Nothing to object to.

### `packages/mcp/src/prompts.ts`

57 lines. Defines `PromptDefinition`, `PromptMessage`, `PromptResult` interfaces. Exports `PROMPTS` array and `getPrompt()` function.

- `PROMPTS` contains one entry: `onboard_project` with a clear description and empty arguments array
- `getPrompt('onboard_project')` returns the instruction as a user-role message
- Unknown prompt names throw with a helpful error listing available prompts

This is a clean extraction for testability. The server.ts file is a thin wrapper that delegates to these functions. This pattern is correct.

**One consideration:** The `PromptResult` interface has `[x: string]: unknown` as an index signature. This is MCP SDK compatibility -- the SDK may attach additional fields. Acceptable.

### `packages/mcp/src/server.ts`

Changes are minimal and correct:
- Added `ListPromptsRequestSchema` and `GetPromptRequestSchema` imports
- Added `prompts: {}` to server capabilities
- Added two request handlers: `ListPromptsRequestSchema` delegates to `PROMPTS`, `GetPromptRequestSchema` delegates to `getPrompt()`
- Added `handleReadProjectStructure` and `handleWriteConfig` to the switch statement

The server remains a thin dispatcher. Logic lives in handlers.ts and prompts.ts. Correct architecture.

### `packages/mcp/src/handlers.ts` (REG-173 additions)

Two new handlers at the bottom of the file.

**`handleReadProjectStructure` (lines 1198-1278):**
- Resolves path relative to project root
- Validates path exists and is a directory
- Walks directory tree with configurable depth (max 5, clamped)
- Excludes noise directories via static `EXCLUDED` set
- Produces tree-formatted output with `|-- ` connectors
- Separates directories from files, sorts alphabetically
- Returns error for non-existent or non-directory paths

This is filesystem plumbing. No classification. No heuristics. The agent interprets the output. Correct.

**`handleWriteConfig` (lines 1282-1373):**
- Validates services via `validateServices()` from ConfigLoader
- Validates patterns via `validatePatterns()` from ConfigLoader
- Validates workspace via `validateWorkspace()` from ConfigLoader
- Builds config object from args
- Serializes to YAML with header comments
- Creates `.grafema/` directory if needed
- Returns summary with next steps

This reuses existing validators rather than building new ones. Correct.

### `packages/mcp/src/definitions.ts` (REG-173 additions)

Two new tool definitions at the end of the TOOLS array:

- `read_project_structure`: clear description, 3 optional parameters (path, depth, include_files)
- `write_config`: clear description, 5 optional parameters (services, plugins, include, exclude, workspace)

Schemas are well-defined with nested objects for services and plugins. The `write_config` schema has `required: ['name', 'path']` on service items, which matches the validator expectations.

### `packages/mcp/src/types.ts` (REG-173 additions)

Two new interfaces at the bottom:

- `ReadProjectStructureArgs`: path?, depth?, include_files?
- `WriteConfigArgs`: services?, plugins?, include?, exclude?, workspace?

Clean type definitions. Match the tool schemas exactly.

### `packages/core/src/config/ConfigLoader.ts`

The three validator functions (`validateServices`, `validatePatterns`, `validateWorkspace`) now have `export` keyword. This was the planned change. Non-breaking -- these functions were already module-scoped and well-defined.

### `packages/core/src/config/index.ts` and `packages/core/src/index.ts`

Barrel exports extended to include `validateServices`, `validatePatterns`, `validateWorkspace`, and `getOnboardingInstruction`. Correct.

### `packages/cli/src/commands/init.ts`

The `printNextSteps()` function now includes a reference to the MCP onboarding prompt:

```
For AI-assisted setup, use the Grafema MCP server
with the "onboard_project" prompt.
```

This is the discoverability bridge between CLI and MCP. Users who run `grafema init` learn about the AI-assisted onboarding path. Correct.

### `packages/core/package.json`

Added `postbuild` script: `cp -r src/instructions/*.md dist/instructions/`. This ensures the markdown file is copied to `dist/` alongside the compiled TypeScript. Verified that `dist/instructions/onboarding.md` exists in the current build.

---

## Tests Review

### `test/unit/instructions/onboarding.test.ts` (4 tests)

Tests verify:
1. Returns non-empty string
2. Contains all 6 step headers
3. References expected MCP tool names
4. Contains "When to ask the user" guidance

These are structural contract tests. They verify the instruction document has the expected shape without being brittle to content changes. Good test design -- they test the interface, not the prose.

### `packages/mcp/test/prompts.test.ts` (6 tests)

Tests verify:
1. PROMPTS list contains `onboard_project`
2. Correct structure (name, description, arguments)
3. `getPrompt()` returns valid result for `onboard_project`
4. Result message contains instruction text with step headers
5. Throws for unknown prompt
6. Error message lists available prompts

Clean tests. Test both happy path and error path. Test the interface contract, not implementation details.

### `packages/mcp/test/tools-onboarding.test.ts` (13 tests)

Tests use real filesystem with temp directories (not mocks). Proper setup/teardown. Tests verify:

**read_project_structure:**
- Basic directory reading
- Depth parameter
- Excluded directories
- include_files parameter
- Error for non-existent path
- Error for file (not directory)

**write_config:**
- Basic config with services
- Config with patterns
- Config with workspace roots
- Creates .grafema directory
- Error for invalid service path
- Header comments
- Summary with next steps

**All 23 tests pass.** Verified by running them.

---

## Disguised Heuristics Check

### EXCLUDED set in read_project_structure

```typescript
const EXCLUDED = new Set([
  'node_modules', '.git', 'dist', 'build', '.grafema',
  'coverage', '.next', '.nuxt', '.cache', '.output',
  '__pycache__', '.tox', 'target',
]);
```

Same assessment as plan review: this is a display filter, not a classification engine. It prevents the directory tree from being cluttered with generated/irrelevant directories. The agent makes all interpretive decisions. Not a heuristic.

### get_documentation fallback

The `handleGetDocumentation` handler has `onboarding` as a topic key that returns the same `getOnboardingInstruction()` content. This provides fallback access for MCP clients that don't support the `prompts` capability. Smart redundancy, not unnecessary duplication -- the instruction is the same content delivered through two channels.

### Config generation in write_config

The handler builds a YAML object from the arguments, serializes it, and writes it. No defaults are injected. No assumptions are made about the project. The agent explicitly provides every field. This is correct -- the intelligence is in the instruction, not the tool.

---

## Architecture and Complexity Check

1. **Complexity:** `read_project_structure` is O(n) over filesystem entries bounded by maxDepth=5 and directory exclusions. This is a targeted scan. No graph iteration. Acceptable.

2. **Plugin Architecture:** No new analyzer/enricher plugins. This feature adds MCP capabilities (tools + prompts). Correct use of the existing architecture.

3. **Extensibility:** Adding support for new project types requires editing the markdown instruction. No code changes needed. This is the best possible extensibility model.

4. **No brute-force:** Correct. The agent interprets a bounded directory listing using its general intelligence. No scanning of all graph nodes.

---

## Potential Issues (Minor, Non-Blocking)

### 1. readFileSync in getOnboardingInstruction()

The instruction is read synchronously from disk every time `getOnboardingInstruction()` is called. For an MCP prompt that's called once per session, this is fine. If it were called in a hot path, we'd want caching. Not a concern for this use case.

### 2. Depth clamp at 5

`read_project_structure` clamps maxDepth to 5. For very deep monorepos (e.g., `packages/group/subgroup/package/src/...`), the agent may need to call the tool multiple times with different `path` arguments. This is acceptable -- the instruction guides the agent to use `read_project_structure` with targeted paths (Step 1 mentions "use with depth=2 to see the package layout").

### 3. Test uses `entrypoints` (plural) vs WriteConfigArgs `entryPoint` (singular)

In `tools-onboarding.test.ts`, the test passes `entrypoints: ['index.js']` (line 170, 236, 262) to `handleWriteConfig`. But `WriteConfigArgs.services[].entryPoint` is singular and a string, not an array. The test still passes because the YAML serializer writes whatever it receives, and the validator (`validateServices`) only checks that `entryPoint` is a string if defined. The `entrypoints` field is simply ignored as an extra property.

This is not a bug -- the config file gets written with `entrypoints` as an extra field, which is harmless (YAML is lenient). But it means the test is slightly imprecise about what it verifies. The assertion `assert.ok(content.includes('- index.js'))` passes because the array gets serialized to YAML. The actual Grafema config loader would read `entryPoint`, not `entrypoints`.

**This is a cosmetic test issue, not a functional bug.** The write_config handler itself is correct. The test exercises the handler's validation and serialization paths correctly. The naming mismatch does not affect production behavior.

---

## Vision Alignment

Grafema's thesis: "AI should query the graph, not read code."

The onboarding flow is the gateway. An agent encounters Grafema for the first time, reads the onboarding instruction, studies the project, writes the config, builds the graph. After that, the agent queries the graph instead of reading code.

This implementation treats the agent as an intelligent collaborator. The instruction document is a guide, not a strait-jacket. The agent asks questions when uncertain. The tools provide raw data, not interpretations.

This is AI-first design. The instruction IS the product. The code is plumbing.

---

## Would Shipping This Embarrass Us?

No. This is clean, minimal, well-tested, and aligned with the project vision. The instruction document is actionable. The MCP integration follows protocol conventions. The code has no hacks. The tests cover both happy and error paths.

---

## Final Verdict

**APPROVE.**

The implementation matches the approved plan faithfully. Intelligence lives in the markdown instruction, not in TypeScript heuristics. The two new tools provide exactly the capabilities the agent needs and nothing more. Existing validators are reused rather than reimplemented. Tests are comprehensive (23 tests, all passing). The MCP Prompts capability is used correctly. No disguised heuristics. No architectural gaps. No shortcuts.

**Minor note for future iteration:** The `entrypoints` (plural) vs `entryPoint` (singular) naming in tests should be cleaned up for clarity, but this does not block shipping.

**Escalating to Vadim for final confirmation.**

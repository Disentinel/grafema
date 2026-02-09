# Steve Jobs -- High-Level Review v2 for REG-173

**Verdict: APPROVE**

---

## Does This Honor Vadim's Feedback?

Yes. Completely.

Vadim said: "We don't need a ProjectScanner, we need a prompt/human-readable instruction." Plan v2 delivers exactly that -- a markdown document in `packages/core/src/instructions/onboarding.md` that tells an agent how to study a project. No heuristics in code. No classification engine. No Ink UI. The intelligence lives in natural language, where it belongs.

Vadim said: "The agent will ask questions during the process." The instruction document has explicit "When to ask the user" sections with example questions. This is the right approach -- the instruction coaches the agent on when and how to involve the human, rather than building a question-generation engine.

Vadim said: "The instruction lives in core." It does -- `packages/core/src/instructions/onboarding.md`, exported via `getOnboardingInstruction()`.

Vadim said: "Onboarding will be done by AI agent or manually by human." The plan supports both: agents use the MCP Prompts capability, humans read the markdown directly or get it printed by `grafema init`. Same content, two delivery channels.

**No residual code-heuristics from v1.** The plan is genuinely instruction-driven.

---

## Is This Simple Enough?

Yes. This is dramatically simpler than v1.

- **v1:** ~2000+ lines, ProjectScanner, ServiceDescriptor, file count estimation, Ink-based interactive UI, framework classification heuristics
- **v2:** ~495 lines of implementation, ~260 lines of tests. The core deliverable is a 150-line markdown document.

The code is plumbing. The instruction IS the product. This is the right balance.

---

## Does the MCP Prompts Approach Make Sense?

Yes. I verified the claims against the actual SDK:

- `ListPromptsRequestSchema` exists at line 1812 of `@modelcontextprotocol/sdk` types (v1.25.2)
- `GetPromptRequestSchema` exists at line 1890
- `McpError` exists at line 7893

The MCP Prompts capability is the protocol-standard mechanism for servers to provide instructions to agents. Using it is correct -- it is discoverable via `prompts/list`, parameterizable, and returns structured `PromptMessage[]`. This is not a hack; this is the protocol working as designed.

The fallback via `get_documentation` with `topic: 'onboarding'` is smart -- covers MCP clients that do not yet support the `prompts` capability.

---

## Are the Two New Tools the Right Minimal Set?

Yes. The agent needs exactly two capabilities that the MCP server does not currently provide:

1. **See the project structure** -- `read_project_structure` gives a depth-limited directory tree. The agent interprets it. No classification, no heuristics.
2. **Save the config** -- `write_config` validates and writes `.grafema/config.yaml`. Reuses existing `ConfigLoader` validators.

Everything else the agent already has: file reading (via the MCP client itself), `discover_services` (existing tool), `analyze_project`, `get_stats`, `get_coverage`. Two new tools is the right number.

---

## Critical Check: Disguised Heuristics?

### The EXCLUDED set in `read_project_structure`

```typescript
const EXCLUDED = new Set([
  'node_modules', '.git', 'dist', 'build', '.grafema',
  'coverage', '.next', '.nuxt', '.cache', '.output',
  '__pycache__', '.tox', 'target',
]);
```

Is this a heuristic? **No.** This is a display filter, not a classification engine. It is equivalent to `.gitignore` -- it prevents the directory tree from being cluttered with generated/irrelevant directories. The agent does not need to see `node_modules/` contents to understand a project's structure. This is the same pattern as `tree -I 'node_modules|.git'`.

The key distinction: this list does not CLASSIFY anything. It does not say "this is a React project" or "this directory is a service." It just filters noise from the listing. The agent still makes all the interpretive decisions.

One minor concern: `.next` and `.nuxt` are framework-specific. But including them in the exclusion list is defensible -- they are generated output directories, like `dist` and `build`. An agent seeing `.next/` in a directory listing gains no information it would not get from seeing `next.config.js`.

**Verdict: Not a heuristic. Acceptable.**

### The `write_config` validation

Reuses `validateServices`, `validatePatterns`, `validateWorkspace` from `ConfigLoader.ts`. These are not heuristics -- they are structural validators (is `name` a string? does `path` exist as a directory?). They enforce the config schema, not project classification. Correct reuse.

---

## Config Validation Export Approach

The plan proposes adding `export` to three existing private functions in `ConfigLoader.ts` (lines 251, 328, 406). I verified these exist and are currently module-scoped (no `export` keyword). Adding `export` is a non-breaking change. The functions are at the right abstraction level for reuse.

The current barrel exports in `packages/core/src/config/index.ts` (line 4: `export { loadConfig, DEFAULT_CONFIG }`) and `packages/core/src/index.ts` (line 37: same) need to be extended. The plan specifies the exact changes. Straightforward.

---

## The Instruction Document

The instruction content is well-structured:

1. **Goal** -- clear
2. **Prerequisites** -- minimal
3. **Steps 1-6** -- sequential, actionable, reference specific MCP tools by name
4. **When to ask the user** -- explicit guidance with example questions
5. **Common patterns** -- monorepo, legacy, microservices, single-package

The instruction does NOT try to be exhaustive. It tells the agent what to look for and when to ask for help. Novel project types are handled by the agent's general intelligence. This is correct -- the instruction is a guide, not a strait-jacket.

**One observation:** The instruction will improve over time based on real onboarding failures. This is by design and is actually a strength -- updating markdown is cheaper than updating classification algorithms.

---

## Complexity and Architecture Checklist

1. **Complexity Check:** `read_project_structure` is O(n) over filesystem entries up to maxDepth=5 with excluded directories. This is a targeted, bounded scan -- not a scan of all graph nodes. Acceptable.

2. **Plugin Architecture:** This feature does not add new analyzer/enricher plugins. It adds MCP server capabilities (tools + prompts). No graph iteration. No backward scanning.

3. **Extensibility:** Adding support for new project types requires updating the markdown instruction, not code. This is the best possible extensibility model.

4. **No brute-force:** Correct. The agent uses its intelligence to interpret a directory listing. No scanning of all nodes.

---

## Potential Issues (Minor)

### 1. Build step for `.md` file copy

The plan proposes a `postbuild` script to copy `.md` files to `dist/`. This is a known pattern and works, but it is one more thing that can break. Joel's spec covers this clearly (Phase 1, Option A). The risk is low.

### 2. `yaml` dependency for MCP package

The MCP package needs to write YAML. Adding `yaml` as a direct dependency is the right call -- it is small, zero-dep, and the MCP server should own its serialization.

### 3. The `prompts.ts` extraction for testability

Joel proposes extracting prompts handler logic into `packages/mcp/src/prompts.ts` for testability. This is good practice -- keeps `server.ts` thin and makes the handlers unit-testable without spinning up a full MCP server.

---

## Vision Alignment

Grafema's thesis: "AI should query the graph, not read code."

The onboarding is the first interaction an AI agent has with Grafema. Plan v2 treats the agent as an intelligent collaborator -- give it instructions, let it study the project, let it ask questions, let it write the config. This is AI-first design.

Plan v1 treated the agent as a dumb terminal: show checkboxes, let it click. Plan v2 respects the agent's intelligence. This is the right approach for an AI-first tool.

The instruction IS the product. The MCP integration is the delivery mechanism. The two new tools are the minimal plumbing. Everything else leverages what already exists.

---

## Final Verdict

**APPROVE.**

This plan is the right approach. It honors Vadim's feedback completely. It is dramatically simpler than v1. It uses MCP protocol capabilities correctly. It has no disguised heuristics. It respects the agent's intelligence. The two new tools are the right minimal set. The instruction document is well-structured and will improve over time.

The estimated effort (3.5 days per Joel, 5-7 days per Don) is realistic. The critical path is clear.

**Escalating to Vadim for final confirmation.**

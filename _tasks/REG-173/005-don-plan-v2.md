# Don Melton -- High-Level Plan v2 for REG-173

## TL;DR

Replace the rejected `ProjectScanner` + Ink UI approach with an **instruction-driven onboarding** that lives as a markdown document in `packages/core`. The instruction tells an AI agent (or human) HOW to study a project, what to look for, and what questions to ask. The MCP server exposes this instruction via the MCP **Prompts** capability. The agent reads the instruction, uses existing Grafema MCP tools plus two new ones (`write_config` and `read_project_structure`), and interactively builds `config.yaml`. No heuristics in code. No Ink UI. The intelligence lives in the instruction, not in classification functions.

---

## Why Plan v1 Was Rejected

Vadim's feedback was direct:

> "A wagon of heuristics, garbage. We assume onboarding will be done by an AI agent or manually by a human (less likely, but must be possible)."
> "We absolutely don't need a ProjectScanner, we need a prompt / human-readable instruction on how to study a project and what to consider an entrypoint. We'll refine it based on real onboarding results."
> "The idea is that during the process, the agent will possibly ask questions ('I discovered that apps.json describes something similar to k8s services, should I mark them as services?') etc."
> "The instruction will live in core. Like other skills/documents needed by the agent-user of Grafema."

The fundamental error of v1: **building intelligence into code** (ProjectScanner with heuristics, ServiceDescriptor, file count estimation) when the intelligence should live in **natural language instructions** that an AI agent follows. The agent IS the heuristic engine. We just need to tell it what to look for.

---

## 1. Current State Analysis

### What exists today

**`grafema init` (CLI):**
- Creates `.grafema/config.yaml` with default plugin list
- Detects `package.json` (required) and `tsconfig.json` (optional)
- Does NOT detect services, workspaces, or entry points
- Generated config has `services: []` (relies on auto-discovery at analyze-time)

**Config system (`ConfigLoader.ts`):**
- `GrafemaConfig` includes `services: ServiceDefinition[]`
- `ServiceDefinition` = `{ name, path, entryPoint? }`
- If `services` is non-empty, Orchestrator skips discovery plugins entirely
- Validation: checks service paths exist, are relative, are directories

**MCP server:**
- Declares only `tools` capability (no prompts, no resources)
- 18 tools (query_graph, find_nodes, analyze_project, etc.)
- `discover_services` tool runs discovery plugins, returns results
- `get_documentation` tool returns hardcoded markdown docs
- All tools go through a single `switch` statement in `server.ts`

**Skills/instruction patterns:**
- `_skills/` contains `explore.md`, `strategy.md`, `housekeeping.md` -- structured markdown instructions for different workflows
- `.claude/skills/` contains operational skills (debugging, testing patterns)
- `_ai/` contains analysis docs and architecture references
- These are the existing pattern: **markdown documents that guide agent behavior**

### The Gap

There is no instruction document telling an agent how to study a new project and configure Grafema for it. The `discover_services` MCP tool runs code-based discovery plugins silently, with no interactive confirmation. The `grafema init` CLI generates a generic config and says "good luck."

More critically: the MCP server has no way to **provide instructions to the agent**. It has tools (things the agent can call) but no prompts (instructions the agent should follow). The MCP Prompts capability exists for exactly this use case.

---

## 2. Prior Art (Web Research)

### MCP Prompts (MCP Specification 2025-06-18)

The MCP specification defines **Prompts** as a first-class capability: "Prompts allow servers to provide structured messages and instructions for interacting with language models." Key properties:

- Server declares `prompts` capability during initialization
- Clients discover prompts via `prompts/list`, retrieve via `prompts/get`
- Prompts can have **arguments** for customization
- Prompts return `PromptMessage[]` with role and content
- Designed to be **user-controlled** -- explicitly selected by user/agent

This is exactly what we need: the MCP server exposes an "onboard" prompt that returns the onboarding instruction as structured messages. The agent follows the instruction, using tools to examine the project and write the config.

Source: [MCP Prompts Specification](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts)

### MCP Elicitation

MCP also defines **Elicitation**: a mechanism for servers to request missing information from users during a session. When the server detects missing information, the client presents a UI prompt, users provide context, and the server continues. This maps to the "agent asks questions" pattern Vadim described.

Source: [MCP Features Guide -- WorkOS](https://workos.com/blog/mcp-features-guide)

### AGENTS.md and Instruction-Driven Patterns

The AGENTS.md convention consolidates contextual knowledge for AI agents through systematic "context engineering." Core design patterns: descriptive documentation, prescriptive directives, prohibitive rules, explanatory rationale, conditional logic. This is exactly what our onboarding instruction should look like.

Source: [AGENTS.md best practices -- Builder.io](https://www.builder.io/blog/agents-md)

### Spec-Driven Development

GitHub's spec-driven approach: "Provide a high-level description of what you're building, and the coding agent generates detailed specifications." The `/specify` command provides prompts that the agent uses to generate specs. Our onboarding instruction is analogous: it provides the "spec" for project study, and the agent executes it.

Source: [Spec-driven development -- GitHub Blog](https://github.blog/ai-and-ml/generative-ai/spec-driven-development-with-ai-get-started-with-a-new-open-source-toolkit/)

---

## 3. Architecture Decisions

### Decision 1: Intelligence in instruction, not in code

**Choice:** The onboarding logic is a **markdown document** (`packages/core/src/instructions/onboarding.md`) that tells the agent what to look for. No `ProjectScanner`. No `ServiceDescriptor`. No classification heuristics in TypeScript.

**Rationale:** The AI agent IS the heuristic engine. It can read `package.json`, recognize Express from React from Next.js, understand monorepo structures, parse k8s configs. Writing classification code that duplicates this capability is wasteful. The instruction tells the agent what to look for; the agent's general intelligence does the classification.

**Key benefit:** The instruction is a living document. When onboarding fails for a new project type, we update the instruction, not code. No build step, no tests to update, no release needed.

### Decision 2: MCP Prompts capability for delivery

**Choice:** The MCP server declares the `prompts` capability and exposes an `onboard_project` prompt. When the agent (or client) selects this prompt, the server returns the onboarding instruction as `PromptMessage[]`.

**Rationale:** This is the MCP-standard mechanism for servers to provide instructions to agents. It is discoverable (agents can list available prompts), parameterizable (the prompt can accept the project path), and returns structured messages the agent can follow. No custom protocol needed.

**Alternative considered:** Exposing the instruction via the existing `get_documentation` tool. Rejected because: (1) `get_documentation` returns topic-based reference docs, not actionable workflows, (2) MCP Prompts is the correct semantic for "instruction the agent should follow", (3) prompts are discoverable via `prompts/list` whereas tools require the agent to know the tool name.

### Decision 3: Two new MCP tools (minimal)

**Choice:** Add exactly two new tools:

1. **`read_project_structure`** -- Returns directory tree of the project (depth-limited, excludes node_modules/dist/etc). This gives the agent the raw material to study the project. No classification, no heuristics -- just a directory listing.

2. **`write_config`** -- Writes (or updates) `.grafema/config.yaml` with provided services, plugins, include/exclude patterns. Validates input against existing `ConfigLoader` validation. This is the "save result" tool.

**Rationale:** The agent needs to (a) see the project structure and (b) write the config. Everything else (read files, understand patterns, classify services) the agent already can do via its general capabilities. The `discover_services` tool already exists for code-based discovery as a fallback. The new `read_project_structure` tool is deliberate: it is NOT a heuristic scanner, it is a raw directory tree -- the agent interprets it using the instruction.

### Decision 4: Instruction lives in `packages/core`

**Choice:** The onboarding instruction lives at `packages/core/src/instructions/onboarding.md`.

**Rationale:** Per Vadim: "The instruction will live in core. Like other skills/documents needed by the agent-user of Grafema." The `packages/core` module is the right home because:
- It is the shared package used by both MCP and CLI
- It contains the config schema and validation
- Future instructions (e.g., "how to write a custom plugin", "how to debug analysis gaps") will also live here
- The MCP server reads it at runtime from the installed package

### Decision 5: Human CLI flow uses the same instruction

**Choice:** `grafema init` becomes simpler: it creates `.grafema/` directory, writes a minimal default config, and prints the onboarding instruction to stdout (or a reference to it). A human follows the same instruction manually. No Ink UI, no interactive prompts in the CLI.

**Rationale:** Vadim said: "less likely, but must be possible" for humans. The instruction is human-readable markdown. A human reads it, looks at the project, and edits `config.yaml` manually. The CLI init just bootstraps the directory structure and points to the instruction. This is dramatically simpler than the v1 Ink-based interactive flow.

**For `--yes` mode:** `grafema init --yes` creates the directory, writes default config with empty services, and runs `grafema analyze` (which uses auto-discovery as before). This is the existing behavior, unchanged.

### Decision 6: Reuse existing `discover_services` as fallback

**Choice:** The existing `discover_services` MCP tool remains as-is. It runs the code-based discovery plugins (`SimpleProjectDiscovery`, `WorkspaceDiscovery`). The onboarding instruction can tell the agent: "Start by running `discover_services` to see what Grafema auto-detects. Then verify and supplement the results."

**Rationale:** The code-based discovery is not bad -- it is just incomplete. Using it as a starting point for the agent's study makes sense. The agent can correct what the heuristics get wrong.

---

## 4. The Onboarding Instruction

This is the core deliverable. It is a markdown document that guides the agent through project study. Here is the structure (content will be refined based on real onboarding experience):

```markdown
# Grafema Project Onboarding

## Goal
Study the target project and create a `.grafema/config.yaml` that correctly
describes its services, entry points, and analysis configuration.

## Prerequisites
- The project directory exists and contains source code
- `.grafema/` directory exists (run `grafema init` if not)

## Step 1: Initial Reconnaissance

Use `read_project_structure` to get the directory tree.

Look for:
- `package.json` in root and subdirectories (indicates JS/TS packages)
- `pnpm-workspace.yaml`, `lerna.json` (workspace/monorepo indicators)
- `tsconfig.json` (TypeScript project)
- `Dockerfile`, `docker-compose.yml`, `k8s/`, `apps.json` (deployment configs
  that may reveal service boundaries)
- Directories named `apps/`, `packages/`, `services/`, `pkg/`, `modules/`
  (common monorepo structures)

## Step 2: Identify Services

A "service" in Grafema is an independently analyzable unit of code with its
own entry point. Typically:
- A standalone application (API server, web app, CLI tool)
- A package in a monorepo that other packages depend on
- A microservice in a deployment configuration

For each potential service, determine:
1. **Name** -- human-readable identifier
2. **Path** -- directory path relative to project root
3. **Entry point** -- the main source file (prefer TypeScript source over
   compiled output)

### How to find entry points
Check in order:
1. `package.json` "source" field (TypeScript source)
2. `package.json` "main" field, but look for `.ts` equivalent in `src/`
3. Common patterns: `src/index.ts`, `src/main.ts`, `src/app.ts`,
   `src/server.ts`, `index.ts`
4. For React apps: `src/App.tsx`, `src/index.tsx`

### When to ask the user
- "I found [X] that looks like [description]. Should I include it as a
  service?"
- "This directory has multiple potential entry points: [list].
  Which should I use?"
- "I found deployment configuration mentioning services not visible in
  the code structure. Should I investigate?"

## Step 3: Run Auto-Discovery (Optional)

Use `discover_services` to see what Grafema's built-in detection finds.
Compare with your own findings. Note discrepancies.

## Step 4: Configure Plugins

Default plugins work for most JS/TS projects. Adjust if:
- Project uses specific frameworks (Express, React, Socket.IO) -- ensure
  corresponding analyzers are enabled
- Project has Rust components -- add RustModuleIndexer and RustAnalyzer
- Project has unusual file patterns -- configure include/exclude

## Step 5: Write Configuration

Use `write_config` to save the discovered configuration.

The config should include:
- `services` array with all confirmed services
- `plugins` section (only if overriding defaults)
- `include`/`exclude` patterns (only if needed)
- `workspace.roots` (for multi-root workspaces)

## Step 6: Verify

Run `analyze_project` to build the graph. Then check:
- `get_stats` -- are node/edge counts reasonable?
- `get_coverage` -- are the expected files analyzed?

If coverage is low or results are unexpected, iterate:
revisit services, entry points, or include/exclude patterns.

## Common Patterns

### Monorepo with workspaces
Look for `pnpm-workspace.yaml` or `workspaces` in root `package.json`.
Each workspace package is typically a service.

### Legacy project with multiple entry points
Look for `scripts` in `package.json`, `bin` field, or multiple files
in `src/` that look like entry points (contain `app.listen()`,
`createServer()`, `express()`).

### Microservices with shared deployment
Look for `docker-compose.yml`, Kubernetes configs, or similar
deployment manifests that list services. Cross-reference with
code directories.
```

**This instruction will be refined based on real onboarding experience.** Each time we onboard a new project and the instruction fails to guide correctly, we update it.

---

## 5. Component Breakdown

| Component | Package | Purpose | New/Modified | Est. Lines |
|-----------|---------|---------|--------------|------------|
| `onboarding.md` | `core` | Onboarding instruction document | **New** | ~150 |
| `instructions/index.ts` | `core` | Exports instruction as string | **New** | ~20 |
| `prompts` capability | `mcp` | MCP Prompts support in server | **New** | ~80 |
| `read_project_structure` tool | `mcp` | Directory tree tool | **New** | ~60 |
| `write_config` tool | `mcp` | Config writer tool | **New** | ~80 |
| `init.ts` (CLI) | `cli` | Simplify init command | **Modified** | -50 (net reduction) |
| Tests | `mcp`, `core` | Tests for new tools/prompts | **New** | ~200 |

**Total new code: ~440 lines** (vs ~2000+ lines in v1 plan). Most of the "intelligence" is in the 150-line instruction document, not in TypeScript.

---

## 6. Detailed Design

### 6.1 Instruction Document (`packages/core/src/instructions/onboarding.md`)

A markdown file containing the onboarding procedure. Exported from `core` via:

```typescript
// packages/core/src/instructions/index.ts
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function getOnboardingInstruction(): string {
  return readFileSync(join(__dirname, 'onboarding.md'), 'utf-8');
}
```

The instruction is read at runtime from the installed package. It is a regular file, not embedded in code, so it can be updated without code changes (though npm publish is still needed for distribution).

### 6.2 MCP Prompts Capability

Add `prompts` capability to the MCP server:

```typescript
// In server.ts, update capabilities
capabilities: {
  tools: {},
  prompts: {},  // NEW
}
```

Add handler for `prompts/list`:

```typescript
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: 'onboard_project',
        title: 'Onboard a New Project',
        description: 'Get step-by-step instructions for studying a project and configuring Grafema for analysis.',
        arguments: [],  // No arguments -- uses the current project
      }
    ]
  };
});
```

Add handler for `prompts/get`:

```typescript
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === 'onboard_project') {
    const instruction = getOnboardingInstruction();
    return {
      description: 'Project onboarding instruction',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: instruction,
          }
        }
      ]
    };
  }

  throw new Error(`Unknown prompt: ${name}`);
});
```

### 6.3 `read_project_structure` Tool

Returns a depth-limited directory tree. No classification, no heuristics -- just a raw listing.

```typescript
// Tool definition
{
  name: 'read_project_structure',
  description: 'Get the directory structure of the project. Returns a tree of files and directories, useful for understanding project layout before configuration.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Subdirectory to scan (relative to project root). Default: project root.',
      },
      depth: {
        type: 'number',
        description: 'Maximum directory depth (default: 3, max: 5)',
      },
      include_files: {
        type: 'boolean',
        description: 'Include files in output, not just directories (default: true)',
      },
    },
  },
}
```

Implementation: recursive `readdirSync` with depth limit. Excludes `node_modules`, `.git`, `dist`, `build`, `.grafema` by default. Returns formatted tree string.

This is deliberately NOT a smart scanner. It is a dumb directory listing. The agent uses its own intelligence (guided by the instruction) to interpret the listing.

### 6.4 `write_config` Tool

Writes or updates `.grafema/config.yaml`:

```typescript
// Tool definition
{
  name: 'write_config',
  description: 'Write or update the Grafema configuration file (.grafema/config.yaml). Validates all inputs before writing.',
  inputSchema: {
    type: 'object',
    properties: {
      services: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Service name' },
            path: { type: 'string', description: 'Path relative to project root' },
            entryPoint: { type: 'string', description: 'Entry point file (optional)' },
          },
          required: ['name', 'path'],
        },
        description: 'Service definitions',
      },
      plugins: {
        type: 'object',
        description: 'Plugin configuration (optional, uses defaults if omitted)',
      },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns for files to include',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns for files to exclude',
      },
      workspace: {
        type: 'object',
        description: 'Multi-root workspace config',
      },
    },
  },
}
```

Implementation:
1. Merge provided fields with defaults (from `DEFAULT_CONFIG`)
2. Validate using existing `ConfigLoader` validation functions (extract and reuse `validateServices`, `validatePatterns`, `validateWorkspace`)
3. Write YAML to `.grafema/config.yaml`
4. Return summary of what was written

**Important:** Validation functions from `ConfigLoader.ts` are currently private. They need to be exported (or extracted to a shared validation module). This is a small refactor of existing code.

### 6.5 Simplified `grafema init` (CLI)

The current init command (199 lines) becomes simpler:

1. Create `.grafema/` directory
2. Write default `config.yaml` (same as today)
3. Update `.gitignore` (same as today)
4. Print: "Configuration created. To study your project and customize config, use the Grafema MCP server with the `onboard_project` prompt, or edit `.grafema/config.yaml` manually."
5. In interactive mode: same "Run analysis now?" prompt (unchanged behavior)

**Removed:** No Ink components, no ProjectScanner call, no service selection UI. The CLI init is a bootstrap step, not an interactive wizard.

---

## 7. Interaction Flow (Agent)

```
Agent                           MCP Server
  │                                │
  │ prompts/list                   │
  │──────────────────────────────>│
  │ [onboard_project]             │
  │<──────────────────────────────│
  │                                │
  │ prompts/get(onboard_project)   │
  │──────────────────────────────>│
  │ [instruction document]        │
  │<──────────────────────────────│
  │                                │
  │ (Agent reads instruction)      │
  │                                │
  │ read_project_structure()       │
  │──────────────────────────────>│
  │ [directory tree]              │
  │<──────────────────────────────│
  │                                │
  │ (Agent studies structure,      │
  │  reads package.json files,     │
  │  identifies services)          │
  │                                │
  │ "I found apps/backend with     │
  │  Express. Include as service?" │
  │──────────────────>  User       │
  │ "Yes"                          │
  │<──────────────────  User       │
  │                                │
  │ discover_services()            │
  │──────────────────────────────>│
  │ [auto-detected services]      │
  │<──────────────────────────────│
  │                                │
  │ (Agent compares, reconciles)   │
  │                                │
  │ write_config({services: [...]})│
  │──────────────────────────────>│
  │ [config written]              │
  │<──────────────────────────────│
  │                                │
  │ analyze_project()              │
  │──────────────────────────────>│
  │ [analysis complete]           │
  │<──────────────────────────────│
  │                                │
  │ get_stats() / get_coverage()   │
  │──────────────────────────────>│
  │ [verification results]        │
  │<──────────────────────────────│
```

### Interaction Flow (Human)

```
Human: grafema init
  --> Creates .grafema/config.yaml with defaults
  --> Prints onboarding instruction summary to stdout

Human reads instruction, examines project manually:
  --> Looks at directory structure
  --> Reads package.json files
  --> Identifies services and entry points
  --> Edits .grafema/config.yaml directly
```

---

## 8. Risk Assessment

### Risk 1: Agent does not follow the instruction reliably
**Likelihood:** Medium. **Impact:** Medium.
Different AI models may interpret the instruction differently or skip steps.

**Mitigation:** The instruction is explicit and step-by-step. We test with Claude, GPT-4, and at least one other model. We iterate on the instruction wording based on real failures. The instruction is the cheapest thing to update -- no code deployment needed, just edit markdown.

### Risk 2: Agent cannot read project files directly
**Likelihood:** Low for MCP-connected agents. **Impact:** High.
Some MCP clients may not give the agent filesystem access beyond what the MCP server provides.

**Mitigation:** The `read_project_structure` tool provides directory listing. For file contents, the agent has two options: (1) the MCP client itself provides file reading (most do -- Claude Code, VS Code Copilot, etc.), or (2) we could add a `read_file` tool to the MCP server in the future if needed. For MVP, we rely on the client having file access.

### Risk 3: MCP Prompts not supported by all clients
**Likelihood:** Medium. **Impact:** Low.
Not all MCP clients support the `prompts` capability yet.

**Mitigation:** The onboarding instruction is also available via `get_documentation` tool (we add an "onboarding" topic). And the instruction is a regular markdown file that can be read directly from the installed package. Multiple delivery channels, same content.

### Risk 4: Instruction becomes stale or incomplete
**Likelihood:** Certain (over time). **Impact:** Low.
New project types and patterns will emerge that the instruction does not cover.

**Mitigation:** This is by design. The instruction is a living document. Each onboarding failure is a learning opportunity. We update the instruction, not code. The iteration cycle is: onboard project, instruction fails, update instruction, try again. This is faster than writing and testing code heuristics.

### Risk 5: write_config validation is too strict
**Likelihood:** Low. **Impact:** Low.
The existing ConfigLoader validation requires service paths to exist as directories. During onboarding, the agent might try to write a config before verifying all paths.

**Mitigation:** The `write_config` tool validates before writing and returns clear error messages. The instruction tells the agent to verify paths first. If a path does not exist, the error message says exactly which path failed.

---

## 9. Scope Boundaries

### IN scope
- Onboarding instruction document in `packages/core/src/instructions/`
- MCP Prompts capability with `onboard_project` prompt
- `read_project_structure` MCP tool (directory tree)
- `write_config` MCP tool (config writer)
- Export config validation functions from ConfigLoader
- Add "onboarding" topic to `get_documentation` (fallback for clients without prompts support)
- Simplify `grafema init` CLI (remove unnecessary complexity, reference instruction)
- Tests for new MCP tools and prompts handler

### OUT of scope
- ProjectScanner, ServiceDescriptor, or any classification heuristics in code
- Ink UI components for interactive init
- Changes to existing discovery plugins
- Changes to Orchestrator or analysis pipeline
- GUI visualization
- Plugin recommendation engine
- Auto-detection of include/exclude patterns in code

### Deferred to future
- Additional prompts (e.g., "debug_analysis_gap", "write_custom_plugin")
- MCP Resources capability (exposing config as a readable resource)
- MCP Elicitation (server-initiated questions to the agent)
- Instruction localization
- Metrics on instruction effectiveness (which steps fail most often)

---

## 10. Estimated Effort

| Phase | Description | Estimate |
|-------|-------------|----------|
| Phase 1 | Onboarding instruction document + core exports | 1 day |
| Phase 2 | MCP Prompts capability + handlers | 1 day |
| Phase 3 | `read_project_structure` + `write_config` tools | 1-2 days |
| Phase 4 | Export ConfigLoader validation + `get_documentation` fallback | 0.5 day |
| Phase 5 | Simplify `grafema init` CLI | 0.5 day |
| Phase 6 | Tests for all new components | 1-2 days |
| **Total** | | **5-7 days** |

This is significantly less than the v1 estimate of 8-11 days, and the code is dramatically simpler. Most of the effort is in Phase 1 (writing a good instruction) and Phase 6 (testing).

---

## 11. Key Insight: Why This Is RIGHT

Grafema's core thesis is "AI should query the graph, not read code." The onboarding is the first moment where an AI agent interacts with Grafema. Plan v1 treated the agent as a dumb terminal: show it checkboxes, let it click. Plan v2 treats the agent as an intelligent collaborator: give it instructions, let it think.

This aligns with the project vision in three ways:

1. **AI-first:** The MCP Prompts capability is the standard mechanism for server-to-agent instructions. We are using the protocol correctly, not building custom hacks.

2. **Evolving instruction over rigid code:** When a new project type breaks onboarding, we update a markdown file, not a classification algorithm. This is faster, cheaper, and more flexible than code-based heuristics.

3. **Reuse before build:** We add two minimal tools (directory listing and config writer) and one prompt. Everything else -- the agent's ability to read files, understand project structures, classify frameworks -- already exists in the agent itself. We don't duplicate that capability in code.

The instruction IS the product. Everything else is plumbing.

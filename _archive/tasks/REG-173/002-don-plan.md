# Don Melton -- High-Level Plan for REG-173

## TL;DR

Replace the current "fire-and-hope" init command with a **two-phase interactive discovery** that (1) detects project structure, (2) presents findings to the user, and (3) writes confirmed selections to `config.yaml`. The core discovery logic already exists in `packages/core/src/plugins/discovery/` -- we **reuse and expose it**, rather than building a parallel detection system.

---

## 1. Current State Analysis

### What exists today

**`grafema init` (`packages/cli/src/commands/init.ts`):**
- Creates `.grafema/config.yaml` with default plugin list
- Detects `package.json` (required) and `tsconfig.json` (optional)
- Asks one yes/no question: "Run analysis now?"
- Uses raw `readline.createInterface` for the single prompt
- Has `--yes` flag for non-interactive mode
- Does NOT detect services, workspaces, or entry points
- The generated config has `services: []` (empty -- relies on auto-discovery at analyze-time)

**Discovery plugins (`packages/core/src/plugins/discovery/`):**
- `SimpleProjectDiscovery` -- finds single service from root `package.json`
- `WorkspaceDiscovery` -- detects pnpm/npm/yarn/lerna workspaces, resolves glob patterns to packages
- `MonorepoServiceDiscovery` -- hardcoded `pkg/` directory scanning (legacy)
- `resolveSourceEntrypoint.ts` -- prefers TS source over compiled output (standard candidate list)
- `workspaces/detector.ts` -- detects workspace type (pnpm > npm/yarn > lerna)
- `workspaces/globResolver.ts` -- resolves workspace patterns to actual directories
- `workspaces/parsers.ts` -- parses pnpm-workspace.yaml, package.json workspaces, lerna.json

**Config system (`packages/core/src/config/ConfigLoader.ts`):**
- `GrafemaConfig` interface includes `services: ServiceDefinition[]`
- `ServiceDefinition` = `{ name, path, entryPoint? }` (in `@grafema/types`)
- If `services` is non-empty in config, Orchestrator skips discovery plugins entirely (REG-174)
- Config validation already checks service paths exist and are relative directories

**Orchestrator (`packages/core/src/Orchestrator.ts`):**
- If `configServices` provided and non-empty, uses them directly (creates SERVICE nodes, resolves entrypoints)
- If no config services, runs discovery plugins sorted by priority
- `WorkspaceDiscovery` (priority 110) > `MonorepoServiceDiscovery` (100) > `SimpleProjectDiscovery` (50)

**Interactive UI precedent:**
- `explore` command uses **Ink** (React-based TUI framework) -- already a dependency
- `ink` v6 and `react` v19 are in `packages/cli/package.json`
- Current init uses bare `readline.createInterface` -- minimal

### The Gap

The init command generates a generic config and says "good luck." The actual project-specific discovery (workspaces, services, entry points) happens only at `analyze` time, silently, with no user confirmation. If auto-detection fails, the user has no idea what went wrong and no way to fix it other than manually editing `config.yaml`.

The ToolJet onboarding report (`demo/onboarding-tests/tooljet/`) confirms this: the user had to manually configure services, include/exclude patterns, and write a custom plugin. The init flow gave them nothing useful.

---

## 2. Prior Art

### Nx (`nx init`)
- Detects existing workspace type (npm, pnpm, yarn)
- Interactive prompts for preset selection (react, angular, node, etc.)
- Auto-generates `nx.json` with detected project graph
- Source-code analysis to build project graph automatically
- New workspaces auto-include AI configuration files
- Key insight: **shows the detected graph, lets you confirm**

Source: [Workspace Creation and Initialization | Nx](https://deepwiki.com/nrwl/nx/7.1-workspace-creation-and-initialization)

### Turborepo (`create-turbo`)
- Creates workspace from template with pre-configured packages
- Composable configuration (v2.7) for reusable config snippets
- Less interactive -- more template-driven

Source: [CLI Architecture | Turborepo](https://deepwiki.com/vercel/turborepo/2.4-cli-architecture)

### ESLint (`eslint --init`)
- Multi-step questionnaire: "How would you like to use ESLint?"
- Detects framework from `package.json` dependencies
- Shows config preview before writing
- `--config` flag for programmatic use
- Key insight: **detect from dependencies, confirm with user**

### Pattern synthesis

The best init flows share these traits:
1. **Detect first, ask second** -- scan the project, THEN present findings
2. **Numbered selection** -- not free-text input, reduce friction
3. **Smart defaults** -- pre-select the most likely option
4. **Explain choices** -- why is this recommended?
5. **Config is the artifact** -- all choices persist in a config file
6. **Non-interactive path** -- `--yes` accepts all defaults

---

## 3. Architecture Decisions

### Decision 1: Reuse existing discovery infrastructure

**Choice:** Reuse `WorkspaceDiscovery`, `SimpleProjectDiscovery`, and `resolveSourceEntrypoint` from `packages/core`. Do NOT create parallel detection logic.

**Rationale:** The discovery plugins already do the hard work of detecting workspaces, parsing configs, resolving packages, and finding entry points. We just need to extract and present their findings before they write to the graph.

**How:** Create a lightweight `ProjectScanner` class in `packages/core` that runs the detection logic (workspace type, packages, entry points) WITHOUT creating graph nodes. It returns structured data that the CLI can present interactively. After the user confirms, the CLI writes `services` to `config.yaml`.

### Decision 2: Use Ink (React) for interactive prompts

**Choice:** Use Ink (already a dependency) for the interactive init flow. No new dependencies.

**Rationale:** The `explore` command already uses Ink v6 + React 19. Ink provides `SelectInput`, `MultiSelect`, `TextInput` components that handle terminal interaction. Adding `inquirer` or `prompts` would be a redundant dependency when we already have a React-based TUI framework. Ink also renders beautifully with colors, spinners, and formatting.

**Important:** For simple selection prompts, we can use `ink-select-input` (or build a minimal select component). Ink's `useInput` hook handles keyboard input directly.

### Decision 3: Separate detection from presentation

**Choice:** Three-layer architecture:
1. **ProjectScanner** (in `core`) -- pure detection logic, returns structured data
2. **InitFlow** (in `cli`) -- Ink-based interactive UI that presents findings and collects choices
3. **ConfigWriter** (in `cli`) -- writes confirmed selections to `config.yaml`

**Rationale:** Keeps `core` free of UI concerns. The MCP server can use `ProjectScanner` directly without the interactive layer. CLI uses Ink for presentation. Config writing is already partially in `init.ts`.

### Decision 4: Config-driven, not graph-driven

**Choice:** The init flow writes `services` array to `config.yaml`. It does NOT create graph nodes during init.

**Rationale:** `grafema init` produces configuration. `grafema analyze` produces the graph. Mixing these concerns creates confusion. The Orchestrator already handles config services (REG-174). By writing services to config, we give the user a clear, editable, version-controlled artifact.

### Decision 5: MCP compatibility via `--yes` and programmatic API

**Choice:** MCP and CI use `--yes` flag (accept all defaults) or call `ProjectScanner` directly. No terminal interaction.

**Rationale:** MCP server has no terminal. The scanner provides the same structured data; the MCP server can present it through its own interface (tool responses). The `--yes` flag uses recommended defaults silently.

---

## 4. High-Level Plan

### Phase 1: ProjectScanner (in `packages/core`)

Create `packages/core/src/discovery/ProjectScanner.ts`:

```typescript
interface ScanResult {
  projectType: 'single' | 'workspace' | 'monorepo';
  workspaceType?: 'pnpm' | 'npm' | 'yarn' | 'lerna';
  services: DetectedService[];
  warnings: string[];
}

interface DetectedService {
  name: string;
  path: string;               // relative to project root
  description: string;        // human-readable ("React app", "Express API")
  fileCount: number;          // approximate file count for context
  entryPoints: DetectedEntryPoint[];
  recommended: boolean;       // should this be included by default?
}

interface DetectedEntryPoint {
  path: string;               // relative to service path
  type: 'source' | 'compiled' | 'alternative';
  reason: string;             // "TypeScript source", "package.json main", etc.
  recommended: boolean;       // is this the recommended choice?
}
```

The scanner reuses:
- `detectWorkspaceType()` from `workspaces/detector.ts`
- `resolveWorkspacePackages()` from `workspaces/globResolver.ts`
- `resolveSourceEntrypoint()` from `resolveSourceEntrypoint.ts`
- `existsSync` checks for common patterns (Express, React, etc.)

New logic needed:
- Service description heuristic (check `package.json` dependencies for express, react, etc.)
- File count estimation (fast `readdirSync` with depth limit)
- Entry point enumeration (find ALL candidates, not just the best one)
- "Recommended" flagging (skip `scripts/`, `tools/`, etc.)

### Phase 2: Interactive Init Flow (in `packages/cli`)

Rewrite `packages/cli/src/commands/init.ts` to use an Ink-based flow:

**Step 1: Scan** (show spinner)
```
Analyzing project structure...
```

**Step 2: Show detected services** (multi-select)
```
Found 4 potential services:

  [x] 1. apps/frontend (React app, ~45 files)
  [x] 2. apps/backend (Express API, ~23 files)
  [x] 3. apps/telegram-bot (Node.js, ~12 files)
  [ ] 4. scripts/ (Utility scripts, ~8 files)

Use arrow keys to navigate, space to toggle, enter to confirm.
Which services should Grafema analyze? [1-3 selected]
```

**Step 3: Entry point selection** (only for services with multiple candidates)
```
For apps/backend, I found multiple entry points:

  > 1. src/index.ts (recommended -- TypeScript source)
    2. dist/index.js (compiled output)
    3. src/server.ts (alternative entry)

Which entry point should I use? [1]
```

**Step 4: Write config and confirm**
```
Configuration saved to .grafema/config.yaml

  services:
    - name: "frontend"
      path: "apps/frontend"
    - name: "backend"
      path: "apps/backend"
      entryPoint: "src/index.ts"
    - name: "telegram-bot"
      path: "apps/telegram-bot"

Next steps:
  1. Review config:  code .grafema/config.yaml
  2. Start server:   grafema server start
  3. Build graph:    grafema analyze
  4. Explore:        grafema overview
```

### Phase 3: Non-interactive mode

`grafema init --yes`:
- Run ProjectScanner
- Auto-select all recommended services
- Auto-select recommended entry points
- Write config silently
- Print summary

### Phase 4: Tests

- Unit tests for `ProjectScanner` with fixture directories
- Unit tests for entry point detection
- Integration tests for the full init flow (mock stdin for Ink)
- Test `--yes` mode produces correct config

---

## 5. Component Breakdown

| Component | Package | Purpose | New/Modified |
|-----------|---------|---------|--------------|
| `ProjectScanner` | `core` | Detect project structure | **New** |
| `ServiceDescriptor` | `core` | Classify service type from dependencies | **New** |
| `EntryPointEnumerator` | `core` | Find all entry point candidates | **New** (extends `resolveSourceEntrypoint`) |
| `init.ts` / `InitFlow.tsx` | `cli` | Interactive init command | **Rewrite** |
| `ConfigWriter` | `cli` | Write services to config.yaml | **Extract from init.ts** |
| `DetectedService` types | `types` | Shared types for scan results | **New** |

---

## 6. Risk Assessment

### Risk 1: Ink complexity for simple prompts
**Likelihood:** Medium. **Impact:** Low.
Ink is powerful but might be overkill for 2-3 selection screens. However, it's already a dependency and the explore command proves it works. If Ink proves too complex for this use case, we can fall back to a simple line-by-line renderer using `readline`.

**Mitigation:** Start with a minimal Ink component. If it takes more than a day to get the selection working, fall back to `readline`-based prompts.

### Risk 2: Service description heuristics are wrong
**Likelihood:** High for edge cases. **Impact:** Low.
Detecting "React app" vs "Express API" from `package.json` dependencies is heuristic. It will be wrong sometimes.

**Mitigation:** Labels are informational only. The user confirms. Wrong labels don't break anything. Iterate based on user feedback. The heuristic is easily extensible.

### Risk 3: Entry point detection misses candidates
**Likelihood:** Medium. **Impact:** Medium.
Current `resolveSourceEntrypoint` returns the first match. We need ALL candidates for the selection UI. Custom projects might have non-standard entry points.

**Mitigation:** The `EntryPointEnumerator` will check a broader set of candidates (including `package.json` fields `main`, `source`, `module`, `exports`). Users can always edit `config.yaml` manually.

### Risk 4: MCP can't use interactive flow
**Likelihood:** Certain. **Impact:** Low.
MCP server has no terminal. This is expected.

**Mitigation:** `ProjectScanner` is a pure function in `core`. MCP can call it directly and present results through its tool interface. `--yes` flag works for CI/automation. The MCP server could offer a `project_scan` tool that returns structured data.

### Risk 5: Large monorepos with hundreds of packages
**Likelihood:** Low (but real). **Impact:** Medium.
A monorepo with 200+ packages would produce an unusable selection list.

**Mitigation:** Group by directory, show counts. For large workspaces, offer "analyze all" as default. Pagination or search if needed (future enhancement).

---

## 7. Scope Boundaries

### IN scope
- `ProjectScanner` in `packages/core` with structured output
- Interactive service selection in `grafema init` using Ink
- Entry point selection for services with multiple candidates
- Write confirmed services to `config.yaml`
- `--yes` flag for non-interactive mode
- Service type description heuristic (React, Express, Node.js, etc.)
- File count estimation for context
- Unit tests for all new components

### OUT of scope
- MCP server integration (separate ticket -- uses `ProjectScanner` API)
- GUI visualization of project structure
- Auto-detection of include/exclude patterns
- Custom framework detection (NestJS, Fastify, etc.) beyond basic `package.json` scanning
- Plugin recommendation based on detected frameworks
- Migration from existing `config.json` format (already handled)
- Changes to `grafema analyze` flow (already handles `config.services`)
- Monorepo workspace-level config generation (just services for now)

### Deferred to future
- `grafema init --reconfigure` to re-run detection on existing project
- Framework-specific plugin suggestions ("We detected Express -- enabling ExpressRouteAnalyzer")
- Interactive include/exclude pattern configuration
- Project template generation

---

## 8. Dependency Analysis

### New npm dependencies: NONE
- Ink v6 is already in `packages/cli/package.json`
- React 19 is already there
- We may need `ink-select-input` (peer of ink) -- check if it exists or build minimal select component

### Package changes
- `@grafema/core` -- new exports for `ProjectScanner` and types
- `@grafema/types` -- new types for `DetectedService`, `DetectedEntryPoint`, `ScanResult`
- `@grafema/cli` -- rewritten `init.ts`, new Ink components

---

## 9. Estimated Effort

| Phase | Description | Estimate |
|-------|-------------|----------|
| Phase 1 | ProjectScanner + tests | 3-4 days |
| Phase 2 | Interactive Init Flow (Ink) + tests | 3-4 days |
| Phase 3 | Non-interactive mode + edge cases | 1 day |
| Phase 4 | Integration tests + polish | 1-2 days |
| **Total** | | **8-11 days** |

---

## 10. Key Questions for Review

1. **Ink vs readline for prompts?** I recommend Ink because it's already a dependency and the explore command proves it works. But readline is simpler and might be enough for numbered selection. Decision point: if Ink takes more than a day, fall back to readline.

2. **Should `ProjectScanner` be exported from `@grafema/core`?** Yes -- MCP server needs it too. It's a pure detection function with no graph dependency.

3. **Should we add `ink-select-input` as a dependency?** Check if it's already available via ink, otherwise build a minimal 50-line select component. No need for a heavy dependency.

4. **File count estimation: fast approximation or accurate count?** Fast approximation (count files in top-level directory, estimate for subdirs). Accurate count could be slow on large projects.

5. **Should the init flow also configure `include`/`exclude` patterns?** Not in this ticket. Keep scope tight. But `ProjectScanner` could detect patterns worth excluding (test dirs, dist, node_modules) for a future enhancement.

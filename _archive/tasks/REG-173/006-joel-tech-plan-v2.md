# Joel Spolsky -- Detailed Technical Specification for REG-173 v2

## Overview

This spec expands Don's v2 plan into implementation-level detail. The plan has six deliverables: (1) onboarding instruction document, (2) MCP Prompts capability, (3) `read_project_structure` tool, (4) `write_config` tool, (5) config validation export from core, (6) CLI simplification. We also add the onboarding topic as a `get_documentation` fallback.

**Key constraint:** This is deliberately simple. ~440 lines of new code. The intelligence lives in the markdown instruction, not in TypeScript heuristics.

---

## Phase 1: Onboarding Instruction + Core Exports

### Goal
Create `packages/core/src/instructions/onboarding.md` and an `index.ts` barrel that exports it as a string. This is the **core deliverable** -- the instruction document that guides agent behavior.

### 1.1 Create the instruction document

**File:** `packages/core/src/instructions/onboarding.md` (NEW, ~150 lines)

Full content outline:

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
- `pnpm-workspace.yaml`, `lerna.json`, root `package.json` with `workspaces`
  field (workspace/monorepo indicators)
- `tsconfig.json` files (TypeScript project)
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
1. **Name** -- human-readable identifier (e.g., "backend", "dashboard")
2. **Path** -- directory path relative to project root
3. **Entry point** -- the main source file (prefer TypeScript source over
   compiled output)

### How to find entry points
Check in order:
1. `package.json` "source" field (TypeScript source entry)
2. `package.json` "main" field, but look for `.ts` equivalent in `src/`
3. Common patterns: `src/index.ts`, `src/main.ts`, `src/app.ts`,
   `src/server.ts`, `index.ts`
4. For React apps: `src/App.tsx`, `src/index.tsx`
5. Check `bin` field for CLI tools

### When to ask the user
- "I found [X] that looks like [description]. Should I include it as a
  service?"
- "This directory has multiple potential entry points: [list].
  Which should I use?"
- "I found deployment configuration mentioning services not visible in
  the code structure. Should I investigate?"

## Step 3: Run Auto-Discovery (Optional)

Use `discover_services` to see what Grafema's built-in detection finds.
Compare with your own findings from Steps 1-2. Note discrepancies --
auto-discovery may miss services or misidentify entry points.

## Step 4: Configure Plugins

Default plugins work for most JS/TS projects. Adjust if:
- Project uses specific frameworks (Express, React, Socket.IO) -- ensure
  corresponding analyzers are enabled
- Project has Rust components -- add `RustModuleIndexer` and `RustAnalyzer`
- Project has unusual file patterns -- configure `include`/`exclude`

Default plugin list (reference only -- omit from config to use defaults):
  indexing: [JSModuleIndexer]
  analysis: [JSASTAnalyzer, ExpressRouteAnalyzer, ExpressResponseAnalyzer,
    SocketIOAnalyzer, DatabaseAnalyzer, FetchAnalyzer, ServiceLayerAnalyzer]
  enrichment: [MethodCallResolver, ArgumentParameterLinker, AliasTracker,
    ClosureCaptureEnricher, RejectionPropagationEnricher, ValueDomainAnalyzer,
    MountPointResolver, ExpressHandlerLinker, PrefixEvaluator,
    ImportExportLinker, HTTPConnectionEnricher]
  validation: [GraphConnectivityValidator, DataFlowValidator, EvalBanValidator,
    CallResolverValidator, SQLInjectionValidator, ShadowingDetector,
    TypeScriptDeadCodeValidator, BrokenImportValidator]

## Step 5: Write Configuration

Use `write_config` to save the discovered configuration.

The config should include:
- `services` array with all confirmed services (name, path, optional entryPoint)
- `plugins` section (only if overriding defaults)
- `include`/`exclude` patterns (only if needed)
- `workspace.roots` (for multi-root workspaces only)

## Step 6: Verify

Run `analyze_project` to build the graph. Then check:
- `get_stats` -- are node/edge counts reasonable for the project size?
- `get_coverage` -- are the expected files analyzed?

If coverage is low or results are unexpected, iterate:
revisit services, entry points, or include/exclude patterns.

## Common Patterns

### Monorepo with workspaces
Look for `pnpm-workspace.yaml` or `workspaces` in root `package.json`.
Each workspace package is typically a service. Use `read_project_structure`
with depth=2 to see the package layout.

### Legacy project with multiple entry points
Look for `scripts` in `package.json`, `bin` field, or multiple files
in `src/` that look like entry points (contain `app.listen()`,
`createServer()`, `express()`).

### Microservices with shared deployment
Look for `docker-compose.yml`, Kubernetes configs, or similar
deployment manifests that list services. Cross-reference with
code directories.

### Single-package project
If there is only one `package.json` at the root and no monorepo
structure, the project is likely a single service. The service path
is `.` (root), and the entry point is determined from `package.json`.
```

**Design notes:**
- The instruction references Grafema MCP tools by exact name (`read_project_structure`, `discover_services`, `write_config`, `analyze_project`, `get_stats`, `get_coverage`).
- It tells the agent WHEN to ask the user -- this is the interactive element Vadim described.
- It lists common patterns but does NOT try to be exhaustive -- the agent's general intelligence handles novel cases.
- The default plugin list is included as reference so the agent can advise the user, but it says "omit from config to use defaults" to avoid unnecessary config bloat.

### 1.2 Create the barrel export

**File:** `packages/core/src/instructions/index.ts` (NEW, ~20 lines)

```typescript
/**
 * Grafema instruction documents for AI agents.
 *
 * Instructions are markdown documents that guide agent behavior.
 * They are read from the source tree at runtime (or inlined at build time).
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Get the onboarding instruction document.
 *
 * Returns the full markdown text of the onboarding procedure
 * that guides an AI agent through project study and configuration.
 */
export function getOnboardingInstruction(): string {
  return readFileSync(join(__dirname, 'onboarding.md'), 'utf-8');
}
```

**Critical build concern:** The `onboarding.md` file lives in `src/instructions/` but TypeScript compiles `src/` to `dist/`. The `.md` file will NOT be copied by `tsc`. Two options:

**Option A (recommended): Copy `.md` to `dist/` as a build step.**
Add a `postbuild` script to `packages/core/package.json`:
```json
"scripts": {
  "build": "tsc",
  "postbuild": "cp -r src/instructions/*.md dist/instructions/"
}
```
The `readFileSync` in the compiled code (`dist/instructions/index.js`) will then find `dist/instructions/onboarding.md` via `__dirname`.

**Option B: Inline the instruction as a string constant in TypeScript.**
This avoids the copy step but makes the instruction harder to read/edit as a standalone document. NOT recommended because the instruction is a living document that benefits from being a real markdown file.

**Decision: Option A.** The `postbuild` copy is one line and preserves the instruction as a readable markdown document.

### 1.3 Export from core barrel

**File:** `packages/core/src/index.ts` (MODIFY -- add 1 line)

At line 38 (after the Config section), add:
```typescript
// Instructions
export { getOnboardingInstruction } from './instructions/index.js';
```

### 1.4 Ensure `.md` files are in `package.json` `files` array

**File:** `packages/core/package.json` (VERIFY)

Currently includes `"dist"` and `"src"` in the `files` array. After the `postbuild` script copies `.md` to `dist/`, the published package will include it. No change needed here -- `dist` already covers it.

### Acceptance Criteria (Phase 1)
- [ ] `onboarding.md` exists at `packages/core/src/instructions/onboarding.md`
- [ ] `getOnboardingInstruction()` returns the full markdown text
- [ ] Function is exported from `@grafema/core`
- [ ] `npm run build` in `packages/core` succeeds and `dist/instructions/onboarding.md` exists
- [ ] Instruction document references all relevant MCP tool names
- [ ] Instruction includes "when to ask the user" guidance

### Test Plan (Phase 1)
- **Unit test:** `getOnboardingInstruction()` returns a non-empty string
- **Unit test:** Returned string contains expected section headers (`## Step 1`, `## Step 2`, etc.)
- **Unit test:** Returned string contains expected tool names (`read_project_structure`, `write_config`, `discover_services`)

**Test file:** `packages/core/test/instructions.test.ts` (NEW, ~30 lines)

---

## Phase 2: MCP Prompts Capability

### Goal
Add `prompts` capability to the MCP server. Register `prompts/list` and `prompts/get` handlers. Expose the `onboard_project` prompt.

### 2.1 Import prompt schemas from MCP SDK

**File:** `packages/mcp/src/server.ts` (MODIFY -- line 10-13)

Currently imports:
```typescript
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
```

Change to:
```typescript
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
```

These schemas are exported from `@modelcontextprotocol/sdk` v1.25.x (verified in node_modules). They define:
- `ListPromptsRequestSchema` -- validates `prompts/list` requests
- `GetPromptRequestSchema` -- validates `prompts/get` requests with `params.name`

### 2.2 Import `getOnboardingInstruction` from core

**File:** `packages/mcp/src/server.ts` (MODIFY -- add import)

Add after line 18 (after analysis.js import):
```typescript
import { getOnboardingInstruction } from '@grafema/core';
```

### 2.3 Add `prompts` capability

**File:** `packages/mcp/src/server.ts` (MODIFY -- line 83-86)

Currently:
```typescript
{
  capabilities: {
    tools: {},
  },
}
```

Change to:
```typescript
{
  capabilities: {
    tools: {},
    prompts: {},
  },
}
```

### 2.4 Add `prompts/list` handler

**File:** `packages/mcp/src/server.ts` (MODIFY -- add after line 92, after the `ListToolsRequestSchema` handler)

```typescript
// List available prompts
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: [
      {
        name: 'onboard_project',
        description:
          'Step-by-step instructions for studying a new project and ' +
          'configuring Grafema for analysis. Use this when setting up ' +
          'Grafema for the first time on a project.',
        arguments: [],
      },
    ],
  };
});
```

**Note on `title` field:** The MCP SDK v1.25 `PromptSchema` inherits from `BaseMetadataSchema` which includes `name` (required) and `title` (optional from `BaseMetadataSchema.shape`). We include only the standard fields. If `title` is needed in the future, it can be added.

### 2.5 Add `prompts/get` handler

**File:** `packages/mcp/src/server.ts` (MODIFY -- add immediately after the `prompts/list` handler)

```typescript
// Get prompt by name
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name } = request.params;

  if (name === 'onboard_project') {
    const instruction = getOnboardingInstruction();
    return {
      description:
        'Step-by-step instructions for studying a new project and ' +
        'configuring Grafema for analysis.',
      messages: [
        {
          role: 'user' as const,
          content: {
            type: 'text' as const,
            text: instruction,
          },
        },
      ],
    };
  }

  throw new McpError(
    ErrorCode.InvalidRequest,
    `Unknown prompt: ${name}. Available prompts: onboard_project`
  );
});
```

**Error handling note:** The MCP SDK's `Server` class expects handlers to throw `McpError` for known error conditions. We need to import it:

```typescript
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
```

Verify these exports exist in the SDK. If `McpError` is not exported from `types.js`, check `@modelcontextprotocol/sdk/server/index.js` or use a plain `Error` (the SDK's handler wrapper catches generic errors and converts them to protocol errors).

**Fallback:** If `McpError` is not available, throw a plain `Error`:
```typescript
throw new Error(`Unknown prompt: ${name}`);
```

### Acceptance Criteria (Phase 2)
- [ ] MCP server declares `prompts` capability
- [ ] `prompts/list` returns `[{name: 'onboard_project', ...}]`
- [ ] `prompts/get` with `name: 'onboard_project'` returns the instruction as a PromptMessage
- [ ] `prompts/get` with unknown name returns an error
- [ ] The returned message has `role: 'user'` and `content.type: 'text'`

### Test Plan (Phase 2)

**Test file:** `packages/mcp/test/prompts.test.ts` (NEW, ~80 lines)

Since the existing test infrastructure uses a harness that doesn't instantiate the real MCP server, we test the prompts handlers via **direct function calls** -- extract the handler logic into a testable function (like the existing `handlers.ts` pattern) or test via a lightweight harness.

**Pragmatic approach:** The prompts handlers are trivial (return static data). We can test them as unit functions without the full MCP server:

```typescript
describe('MCP Prompts', () => {
  describe('prompts/list', () => {
    it('should return onboard_project prompt', () => {
      // Call the list handler function
      // Verify response has prompts array with one entry
      // Verify name is 'onboard_project'
      // Verify description is non-empty
    });
  });

  describe('prompts/get', () => {
    it('should return onboarding instruction for onboard_project', () => {
      // Call the get handler function with name: 'onboard_project'
      // Verify response.messages has one entry
      // Verify message.role is 'user'
      // Verify message.content.type is 'text'
      // Verify message.content.text contains expected section headers
    });

    it('should throw error for unknown prompt name', () => {
      // Call the get handler with name: 'nonexistent'
      // Verify it throws
    });
  });
});
```

**Implementation note for testability:** Extract prompts handler logic into `packages/mcp/src/prompts.ts` (NEW, ~40 lines):

```typescript
import { getOnboardingInstruction } from '@grafema/core';

export interface PromptDefinition {
  name: string;
  description: string;
  arguments: Array<{ name: string; description: string; required?: boolean }>;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface PromptResult {
  description: string;
  messages: PromptMessage[];
}

export const PROMPTS: PromptDefinition[] = [
  {
    name: 'onboard_project',
    description:
      'Step-by-step instructions for studying a new project and ' +
      'configuring Grafema for analysis. Use this when setting up ' +
      'Grafema for the first time on a project.',
    arguments: [],
  },
];

export function getPrompt(name: string): PromptResult {
  if (name === 'onboard_project') {
    const instruction = getOnboardingInstruction();
    return {
      description: PROMPTS[0].description,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: instruction,
          },
        },
      ],
    };
  }

  throw new Error(
    `Unknown prompt: ${name}. Available prompts: ${PROMPTS.map(p => p.name).join(', ')}`
  );
}
```

This makes the handlers in `server.ts` thin wrappers:
```typescript
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: PROMPTS };
});

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  return getPrompt(request.params.name);
});
```

And the tests import `PROMPTS` and `getPrompt` directly.

---

## Phase 3: New MCP Tools (`read_project_structure` + `write_config`)

### Goal
Add two new tools to the MCP server. These provide the agent with (a) raw project filesystem data and (b) config-writing capability.

### 3.1 `read_project_structure` Tool

#### 3.1.1 Tool Definition

**File:** `packages/mcp/src/definitions.ts` (MODIFY -- add to TOOLS array)

Add after the `get_function_details` definition (end of array, before the closing `]`):

```typescript
{
  name: 'read_project_structure',
  description: `Get the directory structure of the project.
Returns a tree of files and directories, useful for understanding
project layout during onboarding.

Excludes: node_modules, .git, dist, build, .grafema, coverage, .next, .nuxt

Use this tool when studying a new project to identify services,
packages, and entry points.`,
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
},
```

#### 3.1.2 Handler Implementation

**File:** `packages/mcp/src/handlers.ts` (MODIFY -- add handler function)

Add at the end of the file (before the `formatCallsForDisplay` helper or after `handleReportIssue`):

```typescript
// === PROJECT STRUCTURE (REG-173) ===

export interface ReadProjectStructureArgs {
  path?: string;
  depth?: number;
  include_files?: boolean;
}

/**
 * Read the project directory structure.
 *
 * Returns a depth-limited tree of files and directories.
 * No classification, no heuristics -- just raw filesystem listing.
 * The agent interprets the listing using the onboarding instruction.
 */
export async function handleReadProjectStructure(
  args: ReadProjectStructureArgs
): Promise<ToolResult> {
  const projectPath = getProjectPath();
  const subPath = args.path || '.';
  const maxDepth = Math.min(Math.max(1, args.depth || 3), 5);
  const includeFiles = args.include_files !== false; // default true

  const targetPath = join(projectPath, subPath);

  if (!existsSync(targetPath)) {
    return errorResult(`Path does not exist: ${subPath}`);
  }

  if (!statSync(targetPath).isDirectory()) {
    return errorResult(`Path is not a directory: ${subPath}`);
  }

  const EXCLUDED = new Set([
    'node_modules', '.git', 'dist', 'build', '.grafema',
    'coverage', '.next', '.nuxt', '.cache', '.output',
    '__pycache__', '.tox', 'target',
  ]);

  const lines: string[] = [];

  function walk(dir: string, prefix: string, depth: number): void {
    if (depth > maxDepth) return;

    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return; // skip unreadable directories
    }

    // Filter excluded directories
    const dirs: string[] = [];
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.startsWith('.') && EXCLUDED.has(entry)) continue;
      if (EXCLUDED.has(entry)) continue;

      const fullPath = join(dir, entry);
      let stat;
      try {
        stat = statSync(fullPath);
      } catch {
        continue; // skip broken symlinks etc.
      }

      if (stat.isDirectory()) {
        dirs.push(entry);
      } else if (includeFiles) {
        files.push(entry);
      }
    }

    // Print directories first, then files
    const allEntries = [
      ...dirs.map(d => ({ name: d, isDir: true })),
      ...files.map(f => ({ name: f, isDir: false })),
    ];

    for (let i = 0; i < allEntries.length; i++) {
      const entry = allEntries[i];
      const isLast = i === allEntries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (entry.isDir) {
        lines.push(`${prefix}${connector}${entry.name}/`);
        walk(join(dir, entry.name), prefix + childPrefix, depth + 1);
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  }

  lines.push(subPath === '.' ? basename(projectPath) + '/' : subPath + '/');
  walk(targetPath, '', 1);

  if (lines.length === 1) {
    return textResult(`Directory is empty or contains only excluded entries: ${subPath}`);
  }

  return textResult(lines.join('\n'));
}
```

**Required imports in handlers.ts:** Add to existing imports at the top:
```typescript
import { existsSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
```

(`existsSync` and `statSync` may already be imported in other files; check and add only what's missing. Currently `handlers.ts` has no `fs` imports -- they need to be added.)

#### 3.1.3 Type Definition

**File:** `packages/mcp/src/types.ts` (MODIFY -- add interface)

Add after `GetDocumentationArgs`:

```typescript
// === READ PROJECT STRUCTURE (REG-173) ===

export interface ReadProjectStructureArgs {
  path?: string;
  depth?: number;
  include_files?: boolean;
}
```

(Remove the inline interface from handlers.ts if the type is defined here.)

#### 3.1.4 Wire into server.ts switch

**File:** `packages/mcp/src/server.ts` (MODIFY -- add case in switch statement)

Add after the `get_function_details` case (around line 185):

```typescript
case 'read_project_structure':
  result = await handleReadProjectStructure(
    asArgs<ReadProjectStructureArgs>(args)
  );
  break;
```

And add to imports:
```typescript
import { handleReadProjectStructure } from './handlers.js';
import type { ReadProjectStructureArgs } from './types.js';
```

**Complexity Analysis:**
- **Time:** O(n) where n = number of filesystem entries up to maxDepth. With depth=3 and excluded directories, this is typically <1000 entries. Bounded by max depth 5.
- **Memory:** O(n) for the lines array. Bounded by same limit.
- **No graph access:** This tool does NOT touch the RFDB backend. It is purely filesystem.

### 3.2 `write_config` Tool

#### 3.2.1 Tool Definition

**File:** `packages/mcp/src/definitions.ts` (MODIFY -- add to TOOLS array)

Add after `read_project_structure`:

```typescript
{
  name: 'write_config',
  description: `Write or update the Grafema configuration file (.grafema/config.yaml).
Validates all inputs before writing. Creates .grafema/ directory if needed.

Use this tool after studying the project to save the discovered configuration.
Only include fields you want to override -- defaults are used for omitted fields.`,
  inputSchema: {
    type: 'object',
    properties: {
      services: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Service name (e.g., "backend")' },
            path: { type: 'string', description: 'Path relative to project root (e.g., "apps/backend")' },
            entryPoint: { type: 'string', description: 'Entry point file relative to service path (e.g., "src/index.ts")' },
          },
          required: ['name', 'path'],
        },
        description: 'Service definitions (leave empty to use auto-discovery)',
      },
      plugins: {
        type: 'object',
        properties: {
          indexing: { type: 'array', items: { type: 'string' }, description: 'Indexing plugins' },
          analysis: { type: 'array', items: { type: 'string' }, description: 'Analysis plugins' },
          enrichment: { type: 'array', items: { type: 'string' }, description: 'Enrichment plugins' },
          validation: { type: 'array', items: { type: 'string' }, description: 'Validation plugins' },
        },
        description: 'Plugin configuration (omit to use defaults)',
      },
      include: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns for files to include (e.g., ["src/**/*.ts"])',
      },
      exclude: {
        type: 'array',
        items: { type: 'string' },
        description: 'Glob patterns for files to exclude (e.g., ["**/*.test.ts"])',
      },
      workspace: {
        type: 'object',
        properties: {
          roots: {
            type: 'array',
            items: { type: 'string' },
            description: 'Root directories for multi-root workspace',
          },
        },
        description: 'Multi-root workspace config (only for workspaces)',
      },
    },
  },
},
```

#### 3.2.2 Handler Implementation

**File:** `packages/mcp/src/handlers.ts` (MODIFY -- add handler function)

```typescript
// === WRITE CONFIG (REG-173) ===

export interface WriteConfigArgs {
  services?: Array<{
    name: string;
    path: string;
    entryPoint?: string;
  }>;
  plugins?: {
    indexing?: string[];
    analysis?: string[];
    enrichment?: string[];
    validation?: string[];
  };
  include?: string[];
  exclude?: string[];
  workspace?: {
    roots?: string[];
  };
}

/**
 * Write or update .grafema/config.yaml.
 *
 * Validates input using exported ConfigLoader validators.
 * Merges with DEFAULT_CONFIG for omitted fields.
 * Creates .grafema/ directory if it doesn't exist.
 */
export async function handleWriteConfig(
  args: WriteConfigArgs
): Promise<ToolResult> {
  const projectPath = getProjectPath();
  const grafemaDir = join(projectPath, '.grafema');
  const configPath = join(grafemaDir, 'config.yaml');

  try {
    // 1. Validate services
    if (args.services) {
      validateServices(args.services, projectPath);
    }

    // 2. Validate include/exclude patterns
    if (args.include !== undefined || args.exclude !== undefined) {
      const warnings: string[] = [];
      validatePatterns(args.include, args.exclude, {
        warn: (msg: string) => warnings.push(msg),
      });
      // Warnings are non-fatal, we continue but report them
    }

    // 3. Validate workspace
    if (args.workspace) {
      validateWorkspace(args.workspace, projectPath);
    }

    // 4. Build config object (merge with defaults for omitted fields)
    const config: Record<string, unknown> = {};

    if (args.services && args.services.length > 0) {
      config.services = args.services;
    }

    if (args.plugins) {
      config.plugins = args.plugins;
    }

    if (args.include) {
      config.include = args.include;
    }

    if (args.exclude) {
      config.exclude = args.exclude;
    }

    if (args.workspace) {
      config.workspace = args.workspace;
    }

    // 5. Generate YAML
    const yaml = stringifyYAML(config, { lineWidth: 0 });
    const content =
      '# Grafema Configuration\n' +
      '# Generated by Grafema onboarding\n' +
      '# Documentation: https://github.com/grafema/grafema#configuration\n\n' +
      yaml;

    // 6. Ensure directory exists
    if (!existsSync(grafemaDir)) {
      mkdirSync(grafemaDir, { recursive: true });
    }

    // 7. Write file
    writeFileSync(configPath, content);

    // 8. Build response summary
    const summary: string[] = ['Configuration written to .grafema/config.yaml'];

    if (args.services && args.services.length > 0) {
      summary.push(`Services: ${args.services.map(s => s.name).join(', ')}`);
    } else {
      summary.push('Services: using auto-discovery (none explicitly configured)');
    }

    if (args.plugins) {
      summary.push('Plugins: custom configuration');
    } else {
      summary.push('Plugins: using defaults');
    }

    if (args.include) {
      summary.push(`Include patterns: ${args.include.join(', ')}`);
    }

    if (args.exclude) {
      summary.push(`Exclude patterns: ${args.exclude.join(', ')}`);
    }

    if (args.workspace?.roots) {
      summary.push(`Workspace roots: ${args.workspace.roots.join(', ')}`);
    }

    summary.push('\nNext step: run analyze_project to build the graph.');

    return textResult(summary.join('\n'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to write config: ${message}`);
  }
}
```

**Required imports in handlers.ts:**
```typescript
import { existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { stringify as stringifyYAML } from 'yaml';
import { validateServices, validatePatterns, validateWorkspace } from '@grafema/core';
```

Note: The `yaml` package is already a dependency of `@grafema/core` but needs to be added to `packages/mcp/package.json` dependencies if not already present. Check: the MCP package does NOT currently depend on `yaml`. **Add `yaml` to MCP dependencies** or import the stringify from core via a thin wrapper.

**Decision: Add `yaml` to MCP `package.json`** -- it is a small, zero-dep package and the MCP server should own its serialization. Alternatively, re-export `stringify` from `@grafema/core` -- but that muddies the core API. Direct dependency is cleaner.

#### 3.2.3 Type Definition

**File:** `packages/mcp/src/types.ts` (MODIFY -- add interface)

```typescript
// === WRITE CONFIG (REG-173) ===

export interface WriteConfigArgs {
  services?: Array<{
    name: string;
    path: string;
    entryPoint?: string;
  }>;
  plugins?: {
    indexing?: string[];
    analysis?: string[];
    enrichment?: string[];
    validation?: string[];
  };
  include?: string[];
  exclude?: string[];
  workspace?: {
    roots?: string[];
  };
}
```

#### 3.2.4 Wire into server.ts

**File:** `packages/mcp/src/server.ts` (MODIFY)

Add case in switch:
```typescript
case 'write_config':
  result = await handleWriteConfig(asArgs<WriteConfigArgs>(args));
  break;
```

Add to imports:
```typescript
import { handleWriteConfig } from './handlers.js';
import type { WriteConfigArgs } from './types.js';
```

### Acceptance Criteria (Phase 3)
- [ ] `read_project_structure` returns a tree for a valid project path
- [ ] `read_project_structure` excludes `node_modules`, `.git`, etc.
- [ ] `read_project_structure` respects `depth` parameter (max 5)
- [ ] `read_project_structure` returns error for non-existent path
- [ ] `write_config` creates `.grafema/config.yaml` with valid YAML
- [ ] `write_config` validates services (name, path exist, path is directory)
- [ ] `write_config` validates include/exclude patterns
- [ ] `write_config` validates workspace roots
- [ ] `write_config` returns clear error messages on validation failure
- [ ] `write_config` creates `.grafema/` directory if missing
- [ ] Both tools appear in `tools/list` response

### Test Plan (Phase 3)

**Test file:** `packages/mcp/test/tools-onboarding.test.ts` (NEW, ~150 lines)

```typescript
describe('read_project_structure', () => {
  it('should return tree for project root');
  it('should respect depth parameter');
  it('should exclude node_modules, .git, dist');
  it('should handle include_files=false (directories only)');
  it('should return error for non-existent path');
  it('should return error for non-directory path');
  it('should handle empty directory');
  it('should handle subdirectory path');
});

describe('write_config', () => {
  // Use a temp directory for these tests
  it('should write valid YAML config');
  it('should create .grafema/ directory if missing');
  it('should write services to config');
  it('should validate service paths exist');
  it('should reject absolute service paths');
  it('should validate include/exclude patterns');
  it('should validate workspace roots');
  it('should return summary of written config');
  it('should handle empty services (auto-discovery mode)');
  it('should handle plugins override');
});
```

Tests for `write_config` need a temp directory. Use `node:fs/promises` `mkdtemp` to create a temp project directory with a `package.json` and some subdirectories. Clean up in `afterEach`.

**Complexity Analysis for write_config:**
- **Time:** O(s) where s = number of services (for path validation via `existsSync`/`statSync`). Typically <20.
- **Memory:** O(1) beyond the config object.
- **IO:** One `writeFileSync` call.

---

## Phase 4: Export Config Validation Functions from Core

### Goal
The `validateServices`, `validatePatterns`, and `validateWorkspace` functions in `ConfigLoader.ts` are currently `function` (module-scoped, not `export`). The `write_config` handler needs them. Export them.

### 4.1 Make validation functions exportable

**File:** `packages/core/src/config/ConfigLoader.ts` (MODIFY)

Change three function declarations from:
```typescript
function validateServices(services: unknown, projectPath: string): void {
```
to:
```typescript
export function validateServices(services: unknown, projectPath: string): void {
```

Same for:
```typescript
export function validateWorkspace(workspace: unknown, projectPath: string): void {
export function validatePatterns(
  include: unknown,
  exclude: unknown,
  logger: { warn: (msg: string) => void }
): void {
```

**Lines affected:**
- `validateServices`: line 251
- `validateWorkspace`: line 328
- `validatePatterns`: line 406

This is a **non-breaking change** -- adding `export` to existing functions does not change behavior for existing callers.

### 4.2 Export from config barrel

**File:** `packages/core/src/config/index.ts` (MODIFY)

Currently:
```typescript
export { loadConfig, DEFAULT_CONFIG } from './ConfigLoader.js';
export type { GrafemaConfig } from './ConfigLoader.js';
```

Change to:
```typescript
export {
  loadConfig,
  DEFAULT_CONFIG,
  validateServices,
  validatePatterns,
  validateWorkspace,
} from './ConfigLoader.js';
export type { GrafemaConfig } from './ConfigLoader.js';
```

### 4.3 Export from core barrel

**File:** `packages/core/src/index.ts` (MODIFY -- line 37-38)

Currently:
```typescript
export { loadConfig, DEFAULT_CONFIG } from './config/index.js';
export type { GrafemaConfig } from './config/index.js';
```

Change to:
```typescript
export {
  loadConfig,
  DEFAULT_CONFIG,
  validateServices,
  validatePatterns,
  validateWorkspace,
} from './config/index.js';
export type { GrafemaConfig } from './config/index.js';
```

### 4.4 Add `onboarding` topic to `get_documentation` (fallback)

**File:** `packages/mcp/src/handlers.ts` (MODIFY -- inside `handleGetDocumentation`)

In the `docs` object (around line 824), add a new topic:

```typescript
onboarding: getOnboardingInstruction(),
```

This requires importing `getOnboardingInstruction` in `handlers.ts`:
```typescript
import { getOnboardingInstruction } from '@grafema/core';
```

Also update the `get_documentation` tool definition in `definitions.ts` to include `onboarding` in the topic list:

**File:** `packages/mcp/src/definitions.ts` (MODIFY)

Change:
```typescript
description: 'Topic: queries, types, guarantees, or overview',
```
To:
```typescript
description: 'Topic: queries, types, guarantees, onboarding, or overview',
```

### Acceptance Criteria (Phase 4)
- [ ] `validateServices`, `validatePatterns`, `validateWorkspace` are exported from `@grafema/core`
- [ ] `get_documentation` with `topic: 'onboarding'` returns the onboarding instruction
- [ ] Existing `loadConfig` behavior unchanged (existing tests pass)

### Test Plan (Phase 4)
- **Unit test:** Import `validateServices` from `@grafema/core` -- no import error
- **Unit test:** `validateServices` throws for invalid service objects (existing behavior, now testable externally)
- **Unit test:** `get_documentation({topic: 'onboarding'})` returns non-empty instruction text
- Run existing ConfigLoader tests to verify no regression

---

## Phase 5: Simplify `grafema init` CLI

### Goal
Simplify the CLI init command to be a bootstrap step that references the onboarding instruction, rather than an interactive wizard.

### 5.1 Modifications to init.ts

**File:** `packages/cli/src/commands/init.ts` (MODIFY)

Changes:
1. **Add onboarding reference to `printNextSteps()`** -- update the function to mention the onboarding instruction:

```typescript
function printNextSteps(): void {
  console.log('');
  console.log('Next steps:');
  console.log('  1. Review config:  code .grafema/config.yaml');
  console.log('  2. Build graph:    grafema analyze');
  console.log('  3. Explore:        grafema overview');
  console.log('');
  console.log('For AI-assisted setup, use the Grafema MCP server');
  console.log('with the "onboard_project" prompt.');
}
```

This is a minimal change -- just add the MCP onboarding reference. We do NOT remove the interactive analyze prompt or the existing flow. The current init is already simple (199 lines, no Ink UI). Per Don's plan: "No Ink components, no ProjectScanner call, no service selection UI" -- and indeed none of those exist in the current code.

**What we do NOT change:**
- `package.json` detection (keep -- it's a valid prerequisite check)
- TypeScript detection (keep -- useful info)
- Config generation (keep -- generates working defaults)
- `.gitignore` update (keep -- useful)
- Interactive "Run analysis now?" prompt (keep -- good UX for humans)
- `--yes` mode (keep -- unchanged)

The init command is already appropriately simple. The main change is adding the reference to the MCP onboarding prompt so users know it exists.

### Acceptance Criteria (Phase 5)
- [ ] `grafema init` prints reference to MCP onboarding prompt in next steps
- [ ] All existing `grafema init` behavior preserved
- [ ] `--yes` mode unchanged

### Test Plan (Phase 5)
- Manual verification: run `grafema init` in a test project, verify output includes MCP reference
- Existing CLI test coverage (if any) continues to pass

---

## Phase 6: Tests

### Goal
Comprehensive tests for all new components.

### 6.1 Test files

| File | Tests | Est. Lines |
|------|-------|------------|
| `packages/core/test/instructions.test.ts` | Instruction loading | ~30 |
| `packages/mcp/test/prompts.test.ts` | Prompts handlers | ~80 |
| `packages/mcp/test/tools-onboarding.test.ts` | New tools | ~150 |
| **Total** | | ~260 |

### 6.2 Test infrastructure needs

**For `read_project_structure` tests:**
- Create temp directory with known structure
- Use `mkdtempSync` from `node:fs`
- Clean up in `afterEach`

**For `write_config` tests:**
- Create temp directory with `package.json`
- Create subdirectories to simulate service paths
- Verify written YAML content
- Clean up in `afterEach`

**For prompts tests:**
- Import `PROMPTS` and `getPrompt` from `prompts.ts`
- No filesystem or backend needed

### 6.3 Integration test: agent flow simulation

This is NOT an automated test but a **manual verification**:

1. Start MCP server for a known project
2. Call `prompts/list` -- verify `onboard_project` appears
3. Call `prompts/get` for `onboard_project` -- verify instruction returned
4. Call `read_project_structure` -- verify tree returned
5. Call `write_config` with services -- verify config written
6. Call `analyze_project` -- verify analysis succeeds
7. Call `get_stats` -- verify reasonable counts

This can be scripted with `npx @modelcontextprotocol/inspector` or a simple test client if time permits, but manual verification is sufficient for MVP.

---

## Dependencies Between Phases

```
Phase 1 (instruction + core exports)
  │
  ├──> Phase 2 (MCP prompts -- needs getOnboardingInstruction from Phase 1)
  │
  └──> Phase 4 (config validation export -- can be done in parallel with Phase 2)
         │
         └──> Phase 3 (new tools -- needs exported validators from Phase 4)
                │
                └──> Phase 5 (CLI simplification -- can run any time after Phase 1)
                       │
                       └──> Phase 6 (tests -- after all implementation)
```

**Critical path:** Phase 1 -> Phase 4 -> Phase 3 -> Phase 6

**Parallelizable:** Phase 2 and Phase 4 can be done in parallel after Phase 1. Phase 5 can be done any time after Phase 1.

---

## Edge Cases

### MCP client without prompts support
- The agent can still use `get_documentation` with `topic: 'onboarding'` (Phase 4 adds this fallback)
- The instruction is available as a regular file in the installed package

### Invalid config data from agent
- `write_config` validates ALL inputs before writing
- Validation errors return clear messages: "Config error: services[0].path does not exist"
- Partial writes do NOT occur -- validation fails before any filesystem write

### Project with no package.json
- `read_project_structure` works regardless -- it is just a directory listing
- `write_config` works regardless -- it writes YAML to `.grafema/`
- `grafema init` already checks for `package.json` and gives a clear error
- The onboarding instruction mentions `package.json` as an indicator but does not require it

### Agent calling write_config with conflicting data
- If services array has duplicate names: currently not validated, but YAML will just have duplicates. This is a minor edge case -- the agent is unlikely to produce duplicates. Could add validation later if needed.
- If called multiple times: last write wins (overwrites previous config). This is correct behavior -- the agent iterates on the config.
- If called with both services and workspace.roots pointing to same paths: valid configuration, not a conflict.

### Agent calling write_config before read_project_structure
- Works fine -- write_config validates paths independently
- The instruction tells the agent to study first, but it is not enforced in code (by design -- the instruction is a guide, not a strait jacket)

### Very large project (>10k files)
- `read_project_structure` with depth=3 and excluded directories will still return a manageable tree
- If the tree is too large, `guardResponseSize` (existing utility, 100KB limit) will truncate it
- The agent can use `path` parameter to scan subdirectories separately

### Empty .grafema/ directory already exists
- `write_config` overwrites `config.yaml` if it exists
- `.grafema/` directory creation is idempotent (`mkdirSync` with `recursive: true`)

---

## Files Modified/Created Summary

### New Files (5)
| File | Package | Purpose |
|------|---------|---------|
| `packages/core/src/instructions/onboarding.md` | core | Onboarding instruction document |
| `packages/core/src/instructions/index.ts` | core | Barrel export for instructions |
| `packages/mcp/src/prompts.ts` | mcp | Prompts handler logic (testable) |
| `packages/core/test/instructions.test.ts` | core | Tests for instruction loading |
| `packages/mcp/test/prompts.test.ts` | mcp | Tests for prompts handlers |
| `packages/mcp/test/tools-onboarding.test.ts` | mcp | Tests for new tools |

### Modified Files (7)
| File | Package | Changes |
|------|---------|---------|
| `packages/core/src/index.ts` | core | Add instruction + validator exports |
| `packages/core/src/config/index.ts` | core | Export validation functions |
| `packages/core/src/config/ConfigLoader.ts` | core | Add `export` to 3 validation functions |
| `packages/core/package.json` | core | Add `postbuild` script for .md copy |
| `packages/mcp/src/server.ts` | mcp | Add prompts capability + handlers + new tool cases |
| `packages/mcp/src/definitions.ts` | mcp | Add 2 tool definitions |
| `packages/mcp/src/handlers.ts` | mcp | Add 2 handler functions + onboarding doc topic |
| `packages/mcp/src/types.ts` | mcp | Add 2 arg interfaces |
| `packages/mcp/package.json` | mcp | Add `yaml` dependency |
| `packages/cli/src/commands/init.ts` | cli | Add MCP onboarding reference |

### Estimated Lines
| Category | Lines |
|----------|-------|
| Instruction document (onboarding.md) | ~150 |
| Instructions barrel (index.ts) | ~20 |
| Prompts handler (prompts.ts) | ~50 |
| read_project_structure handler | ~80 |
| write_config handler | ~80 |
| Tool definitions | ~50 |
| Type definitions | ~20 |
| Server.ts changes | ~30 |
| CLI changes | ~5 |
| Config export changes | ~10 |
| **Total implementation** | **~495** |
| Tests | ~260 |
| **Grand total** | **~755** |

---

## Estimated Effort (Revised)

| Phase | Description | Estimate |
|-------|-------------|----------|
| Phase 1 | Onboarding instruction + core exports | 0.5 day |
| Phase 2 | MCP Prompts capability + handlers | 0.5 day |
| Phase 3 | `read_project_structure` + `write_config` tools | 1 day |
| Phase 4 | Export ConfigLoader validators + docs fallback | 0.25 day |
| Phase 5 | Simplify CLI init | 0.25 day |
| Phase 6 | Tests for all new components | 1 day |
| **Total** | | **3.5 days** |

This is lower than Don's 5-7 day estimate because:
1. The CLI init is already simple -- minimal changes needed
2. The prompts handler is trivially simple (return static data)
3. The instruction document structure is well-defined in Don's plan

---

## Open Questions for Don/Vadim

1. **Instruction refinement cadence:** Should we create a Linear issue to track instruction updates after each real onboarding? (Recommendation: yes, label it v0.2)
2. **`yaml` dependency for MCP package:** The MCP package needs to write YAML. Add direct dependency on `yaml` package, or re-export stringify from core? (Recommendation: direct dependency)
3. **`read_project_structure` hidden files:** Should we hide ALL dotfiles (`.env`, `.eslintrc`, etc.) or only the ones in the EXCLUDED set? (Recommendation: only EXCLUDED set -- dotfiles like `.env` are informative for understanding the project)

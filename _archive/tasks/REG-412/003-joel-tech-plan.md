# Joel Spolsky Tech Plan: REG-412 — `grafema file <path>` command

## Overview

Detailed implementation specification expanding Don's plan into exact function signatures, edge queries, output formatting, and test cases. Every code reference is grounded in the actual codebase as read during this planning session.

---

## Step 1: Core Class — `FileOverview`

**File:** `packages/core/src/core/FileOverview.ts`

### 1.1 Imports and Type Definitions

```typescript
import type { GraphBackend, BaseNodeRecord, NodeFilter } from '@grafema/types';
import type { CallInfo, FindCallsOptions } from '../queries/types.js';
import { findCallsInFunction } from '../queries/findCallsInFunction.js';
```

Note: We import `findCallsInFunction` from `../queries/findCallsInFunction.js` (the same utility used by `handleGetFunctionDetails` in MCP handlers at `packages/mcp/src/handlers.ts:1035`). This avoids reinventing call resolution.

### 1.2 Result Types

```typescript
/** Information about an import in a file */
export interface ImportInfo {
  /** Node ID (semantic ID for querying) */
  id: string;
  /** Module source path (e.g., "express", "./utils") */
  source: string;
  /** Imported specifier names (e.g., ["Router", "default"]) */
  specifiers: string[];
}

/** Information about an export in a file */
export interface ExportInfo {
  /** Node ID */
  id: string;
  /** Exported name */
  name: string;
  /** Whether this is a default export */
  isDefault: boolean;
}

/** Overview of a function or method with its key relationships */
export interface FunctionOverview {
  /** Node ID */
  id: string;
  /** Function/method name */
  name: string;
  /** Line number in source */
  line?: number;
  /** Whether function is async */
  async: boolean;
  /** Parameter names (if available on node) */
  params?: string[];
  /** Names of called functions (resolved CALLS targets) */
  calls: string[];
  /** Return type or description (from node.returnType) */
  returnType?: string;
  /** Full signature string if available (from node.signature) */
  signature?: string;
}

/** Overview of a class with its methods */
export interface ClassOverview {
  /** Node ID */
  id: string;
  /** Class name */
  name: string;
  /** Line number */
  line?: number;
  /** Superclass name (from EXTENDS edge) */
  extends?: string;
  /** Whether class is exported */
  exported: boolean;
  /** Methods within the class */
  methods: FunctionOverview[];
}

/** Overview of a variable declaration */
export interface VariableOverview {
  /** Node ID */
  id: string;
  /** Variable name */
  name: string;
  /** Line number */
  line?: number;
  /** Declaration kind: const, let, var */
  kind: string;
  /** Description of assigned value (from ASSIGNED_FROM edge target name) */
  assignedFrom?: string;
}

/** Complete file overview result */
export interface FileOverviewResult {
  /** File path (as queried) */
  file: string;
  /** Whether the file has been analyzed */
  status: 'ANALYZED' | 'NOT_ANALYZED';
  /** Import declarations */
  imports: ImportInfo[];
  /** Export declarations */
  exports: ExportInfo[];
  /** Top-level classes */
  classes: ClassOverview[];
  /** Top-level functions (not class methods) */
  functions: FunctionOverview[];
  /** Top-level variables/constants */
  variables: VariableOverview[];
}
```

**Design note:** These types map closely to the node record types in `packages/types/src/nodes.ts`:
- `FunctionNodeRecord` has `async`, `params`, `returnType`, `signature` fields
- `ClassNodeRecord` has `exported`, `superClass` fields
- `VariableNodeRecord` has `kind` field
- `ImportNodeRecord` has `source`, `specifiers` fields
- `ExportNodeRecord` has `exportedName`, `isDefault` fields

### 1.3 Node Types to Include/Exclude

From the MODULE node's CONTAINS edges, we only want "interesting" top-level entities:

```typescript
/** Node types we display in the file overview */
const OVERVIEW_NODE_TYPES = new Set([
  'FUNCTION',
  'CLASS',
  'METHOD',       // Standalone methods (rare, but possible)
  'VARIABLE',
  'CONSTANT',
  'IMPORT',
  'EXPORT',
]);
```

We skip: `SCOPE`, `CALL`, `METHOD_CALL`, `EXPRESSION`, `PARAMETER`, `LITERAL`, `BRANCH`, `CASE`, `LOOP`, `TRY_BLOCK`, `CATCH_BLOCK`, `FINALLY_BLOCK`, `PROPERTY_ACCESS`, `ARGUMENT_EXPRESSION`. These are structural/internal nodes — they clutter the overview.

### 1.4 Class Implementation

```typescript
/**
 * FileOverview - Get a structured overview of all entities in a file.
 *
 * Purpose: Show what a file contains and how its parts relate to each other.
 * Unlike FileExplainer (which lists ALL nodes flat), FileOverview shows only
 * meaningful entities (functions, classes, variables) with their key relationships
 * (calls, extends, assigned-from).
 *
 * Unlike the context command (which shows ONE node's full neighborhood),
 * FileOverview shows ALL entities at file level with curated edges.
 *
 * Use this when:
 * - AI agent needs to understand a file before diving deeper
 * - User wants a table-of-contents of a file with relationships
 * - Quick orientation before using get_context on specific nodes
 *
 * @example
 * ```typescript
 * const overview = new FileOverview(backend);
 * const result = await overview.getOverview('/abs/path/to/file.js');
 * // result.functions[0].calls -> ["express", "Router"]
 * ```
 */
export class FileOverview {
  constructor(private graph: GraphBackend) {}

  /**
   * Get structured overview of a file's entities and relationships.
   *
   * @param filePath - Absolute file path (after realpath resolution)
   * @param options - Optional: { includeEdges: boolean }
   * @returns FileOverviewResult
   */
  async getOverview(
    filePath: string,
    options: { includeEdges?: boolean } = {}
  ): Promise<FileOverviewResult> {
    const { includeEdges = true } = options;

    // Step 1: Find MODULE node
    const moduleNode = await this.findModuleNode(filePath);
    if (!moduleNode) {
      return {
        file: filePath,
        status: 'NOT_ANALYZED',
        imports: [],
        exports: [],
        classes: [],
        functions: [],
        variables: [],
      };
    }

    // Step 2: Get direct children via CONTAINS edges
    const children = await this.getTopLevelEntities(moduleNode.id);

    // Step 3: Categorize and enrich
    const imports: ImportInfo[] = [];
    const exports: ExportInfo[] = [];
    const classes: ClassOverview[] = [];
    const functions: FunctionOverview[] = [];
    const variables: VariableOverview[] = [];

    for (const child of children) {
      switch (child.type) {
        case 'IMPORT':
          imports.push(this.buildImportInfo(child));
          break;

        case 'EXPORT':
          exports.push(this.buildExportInfo(child));
          break;

        case 'CLASS':
          classes.push(
            await this.buildClassOverview(child, includeEdges)
          );
          break;

        case 'FUNCTION':
        case 'METHOD':
          functions.push(
            await this.buildFunctionOverview(child, includeEdges)
          );
          break;

        case 'VARIABLE':
        case 'CONSTANT':
          variables.push(
            await this.buildVariableOverview(child, includeEdges)
          );
          break;
      }
    }

    // Step 4: Sort each group by line number
    const byLine = (
      a: { line?: number },
      b: { line?: number }
    ) => (a.line ?? 0) - (b.line ?? 0);

    imports.sort(byLine);
    exports.sort(byLine);
    classes.sort(byLine);
    functions.sort(byLine);
    variables.sort(byLine);

    return {
      file: filePath,
      status: 'ANALYZED',
      imports,
      exports,
      classes,
      functions,
      variables,
    };
  }

  // === Private Methods ===

  /**
   * Find the MODULE node for the given file path.
   *
   * Uses queryNodes({file: filePath, type: 'MODULE'}).
   * The graph stores absolute paths, so filePath must be absolute.
   *
   * Complexity: O(1) - server-side filtered query
   */
  private async findModuleNode(
    filePath: string
  ): Promise<BaseNodeRecord | null> {
    const filter: NodeFilter = { file: filePath, type: 'MODULE' };
    for await (const node of this.graph.queryNodes(filter)) {
      if (node.file === filePath && node.type === 'MODULE') {
        return node;
      }
    }
    return null;
  }

  /**
   * Get direct children of MODULE node that are "interesting" types.
   *
   * Walks MODULE -> CONTAINS -> children, filtering to OVERVIEW_NODE_TYPES.
   *
   * Complexity: O(C) where C = total CONTAINS edges from MODULE.
   * Typical file: 20-200 CONTAINS edges. We fetch them all in one call,
   * then filter client-side by type.
   */
  private async getTopLevelEntities(
    moduleId: string
  ): Promise<BaseNodeRecord[]> {
    const containsEdges = await this.graph.getOutgoingEdges(
      moduleId, ['CONTAINS']
    );

    const entities: BaseNodeRecord[] = [];
    for (const edge of containsEdges) {
      const child = await this.graph.getNode(edge.dst);
      if (child && OVERVIEW_NODE_TYPES.has(child.type)) {
        entities.push(child);
      }
    }
    return entities;
  }

  /**
   * Build ImportInfo from an IMPORT node.
   *
   * Import data is stored directly on the node record:
   * - node.source: string (module path)
   * - node.specifiers: ImportSpecifier[] (from ImportNodeRecord)
   *
   * No edge queries needed.
   * Complexity: O(1)
   */
  private buildImportInfo(node: BaseNodeRecord): ImportInfo {
    const source = (node.source as string) ?? (node.name || '');
    const rawSpecifiers = node.specifiers;
    let specifierNames: string[] = [];

    if (Array.isArray(rawSpecifiers)) {
      specifierNames = rawSpecifiers.map(
        (s: { local?: string; imported?: string; type?: string }) =>
          s.local || s.imported || 'unknown'
      );
    }

    return {
      id: node.id,
      source,
      specifiers: specifierNames,
    };
  }

  /**
   * Build ExportInfo from an EXPORT node.
   *
   * Export data is stored directly on the node record:
   * - node.exportedName: string
   * - node.isDefault: boolean
   *
   * No edge queries needed.
   * Complexity: O(1)
   */
  private buildExportInfo(node: BaseNodeRecord): ExportInfo {
    return {
      id: node.id,
      name: (node.exportedName as string) ?? node.name ?? '<anonymous>',
      isDefault: (node.isDefault as boolean) ?? false,
    };
  }

  /**
   * Build FunctionOverview from a FUNCTION node.
   *
   * When includeEdges=true, resolves calls via findCallsInFunction:
   *   FUNCTION -[HAS_SCOPE]-> SCOPE -[CONTAINS]-> CALL -[CALLS]-> target
   *
   * This reuses the exact same utility that handleGetFunctionDetails uses
   * (packages/core/src/queries/findCallsInFunction.ts).
   *
   * Complexity:
   *   Without edges: O(1)
   *   With edges: O(S + C) where S = scopes in function, C = calls
   *   Typical: 5-30 calls per function, ~50 DB ops
   */
  private async buildFunctionOverview(
    node: BaseNodeRecord,
    includeEdges: boolean
  ): Promise<FunctionOverview> {
    const overview: FunctionOverview = {
      id: node.id,
      name: node.name ?? '<anonymous>',
      line: node.line as number | undefined,
      async: (node.async as boolean) ?? false,
      params: node.params as string[] | undefined,
      calls: [],
      returnType: node.returnType as string | undefined,
      signature: node.signature as string | undefined,
    };

    if (includeEdges) {
      // Use findCallsInFunction for correct call resolution
      // (non-transitive, direct calls only)
      const callInfos = await findCallsInFunction(
        this.graph as any,  // GraphBackend satisfies the minimal interface
        node.id,
        { transitive: false }
      );

      // Extract unique target names
      const callNames = new Set<string>();
      for (const call of callInfos) {
        if (call.resolved && call.target) {
          callNames.add(call.target.name);
        } else {
          // Unresolved: use the call node's name directly
          callNames.add(call.name);
        }
      }
      overview.calls = Array.from(callNames);
    }

    return overview;
  }

  /**
   * Build ClassOverview from a CLASS node.
   *
   * 1. Fetch EXTENDS edge to get superclass name
   * 2. Fetch CONTAINS edges to find methods (FUNCTION nodes with isClassMethod)
   * 3. For each method, build FunctionOverview
   *
   * Complexity:
   *   Without edges: O(M) where M = methods in class (for CONTAINS traversal)
   *   With edges: O(M * (S_m + C_m)) where S_m/C_m = scopes/calls per method
   *   Typical class with 10 methods, 5 calls each: ~100-300 DB ops
   */
  private async buildClassOverview(
    node: BaseNodeRecord,
    includeEdges: boolean
  ): Promise<ClassOverview> {
    const overview: ClassOverview = {
      id: node.id,
      name: node.name ?? '<anonymous>',
      line: node.line as number | undefined,
      exported: (node.exported as boolean) ?? false,
      methods: [],
    };

    // Get superclass via EXTENDS edge
    if (includeEdges) {
      const extendsEdges = await this.graph.getOutgoingEdges(
        node.id, ['EXTENDS']
      );
      if (extendsEdges.length > 0) {
        const superNode = await this.graph.getNode(extendsEdges[0].dst);
        overview.extends = superNode?.name ?? (node.superClass as string);
      } else if (node.superClass) {
        // Fallback: stored on node directly (ClassNodeRecord.superClass)
        overview.extends = node.superClass as string;
      }
    } else if (node.superClass) {
      overview.extends = node.superClass as string;
    }

    // Get methods via CONTAINS edges
    const containsEdges = await this.graph.getOutgoingEdges(
      node.id, ['CONTAINS']
    );

    for (const edge of containsEdges) {
      const child = await this.graph.getNode(edge.dst);
      if (!child) continue;

      // Methods are stored as FUNCTION nodes (with isClassMethod flag)
      // or as METHOD nodes
      if (child.type === 'FUNCTION' || child.type === 'METHOD') {
        const methodOverview = await this.buildFunctionOverview(
          child, includeEdges
        );
        overview.methods.push(methodOverview);
      }
    }

    // Sort methods by line number
    overview.methods.sort(
      (a, b) => (a.line ?? 0) - (b.line ?? 0)
    );

    return overview;
  }

  /**
   * Build VariableOverview from a VARIABLE or CONSTANT node.
   *
   * When includeEdges=true, checks ASSIGNED_FROM edge to show value source.
   *
   * Complexity:
   *   Without edges: O(1)
   *   With edges: O(1) - single getOutgoingEdges + getNode
   */
  private async buildVariableOverview(
    node: BaseNodeRecord,
    includeEdges: boolean
  ): Promise<VariableOverview> {
    const overview: VariableOverview = {
      id: node.id,
      name: node.name ?? '<anonymous>',
      line: node.line as number | undefined,
      kind: (node.kind as string) ?? 'const',
    };

    if (includeEdges) {
      const assignedEdges = await this.graph.getOutgoingEdges(
        node.id, ['ASSIGNED_FROM']
      );
      if (assignedEdges.length > 0) {
        const sourceNode = await this.graph.getNode(
          assignedEdges[0].dst
        );
        if (sourceNode) {
          // Show the source name/type for quick understanding
          overview.assignedFrom = sourceNode.name ?? sourceNode.type;
        }
      }
    }

    return overview;
  }
}
```

### 1.5 Complexity Analysis Summary

| Operation | Complexity | Typical Count |
|---|---|---|
| Find MODULE node | O(1) server query | 1 query |
| Get CONTAINS from MODULE | O(1) edge query | 1 query, ~50-200 edges |
| Resolve each child node | O(C) where C = children | ~50-200 getNode calls |
| Filter to interesting types | O(C) | ~10-50 interesting entities |
| Per FUNCTION: findCallsInFunction | O(S + K) scopes + calls | ~5-30 calls, ~20-60 DB ops |
| Per CLASS: EXTENDS + CONTAINS + methods | O(M * (S + K)) | ~100-300 DB ops |
| Per VARIABLE: ASSIGNED_FROM | O(1) | 1-2 DB ops |
| **Total per file** | **O(N * (S + K))** | **~200-500 DB ops** |

Where N = top-level entities, S = scopes per function, K = calls per function.

At <1ms per RFDB round-trip: **total <500ms per file**.

With `includeEdges=false`: O(C) for just listing entities, ~50-200 ops, **<100ms**.

---

## Step 2: Export from Core Package

**File:** `packages/core/src/index.ts`

Add after the `FileExplainer` export block (line 110-111):

```typescript
export { FileOverview } from './core/FileOverview.js';
export type {
  FileOverviewResult,
  ImportInfo,
  ExportInfo,
  FunctionOverview,
  ClassOverview,
  VariableOverview,
} from './core/FileOverview.js';
```

**Pattern match:** This follows the exact pattern used for `FileExplainer` on lines 110-111:
```typescript
export { FileExplainer } from './core/FileExplainer.js';
export type { FileExplainResult, EnhancedNode } from './core/FileExplainer.js';
```

---

## Step 3: CLI Command — `grafema file <path>`

**File:** `packages/cli/src/commands/file.ts`

### 3.1 Command Structure

Following the exact pattern from `packages/cli/src/commands/explain.ts` (lines 26-137):

```typescript
/**
 * File command - Show structured overview of a file's entities and relationships
 *
 * Purpose: Give a file-level summary with imports, exports, classes, functions,
 * and their key relationships (calls, extends, assigned-from).
 *
 * This fills the gap between:
 * - explain (lists ALL nodes flat, no relationships)
 * - context (shows ONE node's full neighborhood)
 *
 * The file command shows ALL meaningful entities at file level with curated edges.
 */

import { Command } from 'commander';
import { resolve, join, relative, normalize } from 'path';
import { existsSync, realpathSync } from 'fs';
import { RFDBServerBackend, FileOverview } from '@grafema/core';
import type { FileOverviewResult, FunctionOverview } from '@grafema/core';
import { exitWithError } from '../utils/errorFormatter.js';
import { Spinner } from '../utils/spinner.js';

interface FileOptions {
  project: string;
  json?: boolean;
  noEdges?: boolean;
}

export const fileCommand = new Command('file')
  .description(
    'Show structured overview of a file: imports, exports, classes, functions with relationships'
  )
  .argument('<path>', 'File path to analyze')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('--no-edges', 'Skip edge resolution (faster, just list entities)')
  .addHelpText('after', `
Examples:
  grafema file src/app.ts              Show file overview with relationships
  grafema file src/app.ts --json       Output as JSON for scripting
  grafema file src/app.ts --no-edges   Fast mode: just list entities
  grafema file ./src/utils.js          Works with relative paths

Output shows:
  - Imports (module sources and specifiers)
  - Exports (named and default)
  - Classes with methods and their calls
  - Functions with their calls
  - Variables with assignment sources

Use 'grafema context <id>' to dive deeper into any specific entity.
`)
  .action(async (file: string, options: FileOptions) => {
    const projectPath = resolve(options.project);
    const grafemaDir = join(projectPath, '.grafema');
    const dbPath = join(grafemaDir, 'graph.rfdb');

    // Check database exists
    if (!existsSync(dbPath)) {
      exitWithError('No graph database found', [
        'Run: grafema init && grafema analyze',
      ]);
    }

    // === Path resolution (same as explain command) ===
    let filePath = file;

    if (file.startsWith('./') || file.startsWith('../')) {
      filePath = normalize(file).replace(/^\.\//, '');
    } else if (resolve(file) === file) {
      filePath = relative(projectPath, file);
    }

    const resolvedPath = resolve(projectPath, filePath);
    if (!existsSync(resolvedPath)) {
      exitWithError(`File not found: ${file}`, [
        'Check the file path and try again',
      ]);
    }

    // realpath for symlink resolution (macOS: /tmp -> /private/tmp)
    const absoluteFilePath = realpathSync(resolvedPath);
    const relativeFilePath = relative(projectPath, absoluteFilePath);

    // === Query graph ===
    const backend = new RFDBServerBackend({ dbPath });
    await backend.connect();

    const spinner = new Spinner('Loading file overview...');
    spinner.start();

    try {
      const overview = new FileOverview(backend);
      const result = await overview.getOverview(absoluteFilePath, {
        includeEdges: options.noEdges !== true,
      });

      // Use relative path for display
      result.file = relativeFilePath;

      spinner.stop();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // Human-readable output
      printFileOverview(result);
    } finally {
      spinner.stop();
      await backend.close();
    }
  });
```

### 3.2 Text Output Formatter

```typescript
/**
 * Print file overview in compact, human-readable format.
 *
 * Design goals:
 * - Fit on one screen for typical files
 * - Line numbers for navigation
 * - Calls inline after each function/method
 * - Sorted by source order (line number)
 */
function printFileOverview(result: FileOverviewResult): void {
  // Header
  console.log(`Module: ${result.file}`);

  if (result.status === 'NOT_ANALYZED') {
    console.log('Status: NOT_ANALYZED');
    console.log('');
    console.log('This file has not been analyzed yet.');
    console.log('Run: grafema analyze');
    return;
  }

  // Imports line (compact)
  if (result.imports.length > 0) {
    const importSources = result.imports.map(i => i.source);
    console.log(`Imports: ${importSources.join(', ')}`);
  }

  // Exports line (compact)
  if (result.exports.length > 0) {
    const exportNames = result.exports.map(e =>
      e.isDefault ? `${e.name} (default)` : e.name
    );
    console.log(`Exports: ${exportNames.join(', ')}`);
  }

  // Classes
  if (result.classes.length > 0) {
    console.log('');
    console.log('Classes:');
    for (const cls of result.classes) {
      const extendsStr = cls.extends ? ` extends ${cls.extends}` : '';
      const lineStr = cls.line ? ` (line ${cls.line})` : '';
      console.log(`  ${cls.name}${extendsStr}${lineStr}`);

      for (const method of cls.methods) {
        printFunctionLine(method, '    ');
      }
    }
  }

  // Top-level functions
  if (result.functions.length > 0) {
    console.log('');
    console.log('Functions:');
    for (const fn of result.functions) {
      printFunctionLine(fn, '  ');
    }
  }

  // Variables
  if (result.variables.length > 0) {
    console.log('');
    console.log('Variables:');
    for (const v of result.variables) {
      const lineStr = v.line ? `(line ${v.line})` : '';
      const assignStr = v.assignedFrom ? ` = ${v.assignedFrom}` : '';
      console.log(`  ${v.kind} ${v.name}${assignStr}  ${lineStr}`);
    }
  }
}

/**
 * Print a single function/method line with calls.
 *
 * Format:
 *   functionName(params)   -> calledFn1, calledFn2   (line 42)
 *
 * The arrow notation makes it scannable — you can immediately see
 * what each function calls without reading the body.
 */
function printFunctionLine(fn: FunctionOverview, indent: string): void {
  const asyncStr = fn.async ? 'async ' : '';
  const paramsStr = fn.params ? `(${fn.params.join(', ')})` : '()';
  const lineStr = fn.line ? `(line ${fn.line})` : '';

  let callsStr = '';
  if (fn.calls.length > 0) {
    callsStr = `  -> ${fn.calls.join(', ')}`;
  }

  console.log(
    `${indent}${asyncStr}${fn.name}${paramsStr}${callsStr}  ${lineStr}`
  );
}
```

### 3.3 Wire Up to CLI

**File:** `packages/cli/src/cli.ts`

Add import (after line 27, the `explainCommand` import):
```typescript
import { fileCommand } from './commands/file.js';
```

Add command registration (after line 58, `program.addCommand(explainCommand)`):
```typescript
program.addCommand(fileCommand);
```

This follows the exact pattern of every other command in this file.

---

## Step 4: MCP Tool — `get_file_overview`

### 4.1 Tool Definition

**File:** `packages/mcp/src/definitions.ts`

Add to the `TOOLS` array (after the `get_context` tool definition, around line 546):

```typescript
{
  name: 'get_file_overview',
  description: `Get a structured overview of all entities in a file with their relationships.

Shows imports, exports, classes, functions, and variables with key edges
(CALLS, EXTENDS, ASSIGNED_FROM). Use this for file-level understanding
before diving into specific nodes with get_context.

Output includes:
- Imports: module sources and imported names
- Exports: named and default exports
- Classes: with methods and their call targets
- Functions: with call targets
- Variables: with assignment sources

This is the recommended first step when exploring a file.
After using this, use get_context with specific node IDs for details.`,
  inputSchema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'File path (relative to project root or absolute)',
      },
      include_edges: {
        type: 'boolean',
        description:
          'Include relationship edges like CALLS, EXTENDS (default: true). Set false for faster results.',
      },
    },
    required: ['file'],
  },
},
```

### 4.2 Argument Type

**File:** `packages/mcp/src/types.ts`

Add after the `GetContextArgs` interface (around line 309):

```typescript
// === FILE OVERVIEW (REG-412) ===

export interface GetFileOverviewArgs {
  /** File path (relative to project root or absolute) */
  file: string;
  /** Include relationship edges (default: true) */
  include_edges?: boolean;
}
```

### 4.3 Handler Function

**File:** `packages/mcp/src/handlers.ts`

Add new import at the top (alongside existing `FileExplainer` would be, but since `FileOverview` is new):

In the import from `@grafema/core` (line 7), add `FileOverview`:
```typescript
import { CoverageAnalyzer, findCallsInFunction, findContainingFunction, ..., FileOverview } from '@grafema/core';
```

Add the `GetFileOverviewArgs` to the type imports (around line 47):
```typescript
import type {
  ...existing types...,
  GetFileOverviewArgs,
} from './types.js';
```

Add handler function (after `handleGetContext`, around line 1309):

```typescript
// === FILE OVERVIEW (REG-412) ===

/**
 * Get structured file overview with entities and relationships.
 *
 * Path resolution: same logic as the explain command.
 * Converts relative paths to absolute using project root,
 * then uses realpathSync to handle symlinks.
 */
export async function handleGetFileOverview(
  args: GetFileOverviewArgs
): Promise<ToolResult> {
  const db = await ensureAnalyzed();
  const projectPath = getProjectPath();
  const { file, include_edges: includeEdges = true } = args;

  // Resolve file path (same pattern as explain command and context handler)
  let filePath = file;

  // Handle relative paths
  if (!filePath.startsWith('/')) {
    filePath = join(projectPath, filePath);
  }

  // Verify file exists
  if (!existsSync(filePath)) {
    return errorResult(
      `File not found: ${file}\n` +
      `Resolved to: ${filePath}\n` +
      `Project root: ${projectPath}`
    );
  }

  // Use realpath for symlink resolution
  const { realpathSync } = await import('fs');
  const absolutePath = realpathSync(filePath);
  const relativePath = relative(projectPath, absolutePath);

  try {
    const overview = new FileOverview(db);
    const result = await overview.getOverview(absolutePath, {
      includeEdges,
    });

    // Use relative path for display
    result.file = relativePath;

    if (result.status === 'NOT_ANALYZED') {
      return textResult(
        `File not analyzed: ${relativePath}\n` +
        `Run analyze_project to build the graph.`
      );
    }

    // Format text summary
    const lines: string[] = [];

    lines.push(`Module: ${result.file}`);

    if (result.imports.length > 0) {
      const sources = result.imports.map(i => i.source);
      lines.push(`Imports: ${sources.join(', ')}`);
    }

    if (result.exports.length > 0) {
      const names = result.exports.map(e =>
        e.isDefault ? `${e.name} (default)` : e.name
      );
      lines.push(`Exports: ${names.join(', ')}`);
    }

    if (result.classes.length > 0) {
      lines.push('');
      lines.push('Classes:');
      for (const cls of result.classes) {
        const ext = cls.extends ? ` extends ${cls.extends}` : '';
        lines.push(`  ${cls.name}${ext} (line ${cls.line ?? '?'})`);
        for (const m of cls.methods) {
          const calls = m.calls.length > 0
            ? `  -> ${m.calls.join(', ')}`
            : '';
          const params = m.params
            ? `(${m.params.join(', ')})`
            : '()';
          lines.push(`    ${m.name}${params}${calls}`);
        }
      }
    }

    if (result.functions.length > 0) {
      lines.push('');
      lines.push('Functions:');
      for (const fn of result.functions) {
        const calls = fn.calls.length > 0
          ? `  -> ${fn.calls.join(', ')}`
          : '';
        const params = fn.params
          ? `(${fn.params.join(', ')})`
          : '()';
        const asyncStr = fn.async ? 'async ' : '';
        lines.push(
          `  ${asyncStr}${fn.name}${params}${calls}  (line ${fn.line ?? '?'})`
        );
      }
    }

    if (result.variables.length > 0) {
      lines.push('');
      lines.push('Variables:');
      for (const v of result.variables) {
        const assign = v.assignedFrom ? ` = ${v.assignedFrom}` : '';
        lines.push(
          `  ${v.kind} ${v.name}${assign}  (line ${v.line ?? '?'})`
        );
      }
    }

    return textResult(
      lines.join('\n') + '\n\n' +
      JSON.stringify(serializeBigInt(result), null, 2)
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Failed to get file overview: ${message}`);
  }
}
```

Note: The `realpathSync` import uses dynamic import in the handler, but since `existsSync` is already imported at the top of handlers.ts (line 9: `import { existsSync, readFileSync, ... } from 'fs'`), we should just add `realpathSync` to that existing import.

### 4.4 Server Routing

**File:** `packages/mcp/src/server.ts`

Add import of handler (alongside other handler imports, line 43):
```typescript
import {
  ...existing handlers...,
  handleGetFileOverview,
} from './handlers.js';
```

Add type import (line 66):
```typescript
import type {
  ...existing types...,
  GetFileOverviewArgs,
} from './types.js';
```

Add case in switch statement (after `case 'get_context':`, around line 210):
```typescript
case 'get_file_overview':
  result = await handleGetFileOverview(asArgs<GetFileOverviewArgs>(args));
  break;
```

---

## Step 5: Unit Tests

**File:** `test/unit/FileOverview.test.js`

### 5.1 Test Strategy

We test the `FileOverview` core class with a mock graph backend. This follows the same approach the codebase uses for query utilities — the `findCallsInFunction` tests are inline/integration, but for FileOverview we can create a focused unit test with a fake backend.

Tests run against `dist/`, so `pnpm build` is required before running them.

### 5.2 Test Plan

```javascript
/**
 * Tests for FileOverview core class - REG-412
 *
 * Tests the structured file overview logic: categorization, edge resolution,
 * and result building.
 */

import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { FileOverview } from '../../packages/core/dist/core/FileOverview.js';

// === Mock Graph Backend ===

/**
 * Creates a mock graph backend with pre-loaded nodes and edges.
 * Follows the minimal interface used by FileOverview:
 * - queryNodes(filter) -> AsyncGenerator
 * - getNode(id) -> node | null
 * - getOutgoingEdges(id, types) -> edges[]
 */
function createMockBackend(nodes, edges) {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));

  return {
    async *queryNodes(filter) {
      for (const node of nodes) {
        let match = true;
        if (filter.file && node.file !== filter.file) match = false;
        if (filter.type && node.type !== filter.type) match = false;
        if (filter.name && node.name !== filter.name) match = false;
        if (match) yield node;
      }
    },

    async getNode(id) {
      return nodeMap.get(id) ?? null;
    },

    async getOutgoingEdges(nodeId, edgeTypes) {
      return edges.filter(e => {
        if (e.src !== nodeId) return false;
        if (edgeTypes && !edgeTypes.includes(e.type)) return false;
        return true;
      });
    },

    async getIncomingEdges(nodeId, edgeTypes) {
      return edges.filter(e => {
        if (e.dst !== nodeId) return false;
        if (edgeTypes && !edgeTypes.includes(e.type)) return false;
        return true;
      });
    },
  };
}

// === Test Fixtures ===

const TEST_FILE = '/project/src/app.js';

/**
 * Minimal graph: MODULE with one function that calls another
 */
function simpleGraph() {
  const nodes = [
    // MODULE
    { id: 'src/app.js', type: 'MODULE', name: 'app.js', file: TEST_FILE, line: 1 },
    // Import
    { id: 'src/app.js->IMPORT->express', type: 'IMPORT', name: 'express',
      file: TEST_FILE, line: 1, source: 'express',
      specifiers: [{ local: 'express', type: 'default' }] },
    // Export
    { id: 'src/app.js->EXPORT->app', type: 'EXPORT', name: 'app',
      file: TEST_FILE, line: 20, exportedName: 'app', isDefault: true },
    // Function
    { id: 'src/app.js->FUNCTION->main', type: 'FUNCTION', name: 'main',
      file: TEST_FILE, line: 5, async: true, params: ['config'] },
    // Function's scope
    { id: 'src/app.js->FUNCTION->main->SCOPE', type: 'SCOPE',
      file: TEST_FILE, line: 5 },
    // Call inside function
    { id: 'src/app.js->FUNCTION->main->SCOPE->CALL->express', type: 'CALL',
      name: 'express', file: TEST_FILE, line: 6 },
    // Target of call
    { id: 'express->FUNCTION->default', type: 'FUNCTION', name: 'express',
      file: '/node_modules/express/index.js', line: 1 },
    // Variable
    { id: 'src/app.js->VARIABLE->port', type: 'VARIABLE', name: 'port',
      file: TEST_FILE, line: 3, kind: 'const' },
    // Literal (assigned to port)
    { id: 'src/app.js->LITERAL->3000', type: 'LITERAL', name: '3000',
      file: TEST_FILE, line: 3 },
    // Class
    { id: 'src/app.js->CLASS->Server', type: 'CLASS', name: 'Server',
      file: TEST_FILE, line: 10, exported: true },
    // Class method
    { id: 'src/app.js->CLASS->Server->FUNCTION->start', type: 'FUNCTION',
      name: 'start', file: TEST_FILE, line: 12, async: true,
      isClassMethod: true, params: [] },
    // Method scope
    { id: 'src/app.js->CLASS->Server->FUNCTION->start->SCOPE', type: 'SCOPE',
      file: TEST_FILE, line: 12 },
    // Superclass
    { id: 'events->CLASS->EventEmitter', type: 'CLASS', name: 'EventEmitter',
      file: '/node_modules/events/index.js', line: 1 },
  ];

  const edges = [
    // MODULE -> CONTAINS -> children
    { src: 'src/app.js', dst: 'src/app.js->IMPORT->express', type: 'CONTAINS' },
    { src: 'src/app.js', dst: 'src/app.js->EXPORT->app', type: 'CONTAINS' },
    { src: 'src/app.js', dst: 'src/app.js->FUNCTION->main', type: 'CONTAINS' },
    { src: 'src/app.js', dst: 'src/app.js->VARIABLE->port', type: 'CONTAINS' },
    { src: 'src/app.js', dst: 'src/app.js->CLASS->Server', type: 'CONTAINS' },
    // Function -> HAS_SCOPE -> SCOPE
    { src: 'src/app.js->FUNCTION->main', dst: 'src/app.js->FUNCTION->main->SCOPE', type: 'HAS_SCOPE' },
    // SCOPE -> CONTAINS -> CALL
    { src: 'src/app.js->FUNCTION->main->SCOPE', dst: 'src/app.js->FUNCTION->main->SCOPE->CALL->express', type: 'CONTAINS' },
    // CALL -> CALLS -> target
    { src: 'src/app.js->FUNCTION->main->SCOPE->CALL->express', dst: 'express->FUNCTION->default', type: 'CALLS' },
    // Variable -> ASSIGNED_FROM -> literal
    { src: 'src/app.js->VARIABLE->port', dst: 'src/app.js->LITERAL->3000', type: 'ASSIGNED_FROM' },
    // Class -> EXTENDS -> EventEmitter
    { src: 'src/app.js->CLASS->Server', dst: 'events->CLASS->EventEmitter', type: 'EXTENDS' },
    // Class -> CONTAINS -> method
    { src: 'src/app.js->CLASS->Server', dst: 'src/app.js->CLASS->Server->FUNCTION->start', type: 'CONTAINS' },
    // Method -> HAS_SCOPE -> SCOPE
    { src: 'src/app.js->CLASS->Server->FUNCTION->start', dst: 'src/app.js->CLASS->Server->FUNCTION->start->SCOPE', type: 'HAS_SCOPE' },
  ];

  return { nodes, edges };
}

// === Tests ===

describe('FileOverview', () => {
  describe('getOverview - analyzed file', () => {
    it('should return ANALYZED status for a file with MODULE node', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      assert.equal(result.status, 'ANALYZED');
      assert.equal(result.file, TEST_FILE);
    });

    it('should extract imports with source and specifiers', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      assert.equal(result.imports.length, 1);
      assert.equal(result.imports[0].source, 'express');
      assert.deepEqual(result.imports[0].specifiers, ['express']);
    });

    it('should extract exports with default flag', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      assert.equal(result.exports.length, 1);
      assert.equal(result.exports[0].name, 'app');
      assert.equal(result.exports[0].isDefault, true);
    });

    it('should extract functions with resolved calls', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      assert.equal(result.functions.length, 1);
      assert.equal(result.functions[0].name, 'main');
      assert.equal(result.functions[0].async, true);
      assert.deepEqual(result.functions[0].params, ['config']);
      assert.ok(result.functions[0].calls.includes('express'),
        'Should include resolved call target name');
    });

    it('should extract classes with extends and methods', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      assert.equal(result.classes.length, 1);
      assert.equal(result.classes[0].name, 'Server');
      assert.equal(result.classes[0].extends, 'EventEmitter');
      assert.equal(result.classes[0].exported, true);
      assert.equal(result.classes[0].methods.length, 1);
      assert.equal(result.classes[0].methods[0].name, 'start');
    });

    it('should extract variables with assigned-from source', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      assert.equal(result.variables.length, 1);
      assert.equal(result.variables[0].name, 'port');
      assert.equal(result.variables[0].kind, 'const');
      assert.equal(result.variables[0].assignedFrom, '3000');
    });

    it('should sort all groups by line number', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      // Classes methods should be sorted by line
      if (result.classes.length > 0 && result.classes[0].methods.length > 1) {
        for (let i = 1; i < result.classes[0].methods.length; i++) {
          assert.ok(
            (result.classes[0].methods[i].line ?? 0) >=
            (result.classes[0].methods[i - 1].line ?? 0),
            'Methods should be sorted by line'
          );
        }
      }
    });
  });

  describe('getOverview - not analyzed file', () => {
    it('should return NOT_ANALYZED for a file with no MODULE node', async () => {
      const backend = createMockBackend([], []);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview('/nonexistent/file.js');

      assert.equal(result.status, 'NOT_ANALYZED');
      assert.equal(result.imports.length, 0);
      assert.equal(result.exports.length, 0);
      assert.equal(result.classes.length, 0);
      assert.equal(result.functions.length, 0);
      assert.equal(result.variables.length, 0);
    });
  });

  describe('getOverview - includeEdges=false', () => {
    it('should skip call resolution when edges disabled', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE, {
        includeEdges: false,
      });

      assert.equal(result.status, 'ANALYZED');
      assert.equal(result.functions.length, 1);
      // With edges disabled, calls array should be empty
      assert.deepEqual(result.functions[0].calls, []);
    });

    it('should still extract class names without EXTENDS resolution', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE, {
        includeEdges: false,
      });

      assert.equal(result.classes.length, 1);
      assert.equal(result.classes[0].name, 'Server');
      // Without edges, methods should still be listed (via CONTAINS)
      // but their calls should be empty
      assert.equal(result.classes[0].methods.length, 1);
      assert.deepEqual(result.classes[0].methods[0].calls, []);
    });
  });

  describe('getOverview - filters out structural nodes', () => {
    it('should not include SCOPE, CALL, EXPRESSION nodes in results', async () => {
      const { nodes, edges } = simpleGraph();
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview(TEST_FILE);

      // None of the result arrays should contain SCOPE, CALL, etc.
      const allIds = [
        ...result.imports.map(i => i.id),
        ...result.exports.map(e => e.id),
        ...result.classes.map(c => c.id),
        ...result.functions.map(f => f.id),
        ...result.variables.map(v => v.id),
      ];

      for (const id of allIds) {
        const node = nodes.find(n => n.id === id);
        assert.ok(node, `Node ${id} should exist`);
        assert.ok(
          !['SCOPE', 'CALL', 'EXPRESSION', 'LITERAL', 'PARAMETER'].includes(node.type),
          `Should not include ${node.type} node in overview`
        );
      }
    });
  });

  describe('getOverview - edge cases', () => {
    it('should handle function with no calls', async () => {
      const nodes = [
        { id: 'mod', type: 'MODULE', name: 'file.js', file: '/test.js', line: 1 },
        { id: 'fn', type: 'FUNCTION', name: 'empty', file: '/test.js', line: 2 },
        { id: 'fn-scope', type: 'SCOPE', file: '/test.js', line: 2 },
      ];
      const edges = [
        { src: 'mod', dst: 'fn', type: 'CONTAINS' },
        { src: 'fn', dst: 'fn-scope', type: 'HAS_SCOPE' },
      ];
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview('/test.js');

      assert.equal(result.functions.length, 1);
      assert.deepEqual(result.functions[0].calls, []);
    });

    it('should handle class with no methods', async () => {
      const nodes = [
        { id: 'mod', type: 'MODULE', name: 'file.js', file: '/test.js', line: 1 },
        { id: 'cls', type: 'CLASS', name: 'Empty', file: '/test.js', line: 2, exported: false },
      ];
      const edges = [
        { src: 'mod', dst: 'cls', type: 'CONTAINS' },
      ];
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview('/test.js');

      assert.equal(result.classes.length, 1);
      assert.equal(result.classes[0].name, 'Empty');
      assert.deepEqual(result.classes[0].methods, []);
    });

    it('should handle anonymous function', async () => {
      const nodes = [
        { id: 'mod', type: 'MODULE', name: 'file.js', file: '/test.js', line: 1 },
        { id: 'fn', type: 'FUNCTION', file: '/test.js', line: 2, async: false },
        { id: 'fn-scope', type: 'SCOPE', file: '/test.js', line: 2 },
      ];
      const edges = [
        { src: 'mod', dst: 'fn', type: 'CONTAINS' },
        { src: 'fn', dst: 'fn-scope', type: 'HAS_SCOPE' },
      ];
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview('/test.js');

      assert.equal(result.functions.length, 1);
      assert.equal(result.functions[0].name, '<anonymous>');
    });

    it('should handle import with no specifiers', async () => {
      const nodes = [
        { id: 'mod', type: 'MODULE', name: 'file.js', file: '/test.js', line: 1 },
        { id: 'imp', type: 'IMPORT', name: './styles.css',
          file: '/test.js', line: 1, source: './styles.css' },
      ];
      const edges = [
        { src: 'mod', dst: 'imp', type: 'CONTAINS' },
      ];
      const backend = createMockBackend(nodes, edges);
      const overview = new FileOverview(backend);

      const result = await overview.getOverview('/test.js');

      assert.equal(result.imports.length, 1);
      assert.equal(result.imports[0].source, './styles.css');
      assert.deepEqual(result.imports[0].specifiers, []);
    });
  });
});
```

### 5.3 Test Execution

```bash
pnpm build
node --test test/unit/FileOverview.test.js
```

Expected: ~12 tests, all passing. Max execution time: <5 seconds (pure mock, no I/O).

---

## Step 6: Implementation Order and Commits

### Commit 1: Core class + tests
- Create `packages/core/src/core/FileOverview.ts`
- Add exports to `packages/core/src/index.ts`
- Create `test/unit/FileOverview.test.js`
- `pnpm build && node --test test/unit/FileOverview.test.js`

### Commit 2: CLI command
- Create `packages/cli/src/commands/file.ts`
- Add import + `program.addCommand(fileCommand)` to `packages/cli/src/cli.ts`
- `pnpm build` (verify compiles)
- Manual test: `node packages/cli/dist/cli.js file <some-analyzed-file>`

### Commit 3: MCP tool
- Add tool definition to `packages/mcp/src/definitions.ts`
- Add `GetFileOverviewArgs` to `packages/mcp/src/types.ts`
- Add `handleGetFileOverview` to `packages/mcp/src/handlers.ts`
- Add case to switch in `packages/mcp/src/server.ts`
- `pnpm build`
- Manual test via MCP client

### Commit 4: Integration test (optional)
- Test with a real analyzed project
- Verify MCP tool returns expected structure

Each commit is atomic and working. Tests pass after each commit.

---

## Edge Cases and Error Handling

| Scenario | Handling |
|---|---|
| File not found on disk | `exitWithError` (CLI) / `errorResult` (MCP) with path info |
| File not in graph (not analyzed) | Return `NOT_ANALYZED` status, empty arrays |
| Symlinks (macOS /tmp) | `realpathSync()` before querying graph |
| Relative path | Normalize relative to project root (same as `explain` command) |
| Absolute path | Use directly, relativize for display |
| Node with no name | Display as `<anonymous>` |
| CLASS with superClass only on node, no EXTENDS edge | Fall back to `node.superClass` field |
| Import with no specifiers array | Return empty specifiers array |
| Function with no HAS_SCOPE edge | `findCallsInFunction` handles this gracefully (returns []) |
| Very large file (thousands of nodes) | O(N) where N = entities. Even 1000 entities = ~5000 DB ops = <5s. Acceptable. |
| Graph backend not connected | Throws at `backend.connect()` — caught by CLI try/finally |

---

## Appendix: File-by-File Diff Summary

```
NEW packages/core/src/core/FileOverview.ts
  - FileOverview class
  - 7 type exports
  - ~250 lines

MOD packages/core/src/index.ts
  + 2 lines (export class + types)

NEW packages/cli/src/commands/file.ts
  - fileCommand
  - printFileOverview()
  - printFunctionLine()
  - ~150 lines

MOD packages/cli/src/cli.ts
  + 2 lines (import + addCommand)

MOD packages/mcp/src/definitions.ts
  + 1 tool definition (~25 lines)

MOD packages/mcp/src/types.ts
  + GetFileOverviewArgs interface (~5 lines)

MOD packages/mcp/src/handlers.ts
  + handleGetFileOverview function (~80 lines)
  + import additions (~3 lines)

MOD packages/mcp/src/server.ts
  + 3 lines (import + case)

NEW test/unit/FileOverview.test.js
  - 12 test cases
  - Mock backend helper
  - ~300 lines
```

**Total new code: ~810 lines** (including tests).
**Total modified lines in existing files: ~36 lines.**

No architectural changes. No new dependencies. All existing patterns followed exactly.

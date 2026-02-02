# Joel Spolsky's Detailed Technical Plan for REG-177

Based on analysis of:
1. Don's high-level plan (002-don-plan.md)
2. Existing CLI command patterns (doctor.ts, query.ts, coverage.ts)
3. JSASTAnalyzer structure and what it extracts
4. CoverageAnalyzer pattern for file-level analysis
5. GraphBuilder and node type structures

## Technical Plan: `grafema explain <file>` Command

---

## 1. Architecture Overview

The `explain` command will follow the **doctor command pattern** with a subdirectory for organization:

```
packages/cli/src/commands/
  explain.ts          # Main command file
  explain/
    output.ts         # Terminal output formatting
    types.ts          # TypeScript interfaces
```

```
packages/core/src/core/
  FileExplainer.ts    # Core analyzer class (exports from index.ts)
```

---

## 2. File Specifications

### 2.1. `packages/core/src/core/FileExplainer.ts`

**Purpose**: Re-parse file, walk AST to collect "expected" elements, query graph for existing nodes, compute difference.

```typescript
/**
 * FileExplainer - Explains what was/wasn't extracted from a file
 *
 * When to use:
 *   - Debugging missing nodes in the graph
 *   - Understanding why a variable/function isn't in the graph
 *   - Verifying analysis coverage for a specific file
 *
 * How it works:
 *   1. Re-parses the file with Babel to get full AST
 *   2. Walks AST to collect "expected" declarations
 *   3. Queries graph for nodes with matching file
 *   4. Computes difference (expected vs actual)
 *   5. Provides reasons for missing nodes based on known limitations
 */

import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import type { GraphBackend, BaseNodeRecord } from '@grafema/types';

export interface ExpectedElement {
  type: 'FUNCTION' | 'CLASS' | 'VARIABLE' | 'CONSTANT' | 'METHOD';
  name: string;
  line: number;
  column: number;
  context?: string;  // e.g., "inside try block", "inside callback"
}

export interface FileExplainResult {
  file: string;
  status: 'ANALYZED' | 'NOT_ANALYZED' | 'PARTIAL' | 'NOT_FOUND' | 'PARSE_ERROR';

  // From graph
  createdNodes: {
    count: number;
    byType: Record<string, BaseNodeRecord[]>;
  };

  // From AST comparison
  expectedElements: ExpectedElement[];
  missingElements: ExpectedElement[];

  // Known limitations that apply
  knownLimitations: KnownLimitation[];

  // Parse error if any
  parseError?: string;
}

export interface KnownLimitation {
  id: string;           // 'try-catch-variables', 'dynamic-imports', etc.
  description: string;  // Human-readable explanation
  affectedCount: number;
  relatedIssue?: string; // REG-XXX if exists
}

export class FileExplainer {
  constructor(
    private graph: GraphBackend,
    private projectPath: string
  ) {}

  async explain(filePath: string): Promise<FileExplainResult>;

  // Private methods
  private parseFile(filePath: string): t.File | null;
  private collectExpectedElements(ast: t.File): ExpectedElement[];
  private async getNodesForFile(filePath: string): Promise<BaseNodeRecord[]>;
  private findMissingElements(expected: ExpectedElement[], actual: BaseNodeRecord[]): ExpectedElement[];
  private detectLimitations(missing: ExpectedElement[]): KnownLimitation[];
}
```

**Implementation Details**:

1. **Parsing**: Use same Babel config as JSASTAnalyzer:
   ```typescript
   parse(code, {
     sourceType: 'module',
     plugins: ['jsx', 'typescript']
   });
   ```

2. **Expected Elements Collection** (initial scope):
   - `FunctionDeclaration` - top-level and nested
   - `VariableDeclaration` with `const`/`let`/`var`
   - `ClassDeclaration`
   - `ClassMethod` (instance methods)

   **NOT collected initially** (too noisy):
   - Expression-level identifiers
   - Callback function parameters
   - Destructuring patterns

3. **Context Detection** (for explanations):
   Track parent node stack during traversal to detect:
   - Inside `TryStatement` block
   - Inside arrow function callback
   - Inside class constructor
   - Dynamic computed property

4. **Known Limitations Registry** (hardcoded initially):
   ```typescript
   const KNOWN_LIMITATIONS: Record<string, KnownLimitation> = {
     'try-catch-variables': {
       id: 'try-catch-variables',
       description: 'Variables declared inside try/catch blocks are not extracted',
       affectedCount: 0,  // Computed at runtime
       relatedIssue: 'REG-XXX'  // Create issue for this
     },
     'dynamic-imports': {
       id: 'dynamic-imports',
       description: 'Dynamic import() expressions are tracked but not resolved',
       affectedCount: 0
     },
     'computed-properties': {
       id: 'computed-properties',
       description: 'Computed property names (obj[expr]) are not resolved',
       affectedCount: 0
     }
   };
   ```

---

### 2.2. `packages/cli/src/commands/explain.ts`

**Purpose**: CLI command handler.

```typescript
/**
 * Explain command - Show what was/wasn't extracted from a file
 *
 * Usage:
 *   grafema explain <file>
 *   grafema explain src/utils/auth.ts
 *   grafema explain --json src/utils/auth.ts
 */

import { Command } from 'commander';
import { resolve, join, relative } from 'path';
import { existsSync } from 'fs';
import { RFDBServerBackend, FileExplainer } from '@grafema/core';
import { formatExplainReport, buildExplainJsonReport } from './explain/output.js';
import { exitWithError } from '../utils/errorFormatter.js';

interface ExplainOptions {
  project: string;
  json?: boolean;
  verbose?: boolean;
}

export const explainCommand = new Command('explain')
  .description('Explain what was extracted from a file and why')
  .argument('<file>', 'File to explain')
  .option('-p, --project <path>', 'Project path', '.')
  .option('-j, --json', 'Output as JSON')
  .option('-v, --verbose', 'Show all nodes, not just summary')
  .addHelpText('after', `
Examples:
  grafema explain src/auth.ts              Show analysis status
  grafema explain src/auth.ts --verbose    Show all created nodes
  grafema explain src/auth.ts --json       Output as JSON
  grafema explain ./utils/helpers.js       Explain specific file
`)
  .action(async (file: string, options: ExplainOptions) => {
    // Implementation
  });
```

---

### 2.3. `packages/cli/src/commands/explain/types.ts`

```typescript
/**
 * Type definitions for `grafema explain` command
 */

export interface ExplainOptions {
  project: string;
  json?: boolean;
  verbose?: boolean;
}

export interface ExplainJsonReport {
  file: string;
  relativePath: string;
  status: string;
  createdNodes: {
    total: number;
    byType: Record<string, number>;
  };
  missingElements: Array<{
    type: string;
    name: string;
    line: number;
    context?: string;
    reason?: string;
  }>;
  knownLimitations: Array<{
    id: string;
    description: string;
    affectedCount: number;
    relatedIssue?: string;
  }>;
  timestamp: string;
}
```

---

### 2.4. `packages/cli/src/commands/explain/output.ts`

```typescript
/**
 * Output formatting for `grafema explain` command
 */

import type { FileExplainResult } from '@grafema/core';
import type { ExplainJsonReport } from './types.js';

// ANSI colors (matching existing CLI style)
const COLORS = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
};

export function formatExplainReport(
  result: FileExplainResult,
  projectPath: string,
  verbose: boolean
): string;

export function buildExplainJsonReport(
  result: FileExplainResult,
  projectPath: string
): ExplainJsonReport;
```

**Output Format** (human-readable):

```
File Analysis Report
====================
File: src/pages/Invitations.tsx
Status: ANALYZED

Created nodes: 5
  FUNCTION: 2
    - Invitations (line 12)
    - fetchInvitations (line 35)
  VARIABLE: 2
    - invitations (line 8)
    - fetchInvitations (line 35)
  IMPORT: 1
    - authFetch (from ./utils/api)

Missing elements: 3
  - VARIABLE: response (line 43) - inside try block
  - VARIABLE: data (line 44) - inside try block
  - CALL: authFetch (line 43) - call inside try block

Known limitations that apply:
  - try-catch-variables: Variables inside try/catch blocks not extracted (2 affected)
    Related issue: REG-XXX

Run `grafema analyze --clear` to re-analyze with latest analyzer version.
```

---

## 3. Test Plan

### 3.1. Unit Tests: `packages/core/test/FileExplainer.test.ts`

```typescript
describe('FileExplainer', () => {
  describe('collectExpectedElements', () => {
    it('should collect top-level function declarations');
    it('should collect nested function declarations');
    it('should collect variable declarations (const/let/var)');
    it('should collect class declarations');
    it('should collect class methods');
    it('should mark elements inside try blocks with context');
    it('should mark elements inside callbacks with context');
    it('should handle syntax errors gracefully');
  });

  describe('findMissingElements', () => {
    it('should find elements in AST but not in graph');
    it('should match by name and line number');
    it('should handle renamed exports');
  });

  describe('detectLimitations', () => {
    it('should detect try-catch limitation');
    it('should detect dynamic import limitation');
    it('should count affected elements per limitation');
  });

  describe('explain', () => {
    it('should return NOT_FOUND for non-existent file');
    it('should return PARSE_ERROR for invalid syntax');
    it('should return NOT_ANALYZED for file not in graph');
    it('should return ANALYZED for fully analyzed file');
    it('should return PARTIAL for file with missing elements');
  });
});
```

### 3.2. Integration Tests: `packages/cli/test/explain.test.ts`

```typescript
describe('grafema explain', () => {
  describe('CLI options', () => {
    it('should show explain command in main help');
    it('should show explain help with --help flag');
    it('should support --project option');
    it('should support --json option');
    it('should support --verbose option');
  });

  describe('File not analyzed', () => {
    it('should report NOT_ANALYZED status');
    it('should suggest running grafema analyze');
  });

  describe('File analyzed', () => {
    it('should show created nodes count');
    it('should show nodes grouped by type');
    it('should show missing elements with reasons');
  });

  describe('JSON output', () => {
    it('should output valid JSON with --json flag');
    it('should include all required fields');
  });

  describe('Known limitations', () => {
    it('should explain try-catch limitation');
    it('should count affected elements');
  });
});
```

### 3.3. Test Fixtures

Create `packages/cli/test/fixtures/explain/`:

```
fixtures/explain/
  simple-function.js        # Simple case - should be fully analyzed
  try-catch-variables.js    # Has variables inside try block
  nested-callbacks.js       # Has variables inside callbacks
  syntax-error.js           # Invalid syntax for PARSE_ERROR case
  typescript-types.ts       # TypeScript with interfaces/types
```

**simple-function.js**:
```javascript
function greet(name) {
  const message = `Hello, ${name}`;
  return message;
}
module.exports = { greet };
```

**try-catch-variables.js**:
```javascript
async function fetchData(url) {
  try {
    const response = await fetch(url);  // This won't be in graph
    const data = await response.json(); // This won't be in graph
    return data;
  } catch (error) {
    console.error(error);
    return null;
  }
}
module.exports = { fetchData };
```

---

## 4. Implementation Order

**Step 1: Core FileExplainer class** (packages/core)
1. Create `FileExplainer.ts` with basic structure
2. Implement `parseFile()` using Babel
3. Implement `collectExpectedElements()` for functions, variables, classes
4. Implement `getNodesForFile()` using graph.queryNodes
5. Implement `findMissingElements()` with name+line matching
6. Add known limitations registry
7. Export from `packages/core/src/index.ts`

**Step 2: CLI command** (packages/cli)
1. Create `commands/explain.ts` with basic command structure
2. Create `commands/explain/types.ts`
3. Create `commands/explain/output.ts` for formatting
4. Register command in `cli.ts`

**Step 3: Unit tests** (packages/core/test)
1. Write tests for `collectExpectedElements`
2. Write tests for `findMissingElements`
3. Write tests for full `explain()` flow

**Step 4: Integration tests** (packages/cli/test)
1. Create test fixtures
2. Write CLI integration tests
3. Test edge cases (file not found, parse error, etc.)

**Step 5: Documentation**
1. Add command to CLI help
2. Update README if needed

---

## 5. Dependencies and Risks

**Dependencies**:
- Babel parser (already used in JSASTAnalyzer)
- RFDBServerBackend for graph queries (already used in query.ts)
- No new external dependencies needed

**Risks**:
1. **Performance on large files**: Parsing large files is O(n). Mitigation: single file at a time, already acceptable pattern.

2. **Expected elements heuristics**: May produce false positives if we collect too much. Mitigation: Start conservative (only top-level declarations), expand later.

3. **Maintenance burden**: Known limitations list must stay in sync with analyzer changes. Mitigation: Co-locate limitation definitions, add comments linking to analyzer code.

---

## Critical Files for Implementation

1. `packages/core/src/core/FileExplainer.ts` - **New file**: Core logic for AST-to-graph comparison
2. `packages/cli/src/commands/explain.ts` - **New file**: CLI command entry point
3. `packages/core/src/core/CoverageAnalyzer.ts` - **Pattern to follow**: File analysis pattern with graph backend
4. `packages/cli/src/commands/doctor.ts` - **Pattern to follow**: Diagnostic command structure with subdirectory
5. `packages/core/src/plugins/analysis/JSASTAnalyzer.ts` - **Reference**: Understand what IS extracted and how

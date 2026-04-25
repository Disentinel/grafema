# Kent Beck's Test Report - REG-177: `grafema explain` Command

## Summary

Created comprehensive tests for the `grafema explain` feature following TDD discipline.

## Files Created

### 1. Core Unit Tests
**File:** `/Users/vadimr/grafema-worker-8/test/unit/core/FileExplainer.test.ts`

Tests for `FileExplainer` class (to be implemented in `packages/core/src/core/FileExplainer.ts`):

#### Status Detection Tests
- Returns ANALYZED status for files with nodes in graph
- Returns NOT_ANALYZED status for files not in graph
- Returns NOT_ANALYZED when graph has nodes but not for the queried file

#### Node Counting Tests
- Returns correct total node count
- Returns 0 count for file with no nodes

#### Grouping by Type Tests
- Groups nodes by type correctly (MODULE, FUNCTION, VARIABLE)
- Handles namespaced types in grouping (http:request, etc.)

#### Scope Context Detection Tests (Key Feature)
- Detects `try` block scope from semantic ID
- Detects `catch` block scope from semantic ID
- Detects `if` block scope from semantic ID
- No context annotation for regular nodes without special scope
- Detects nested scopes (try inside function)

#### Result Structure Tests
- Returns complete FileExplainResult structure
- Includes semantic IDs in nodes for querying
- Includes line numbers when available

#### Edge Cases
- Handles empty graph gracefully
- Handles file path with spaces
- Handles deeply nested semantic IDs
- Handles semantic ID parsing failures gracefully
- Sorts nodes by type and name

#### Real-World Scenario Test
- Explains file with try/catch variables correctly (mimics the REG-177 user report)

### 2. CLI Integration Tests
**File:** `/Users/vadimr/grafema-worker-8/packages/cli/test/explain-command.test.ts`

Tests for `grafema explain <file>` CLI command:

#### Help and Basic Usage
- Shows help with --help flag
- Shows error when no file argument provided
- Listed in main help

#### Error Handling
- Shows error for non-existent file

#### NOT_ANALYZED Status
- Shows NOT_ANALYZED for file not in graph
- Suggests running `grafema analyze` for unanalyzed file

#### Node Listing
- Shows node list for analyzed file
- Displays semantic IDs for querying
- Shows node count

#### Scope Context Annotations
- Annotates variables in try blocks
- Annotates variables in catch blocks

#### JSON Output
- Outputs valid JSON with --json flag
- Includes semantic IDs in JSON output
- Includes byType grouping in JSON output

#### Integration
- Displays IDs that can be used with query command

#### Edge Cases
- Handles file with no functions or classes
- Handles relative file paths
- Handles absolute file paths
- Errors gracefully when no database exists

#### Real-World Scenario
- Helps user find `response` variable in try block
- Shows query examples or hints

## Types Required for Implementation

The implementation needs to export from `@grafema/core`:

```typescript
export interface FileExplainResult {
  file: string;
  status: 'ANALYZED' | 'NOT_ANALYZED';
  nodes: EnhancedNode[];
  byType: Record<string, number>;
  totalCount: number;
}

export interface EnhancedNode extends BaseNodeRecord {
  context?: string;  // e.g., "inside try block", "catch parameter", "inside conditional"
}

export class FileExplainer {
  constructor(graph: GraphBackend);

  async explain(filePath: string): Promise<FileExplainResult>;

  // Private methods:
  // - getNodesForFile(filePath: string): Promise<BaseNodeRecord[]>
  // - groupByType(nodes: BaseNodeRecord[]): Record<string, number>
  // - enhanceWithContext(nodes: BaseNodeRecord[]): EnhancedNode[]
}
```

## Test Patterns Used

- Mock GraphBackend for isolated unit testing
- Temp directories with cleanup for CLI integration tests
- Node.js native `node:test` runner
- Async/await patterns
- Comprehensive assertions with helpful error messages

## Validation Status

- Both test files pass syntax validation
- Core tests fail as expected with: "FileExplainer doesn't exist" (TDD)
- CLI tests use existing test patterns from `ls-command.test.ts`

## Next Steps for Implementation

1. Implement `FileExplainer` class in `packages/core/src/core/FileExplainer.ts`
2. Export from `packages/core/src/index.ts`
3. Implement `explain` CLI command in `packages/cli/src/commands/explain.ts`
4. Register command in CLI main entry point

## Test Commands

Run core tests:
```bash
node --import tsx --test test/unit/core/FileExplainer.test.ts
```

Run CLI tests:
```bash
cd packages/cli && pnpm test
# or specifically:
node --import tsx --test packages/cli/test/explain-command.test.ts
```

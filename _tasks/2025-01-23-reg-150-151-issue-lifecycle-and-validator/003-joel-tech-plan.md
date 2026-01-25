# Joel Spolsky - Technical Implementation Plan

## Summary

REG-150 and REG-151 complete the unfinished work from REG-95. The `IssueNode` implementation exists but lacks proper type exports in `packages/types`, the `reportIssue()` method on `PluginContext`, and wiring into the Orchestrator. Issue lifecycle is already handled by `clearFileNodesIfNeeded()` which clears all nodes for a file (including issues). This plan details exact file changes, method signatures, and test requirements.

## Current State Analysis

**Already Done (REG-95):**
- `packages/core/src/core/nodes/IssueNode.ts` - Full implementation with `generateId()`, `create()`, `validate()`, `parseId()`, `isIssueType()`
- `packages/core/src/core/NodeFactory.ts` - `createIssue()` method
- `packages/core/src/index.ts` - Exports `IssueNode`, `IssueNodeRecord`, `IssueSeverity`, `IssueType`
- `test/unit/core/nodes/IssueNode.test.js` - 75 tests passing

**Missing:**
1. Types not exported from `packages/types` - types are only in `packages/core`, breaking the monorepo architecture (types should be in types package)
2. `AFFECTS` edge type not in `packages/types/src/edges.ts`
3. `IssueSpec` interface not defined
4. `reportIssue()` not on `PluginContext`
5. `IssueReporter` utility class not created
6. Orchestrator does not provide `reportIssue()` to plugins
7. SQLInjectionValidator does not use `reportIssue()`

## Step 1: Add Types to packages/types

### File: packages/types/src/nodes.ts

Add after `GuaranteeStatus`:

```typescript
// === ISSUE NODE TYPES ===

export type IssueSeverity = 'error' | 'warning' | 'info';
export type IssueType = `issue:${string}`;

export interface IssueNodeRecord extends BaseNodeRecord {
  type: IssueType;
  severity: IssueSeverity;
  category: string;
  message: string;
  plugin: string;
  targetNodeId?: string;
  createdAt: number;
  context?: Record<string, unknown>;
}
```

Add `IssueNodeRecord` to the `NodeRecord` union.

### File: packages/types/src/edges.ts

Add to EDGE_TYPE:
```typescript
AFFECTS: 'AFFECTS',  // ISSUE -> TARGET_NODE
```

Add interface:
```typescript
export interface AffectsEdge extends EdgeRecord {
  type: 'AFFECTS';
}
```

### File: packages/types/src/plugins.ts

Add IssueSpec interface:
```typescript
export interface IssueSpec {
  category: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  file: string;
  line: number;
  column?: number;
  targetNodeId?: string;
  context?: Record<string, unknown>;
}
```

Extend PluginContext:
```typescript
reportIssue?(issue: IssueSpec): Promise<string>;
```

## Step 2: Implement IssueReporter Utility

### File: packages/core/src/core/IssueReporter.ts (NEW)

```typescript
import type { GraphBackend, IssueSpec } from '@grafema/types';
import { NodeFactory } from './NodeFactory.js';
import type { IssueSeverity } from './nodes/IssueNode.js';

export class IssueReporter {
  private graph: GraphBackend;
  private pluginName: string;
  private createdCount: number = 0;

  constructor(graph: GraphBackend, pluginName: string) {
    this.graph = graph;
    this.pluginName = pluginName;
  }

  async reportIssue(issue: IssueSpec): Promise<string> {
    const { category, severity, message, file, line, column = 0, targetNodeId, context } = issue;

    const issueNode = NodeFactory.createIssue(
      category,
      severity as IssueSeverity,
      message,
      this.pluginName,
      file,
      line,
      column,
      { context }
    );

    await this.graph.addNode(issueNode);
    this.createdCount++;

    if (targetNodeId) {
      await this.graph.addEdge({
        src: issueNode.id,
        dst: targetNodeId,
        type: 'AFFECTS',
      });
    }

    return issueNode.id;
  }

  getCreatedCount(): number {
    return this.createdCount;
  }
}
```

## Step 3: Wire into Orchestrator

### File: packages/core/src/Orchestrator.ts

Provide `reportIssue` for VALIDATION phase plugins:

```typescript
if (phaseName === 'VALIDATION') {
  const issueReporter = new IssueReporter(context.graph, plugin.metadata.name);
  pluginContext.reportIssue = (issue) => issueReporter.reportIssue(issue);
}
```

## Step 4: Migrate SQLInjectionValidator

### File: packages/core/src/plugins/validation/SQLInjectionValidator.ts

1. Update metadata:
```typescript
creates: {
  nodes: ['issue:security'],
  edges: ['AFFECTS']
}
```

2. In execute(), when vulnerability detected:
```typescript
if (context.reportIssue) {
  await context.reportIssue({
    category: 'security',
    severity: 'error',
    message: issue.message,
    file: call.file,
    line: call.line || 0,
    column: call.column || 0,
    targetNodeId: call.id,
    context: {
      type: 'SQL_INJECTION',
      reason: result.reason,
      nondeterministicSources: result.sources
    }
  });
  issueNodeCount++;
}
```

3. Keep backward compatibility - still return issues in metadata.

## Step 5: Tests

1. **IssueReporter unit tests** - `test/unit/core/IssueReporter.test.js`
2. **SQLInjectionValidator tests** - Add tests for reportIssue integration
3. **Lifecycle integration tests** - Verify issues cleared on reanalysis

## Files Changed Summary

| Package | File | Action |
|---------|------|--------|
| types | `src/nodes.ts` | Modify: Add IssueSeverity, IssueType, IssueNodeRecord |
| types | `src/edges.ts` | Modify: Add AFFECTS edge type |
| types | `src/plugins.ts` | Modify: Add IssueSpec, extend PluginContext |
| core | `src/core/IssueReporter.ts` | **NEW** |
| core | `src/Orchestrator.ts` | Modify: Wire reportIssue |
| core | `src/plugins/validation/SQLInjectionValidator.ts` | Modify: Use reportIssue() |
| core | `src/index.ts` | Modify: Export IssueReporter |
| test | `test/unit/core/IssueReporter.test.js` | **NEW** |
| test | `test/integration/issue-lifecycle.test.js` | **NEW** |

## Acceptance Criteria

1. Types compile - `npm run build` passes in packages/types
2. Core compiles - `npm run build` passes in packages/core
3. IssueReporter tests pass
4. SQLInjectionValidator tests pass (existing + new)
5. Issues queryable via `queryNodes({ type: 'issue:security' })`
6. AFFECTS edges connect to target nodes
7. Backward compatible - works without reportIssue

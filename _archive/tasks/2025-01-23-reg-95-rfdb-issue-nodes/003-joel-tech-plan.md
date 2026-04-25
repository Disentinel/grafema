# Joel Spolsky's Technical Implementation Plan: REG-95 ISSUE Nodes

## Executive Summary

This plan expands Don Melton's architectural assessment into executable steps for implementing ISSUE nodes in Grafema. The plan covers exact type definitions, step-by-step file changes, test requirements, and migration guide for `SQLInjectionValidator`.

---

## 1. Exact Type Definitions

### 1.1 Issue Severity Levels

```typescript
// packages/types/src/nodes.ts - Add after GuaranteePriority/Status

/**
 * Issue severity levels (ordered by severity)
 * - error: Critical problem that must be fixed
 * - warning: Potential problem that should be reviewed
 * - info: Informational finding
 */
export type IssueSeverity = 'error' | 'warning' | 'info';
```

### 1.2 Issue Node Record Interface

```typescript
// packages/types/src/nodes.ts - Add after GuaranteeNodeRecord

/**
 * Issue node - represents detected problems in the codebase
 *
 * ID format: issue:<category>#<hash>
 * where hash = sha256(plugin + file + line + column + message).substring(0, 12)
 *
 * Example: issue:security#a3f2b1c4d5e6
 */
export interface IssueNodeRecord extends BaseNodeRecord {
  type: IssueType;
  severity: IssueSeverity;
  category: string;           // Extensible: 'security', 'performance', 'style', 'smell', etc.
  message: string;            // Human-readable issue description
  plugin: string;             // Plugin that detected this issue (e.g., 'SQLInjectionValidator')
  targetNodeId?: string;      // ID of the affected node (stored in edge, but cached here)
  createdAt: number;          // Timestamp when first detected
  lastSeenAt: number;         // Timestamp when last confirmed
  context?: Record<string, unknown>;  // Plugin-specific details (e.g., nondeterministicSources)
}
```

### 1.3 Issue Type Constants

```typescript
// packages/core/src/core/nodes/NodeKind.ts - Add to NAMESPACED_TYPE

export const NAMESPACED_TYPE = {
  // ... existing entries ...

  // Issues (detected problems)
  ISSUE_SECURITY: 'issue:security',
  ISSUE_PERFORMANCE: 'issue:performance',
  ISSUE_STYLE: 'issue:style',
  ISSUE_SMELL: 'issue:smell',
} as const;
```

### 1.4 Issue Type Union

```typescript
// packages/core/src/core/nodes/NodeKind.ts - Add helper

export type IssueType =
  | 'issue:security'
  | 'issue:performance'
  | 'issue:style'
  | 'issue:smell'
  | `issue:${string}`;  // Allow custom categories

/**
 * Check if type is an issue type (issue:*)
 */
export function isIssueType(nodeType: string): boolean {
  if (!nodeType) return false;
  return getNamespace(nodeType) === 'issue';
}
```

### 1.5 AFFECTS Edge Type

```typescript
// packages/types/src/edges.ts - Add to EDGE_TYPE

export const EDGE_TYPE = {
  // ... existing entries ...

  // Issues
  AFFECTS: 'AFFECTS',    // ISSUE -> TARGET_NODE (issue affects this code)
} as const;
```

### 1.6 AFFECTS Edge Interface

```typescript
// packages/types/src/edges.ts - Add after RouteEdge

/**
 * Edge from ISSUE node to the code it affects
 * Direction: ISSUE -[AFFECTS]-> TARGET_NODE
 *
 * This follows the same pattern as GOVERNS (GUARANTEE -> TARGET)
 */
export interface AffectsEdge extends EdgeRecord {
  type: 'AFFECTS';
}
```

---

## 2. Step-by-Step Implementation Changes

### Phase A: Types Package (packages/types/)

#### File: `packages/types/src/nodes.ts`

**Step A1:** Add IssueSeverity type (line ~215, after GuaranteeStatus)

```typescript
// Issue severity levels
export type IssueSeverity = 'error' | 'warning' | 'info';
```

**Step A2:** Add IssueNodeRecord interface (line ~228, after GuaranteeNodeRecord)

```typescript
// Issue node (detected problems)
export interface IssueNodeRecord extends BaseNodeRecord {
  type: `issue:${string}`;
  severity: IssueSeverity;
  category: string;
  message: string;
  plugin: string;
  targetNodeId?: string;
  createdAt: number;
  lastSeenAt: number;
  context?: Record<string, unknown>;
}
```

**Step A3:** Add IssueNodeRecord to NodeRecord union (line ~246)

```typescript
export type NodeRecord =
  // ... existing types ...
  | GuaranteeNodeRecord
  | IssueNodeRecord        // <-- ADD
  | BaseNodeRecord;
```

#### File: `packages/types/src/edges.ts`

**Step A4:** Add AFFECTS to EDGE_TYPE (line ~70, after VIOLATES)

```typescript
  GOVERNS: 'GOVERNS',
  VIOLATES: 'VIOLATES',
  AFFECTS: 'AFFECTS',      // <-- ADD: ISSUE -> TARGET_NODE
```

**Step A5:** Add AffectsEdge interface (line ~138, after RouteEdge)

```typescript
export interface AffectsEdge extends EdgeRecord {
  type: 'AFFECTS';
}
```

#### File: `packages/types/src/plugins.ts`

**Step A6:** Add IssueSpec interface (line ~197, before createSuccessResult)

```typescript
/**
 * Specification for reporting an issue
 * Used by plugins via context.reportIssue()
 */
export interface IssueSpec {
  category: string;           // e.g., 'security', 'performance'
  severity: 'error' | 'warning' | 'info';
  message: string;            // Human-readable description
  targetNodeId: string;       // Node this issue affects
  context?: Record<string, unknown>;  // Plugin-specific data
}
```

**Step A7:** Extend PluginContext interface (line ~74, add to interface)

```typescript
export interface PluginContext {
  // ... existing fields ...

  /**
   * Report an issue to persist in the graph.
   * Creates ISSUE node and AFFECTS edge.
   *
   * @param issue - Issue specification
   * @returns Promise<string> - ID of created issue node
   */
  reportIssue?(issue: IssueSpec): Promise<string>;
}
```

---

### Phase B: Core Package - Node Contract (packages/core/)

#### File: `packages/core/src/core/nodes/IssueNode.ts` (NEW)

**Step B1:** Create IssueNode contract class

```typescript
/**
 * IssueNode - contract for issue:* nodes
 *
 * Types: issue:security, issue:performance, issue:style, issue:smell
 * ID format: issue:<category>#<hash>
 *
 * Issues represent detected problems in the codebase.
 * They connect to affected code via AFFECTS edges.
 */

import { createHash } from 'crypto';
import type { BaseNodeRecord } from '@grafema/types';
import { getNamespace } from './NodeKind.js';

// Severity type
export type IssueSeverity = 'error' | 'warning' | 'info';

// Issue types
export type IssueType = `issue:${string}`;

export interface IssueNodeRecord extends BaseNodeRecord {
  type: IssueType;
  severity: IssueSeverity;
  category: string;
  message: string;
  plugin: string;
  targetNodeId?: string;
  createdAt: number;
  lastSeenAt: number;
  context?: Record<string, unknown>;
}

export interface IssueNodeOptions {
  context?: Record<string, unknown>;
}

// Valid severity levels
const VALID_SEVERITIES = ['error', 'warning', 'info'] as const;

export class IssueNode {
  static readonly REQUIRED = ['category', 'severity', 'message', 'plugin', 'file'] as const;
  static readonly OPTIONAL = ['targetNodeId', 'context'] as const;

  /**
   * Generate deterministic issue ID
   * Format: issue:<category>#<hash12>
   *
   * Hash is based on plugin + file + line + column + message
   * This ensures same issue = same ID across analysis runs
   */
  static generateId(
    category: string,
    plugin: string,
    file: string,
    line: number,
    column: number,
    message: string
  ): string {
    const hashInput = `${plugin}|${file}|${line}|${column}|${message}`;
    const hash = createHash('sha256').update(hashInput).digest('hex').substring(0, 12);
    return `issue:${category}#${hash}`;
  }

  /**
   * Create issue node
   *
   * @param category - Issue category (security, performance, style, smell, or custom)
   * @param severity - error | warning | info
   * @param message - Human-readable description
   * @param plugin - Plugin name that detected this issue
   * @param file - File where issue was detected
   * @param line - Line number
   * @param column - Column number (optional, defaults to 0)
   * @param options - Optional fields (context)
   */
  static create(
    category: string,
    severity: IssueSeverity,
    message: string,
    plugin: string,
    file: string,
    line: number,
    column: number = 0,
    options: IssueNodeOptions = {}
  ): IssueNodeRecord {
    if (!category) throw new Error('IssueNode.create: category is required');
    if (!severity) throw new Error('IssueNode.create: severity is required');
    if (!VALID_SEVERITIES.includes(severity)) {
      throw new Error(`IssueNode.create: invalid severity "${severity}". Valid: ${VALID_SEVERITIES.join(', ')}`);
    }
    if (!message) throw new Error('IssueNode.create: message is required');
    if (!plugin) throw new Error('IssueNode.create: plugin is required');
    if (!file) throw new Error('IssueNode.create: file is required');

    const type = `issue:${category}` as IssueType;
    const id = this.generateId(category, plugin, file, line, column, message);
    const now = Date.now();

    return {
      id,
      type,
      name: message.substring(0, 100), // Truncate for display
      file,
      line,
      column,
      severity,
      category,
      message,
      plugin,
      createdAt: now,
      lastSeenAt: now,
      context: options.context,
    };
  }

  /**
   * Validate issue node
   * @returns array of error messages, empty if valid
   */
  static validate(node: IssueNodeRecord): string[] {
    const errors: string[] = [];

    if (!IssueNode.isIssueType(node.type)) {
      errors.push(`Expected issue:* type, got ${node.type}`);
    }

    if (!node.category) {
      errors.push('Missing required field: category');
    }

    if (!node.severity) {
      errors.push('Missing required field: severity');
    } else if (!VALID_SEVERITIES.includes(node.severity as IssueSeverity)) {
      errors.push(`Invalid severity: ${node.severity}. Valid: ${VALID_SEVERITIES.join(', ')}`);
    }

    if (!node.message) {
      errors.push('Missing required field: message');
    }

    if (!node.plugin) {
      errors.push('Missing required field: plugin');
    }

    return errors;
  }

  /**
   * Parse issue ID into components
   * @param id - full ID (e.g., 'issue:security#a3f2b1c4d5e6')
   * @returns { category, hash } or null if invalid
   */
  static parseId(id: string): { category: string; hash: string } | null {
    if (!id) return null;

    const match = id.match(/^issue:([^#]+)#(.+)$/);
    if (!match) return null;

    return {
      category: match[1],
      hash: match[2],
    };
  }

  /**
   * Check if type is an issue type
   */
  static isIssueType(type: string): boolean {
    if (!type) return false;
    return getNamespace(type) === 'issue';
  }

  /**
   * Get all known issue categories
   */
  static getCategories(): string[] {
    return ['security', 'performance', 'style', 'smell'];
  }
}
```

#### File: `packages/core/src/core/nodes/NodeKind.ts`

**Step B2:** Add issue types to NAMESPACED_TYPE (line ~91, before closing brace)

```typescript
  // ... existing entries ...

  // Issues
  ISSUE_SECURITY: 'issue:security',
  ISSUE_PERFORMANCE: 'issue:performance',
  ISSUE_STYLE: 'issue:style',
  ISSUE_SMELL: 'issue:smell',
} as const;
```

**Step B3:** Add isIssueType helper (line ~172, after isGuaranteeType)

```typescript
/**
 * Check if type is an issue type (issue:*)
 */
export function isIssueType(nodeType: string): boolean {
  if (!nodeType) return false;
  return getNamespace(nodeType) === 'issue';
}
```

#### File: `packages/core/src/core/nodes/index.ts`

**Step B4:** Export IssueNode (line ~48, after GuaranteeNode)

```typescript
// Issue nodes (detected problems)
export { IssueNode, type IssueNodeRecord, type IssueSeverity, type IssueType } from './IssueNode.js';
```

**Step B5:** Add isIssueType to NodeKind exports (line ~60)

```typescript
export {
  // ... existing exports ...
  isGuaranteeType,
  isIssueType,           // <-- ADD
  // ...
} from './NodeKind.js';
```

#### File: `packages/core/src/core/NodeFactory.ts`

**Step B6:** Add import for IssueNode (line ~48, after existing imports)

```typescript
import {
  // ... existing imports ...
  IssueNode,
  type IssueSeverity,
} from './nodes/index.js';
```

**Step B7:** Add IssueOptions interface (line ~203, after ExpressionOptions)

```typescript
interface IssueOptions {
  context?: Record<string, unknown>;
}
```

**Step B8:** Add createIssue method (line ~572, after createArgumentExpression)

```typescript
/**
 * Create ISSUE node
 *
 * Issues represent detected problems in the codebase.
 * Used by validation plugins to persist findings in the graph.
 *
 * @param category - Issue category (security, performance, style, smell)
 * @param severity - error | warning | info
 * @param message - Human-readable description
 * @param plugin - Name of the plugin that detected this issue
 * @param file - File path where issue was detected
 * @param line - Line number
 * @param column - Column number (optional)
 * @param options - Optional context data
 */
static createIssue(
  category: string,
  severity: IssueSeverity,
  message: string,
  plugin: string,
  file: string,
  line: number,
  column: number = 0,
  options: IssueOptions = {}
) {
  return IssueNode.create(category, severity, message, plugin, file, line, column, options);
}
```

**Step B9:** Add IssueNode to validators map (line ~605, after EXPRESSION)

```typescript
static validate(node: BaseNodeRecord): string[] {
  const validators: Record<string, NodeValidator> = {
    // ... existing entries ...
    'EXPRESSION': ExpressionNode
  };

  // Handle issue:* types dynamically
  if (IssueNode.isIssueType(node.type)) {
    return IssueNode.validate(node as unknown as IssueNodeRecord);
  }

  const validator = validators[node.type];
  // ... rest of method
}
```

---

### Phase C: Plugin API Enhancement

#### File: `packages/core/src/plugins/IssueReporter.ts` (NEW)

**Step C1:** Create IssueReporter utility

```typescript
/**
 * IssueReporter - utility for plugins to report issues
 *
 * Encapsulates issue node creation and AFFECTS edge creation.
 * Used by the orchestrator to provide context.reportIssue() to plugins.
 */

import type { GraphBackend, IssueSpec } from '@grafema/types';
import { NodeFactory } from '../core/NodeFactory.js';
import type { IssueSeverity } from '../core/nodes/IssueNode.js';

export class IssueReporter {
  constructor(
    private graph: GraphBackend,
    private pluginName: string,
    private file: string
  ) {}

  /**
   * Report an issue and persist it in the graph
   *
   * @param issue - Issue specification
   * @returns ID of created issue node
   */
  async reportIssue(issue: IssueSpec): Promise<string> {
    const { category, severity, message, targetNodeId, context } = issue;

    // Create issue node
    const issueNode = NodeFactory.createIssue(
      category,
      severity as IssueSeverity,
      message,
      this.pluginName,
      this.file,
      0, // line - ideally extracted from targetNodeId
      0, // column
      { context }
    );

    // Add node to graph
    await this.graph.addNode(issueNode);

    // Create AFFECTS edge to target
    if (targetNodeId) {
      await this.graph.addEdge({
        src: issueNode.id,
        dst: targetNodeId,
        type: 'AFFECTS',
      });
    }

    return issueNode.id;
  }

  /**
   * Report issue with line/column info
   */
  async reportIssueAtLocation(
    category: string,
    severity: IssueSeverity,
    message: string,
    line: number,
    column: number,
    targetNodeId?: string,
    context?: Record<string, unknown>
  ): Promise<string> {
    const issueNode = NodeFactory.createIssue(
      category,
      severity,
      message,
      this.pluginName,
      this.file,
      line,
      column,
      { context }
    );

    await this.graph.addNode(issueNode);

    if (targetNodeId) {
      await this.graph.addEdge({
        src: issueNode.id,
        dst: targetNodeId,
        type: 'AFFECTS',
      });
    }

    return issueNode.id;
  }
}
```

#### File: `packages/core/src/plugins/index.ts`

**Step C2:** Export IssueReporter

```typescript
export { IssueReporter } from './IssueReporter.js';
```

---

### Phase D: Migrate SQLInjectionValidator

#### File: `packages/core/src/plugins/validation/SQLInjectionValidator.ts`

**Step D1:** Import IssueReporter (line ~25)

```typescript
import { IssueReporter } from '../IssueReporter.js';
```

**Step D2:** Update metadata to declare created nodes (line ~106)

```typescript
get metadata(): PluginMetadata {
  return {
    name: 'SQLInjectionValidator',
    phase: 'VALIDATION',
    priority: 90,
    creates: {
      nodes: ['issue:security'],  // <-- ADD
      edges: ['AFFECTS']          // <-- ADD
    }
  };
}
```

**Step D3:** Replace issues array with graph persistence (execute method)

Replace the entire `execute` method with:

```typescript
async execute(context: PluginContext): Promise<PluginResult> {
  const { graph } = context;
  const log = this.log(context);

  log.info('Checking for SQL injection vulnerabilities...');

  const issues: SQLInjectionIssue[] = [];
  let issueNodeCount = 0;

  // 1. Find all CALL nodes that look like SQL queries
  const sqlCalls: CallNode[] = [];
  for await (const node of graph.queryNodes({ nodeType: 'CALL' })) {
    const callNode = node as CallNode;
    const method = callNode.method || callNode.name;
    if (method && SQL_METHODS.includes(method as string)) {
      sqlCalls.push(callNode);
    }
  }

  log.info(`Found ${sqlCalls.length} potential SQL calls`);

  // 2. For each SQL call, analyze the query argument
  for (const call of sqlCalls) {
    const result = await this.analyzeQueryCall(call, graph);
    if (result.isVulnerable) {
      const issue: SQLInjectionIssue = {
        type: 'SQL_INJECTION',
        severity: 'ERROR',
        message: `Potential SQL injection at ${call.file}:${call.line || '?'} - ${result.reason}`,
        nodeId: call.id,
        file: call.file,
        line: call.line as number | undefined,
        reason: result.reason!,
        nondeterministicSources: result.sources
      };
      issues.push(issue);

      // Persist to graph using context.reportIssue if available
      if (context.reportIssue) {
        await context.reportIssue({
          category: 'security',
          severity: 'error',
          message: issue.message,
          targetNodeId: call.id,
          context: {
            type: 'SQL_INJECTION',
            reason: result.reason,
            nondeterministicSources: result.sources
          }
        });
        issueNodeCount++;
      }
    }
  }

  // 3. Also check via graph pattern
  const patternViolations = await this.checkViaGraphPattern(graph, sqlCalls);
  for (const violation of patternViolations) {
    if (!issues.find(i => i.nodeId === violation.nodeId)) {
      issues.push(violation);

      if (context.reportIssue) {
        await context.reportIssue({
          category: 'security',
          severity: 'error',
          message: violation.message,
          targetNodeId: violation.nodeId,
          context: {
            type: 'SQL_INJECTION',
            reason: violation.reason,
            nondeterministicSources: violation.nondeterministicSources
          }
        });
        issueNodeCount++;
      }
    }
  }

  const summary = {
    sqlCallsChecked: sqlCalls.length,
    vulnerabilitiesFound: issues.length,
    issueNodesPersisted: issueNodeCount
  };

  log.info('Summary:', summary);

  if (issues.length > 0) {
    log.warn(`SQL injection vulnerabilities found: ${issues.length}`);
    for (const issue of issues) {
      log.error(issue.message);
    }
  } else {
    log.info('No SQL injection vulnerabilities detected');
  }

  return createSuccessResult(
    { nodes: issueNodeCount, edges: issueNodeCount },  // <-- UPDATE
    { summary, issues }
  );
}
```

---

## 3. Test Requirements (for Kent Beck)

### Test File: `test/unit/core/nodes/IssueNode.test.ts` (NEW)

**Tests to write:**

1. **ID Generation**
   - `IssueNode.generateId() should produce deterministic IDs`
   - `same inputs should produce same ID`
   - `different inputs should produce different IDs`

2. **Node Creation**
   - `IssueNode.create() should create valid issue node`
   - `should throw if category is missing`
   - `should throw if severity is missing`
   - `should throw if severity is invalid`
   - `should throw if message is missing`
   - `should throw if plugin is missing`
   - `should throw if file is missing`
   - `should set createdAt and lastSeenAt to current time`

3. **ID Parsing**
   - `IssueNode.parseId() should parse valid issue ID`
   - `should return null for invalid format`
   - `should extract category and hash`

4. **Type Checking**
   - `IssueNode.isIssueType() should return true for issue:security`
   - `should return true for issue:custom`
   - `should return false for FUNCTION`
   - `should return false for guarantee:queue`

5. **Validation**
   - `IssueNode.validate() should return empty array for valid node`
   - `should return errors for missing fields`
   - `should return errors for invalid severity`

### Test File: `test/unit/core/NodeFactory.test.ts`

**Add tests:**

1. `NodeFactory.createIssue() should create issue node`
2. `should pass options.context to node`

### Test File: `test/unit/plugins/SQLInjectionValidator.test.ts`

**Update existing tests:**

1. `should persist issue nodes when context.reportIssue is available`
2. `should not break when context.reportIssue is not available (backward compat)`
3. `should create AFFECTS edges from issue to target node`

### Test File: `test/integration/issue-nodes.test.ts` (NEW)

**Integration tests:**

1. `issues should be queryable from graph after analysis`
2. `issues should be cleared on file reanalysis`
3. `AFFECTS edges should connect issue to target node`

---

## 4. Implementation Order (for Rob Pike)

### Day 1: Types and Node Contract

1. **packages/types/src/nodes.ts** - Add IssueSeverity, IssueNodeRecord
2. **packages/types/src/edges.ts** - Add AFFECTS
3. **packages/types/src/plugins.ts** - Add IssueSpec, extend PluginContext
4. **packages/core/src/core/nodes/NodeKind.ts** - Add issue types and isIssueType
5. **packages/core/src/core/nodes/IssueNode.ts** - Create new file
6. **packages/core/src/core/nodes/index.ts** - Export IssueNode
7. **Run tests** - Ensure no regressions

### Day 2: Factory and Reporter

1. **packages/core/src/core/NodeFactory.ts** - Add createIssue method
2. **packages/core/src/plugins/IssueReporter.ts** - Create new file
3. **packages/core/src/plugins/index.ts** - Export IssueReporter
4. **Write unit tests** for IssueNode and NodeFactory.createIssue
5. **Run tests**

### Day 3: Migrate SQLInjectionValidator

1. **packages/core/src/plugins/validation/SQLInjectionValidator.ts** - Update
2. **Write integration tests** for issue persistence
3. **Run full test suite**
4. **Manual verification** - Run `grafema analyze` on test project

---

## 5. SQLInjectionValidator Migration Guide

### Before (current code)

```typescript
const issues: SQLInjectionIssue[] = [];

// ... detection logic ...

if (result.isVulnerable) {
  issues.push({
    type: 'SQL_INJECTION',
    severity: 'ERROR',
    message: `Potential SQL injection at ${call.file}:${call.line || '?'}`,
    nodeId: call.id,
    // ...
  });
}

return createSuccessResult(
  { nodes: 0, edges: 0 },
  { summary, issues }  // Issues only in metadata, not persisted
);
```

### After (with ISSUE nodes)

```typescript
const issues: SQLInjectionIssue[] = [];
let issueNodeCount = 0;

// ... detection logic ...

if (result.isVulnerable) {
  issues.push({
    type: 'SQL_INJECTION',
    severity: 'ERROR',
    message: `Potential SQL injection at ${call.file}:${call.line || '?'}`,
    nodeId: call.id,
    // ...
  });

  // NEW: Persist to graph
  if (context.reportIssue) {
    await context.reportIssue({
      category: 'security',
      severity: 'error',
      message: issue.message,
      targetNodeId: call.id,
      context: { type: 'SQL_INJECTION', reason: result.reason }
    });
    issueNodeCount++;
  }
}

return createSuccessResult(
  { nodes: issueNodeCount, edges: issueNodeCount },  // Report created nodes
  { summary, issues }  // Keep issues in metadata for backward compat
);
```

### Key Points

1. **Backward compatible**: If `context.reportIssue` is not available, plugin works as before
2. **Both paths**: Issues are both persisted AND returned in metadata (for CLI output)
3. **Count tracking**: Track how many issue nodes were created for PluginResult
4. **Context data**: Plugin-specific details go into `context` field of IssueSpec

---

## 6. Acceptance Criteria

1. **Types compile** - `npm run build` passes in packages/types
2. **Core compiles** - `npm run build` passes in packages/core
3. **IssueNode tests pass** - 100% coverage on IssueNode class
4. **SQLInjectionValidator tests pass** - Existing tests still work
5. **Integration test** - Issues are queryable via `graph.queryNodes({ type: 'issue:security' })`
6. **AFFECTS edges exist** - `graph.getIncomingEdges(nodeId, ['AFFECTS'])` returns issue edges

---

## 7. Files Changed Summary

| Package | File | Action |
|---------|------|--------|
| types | `src/nodes.ts` | Modify: Add IssueSeverity, IssueNodeRecord |
| types | `src/edges.ts` | Modify: Add AFFECTS |
| types | `src/plugins.ts` | Modify: Add IssueSpec, extend PluginContext |
| core | `src/core/nodes/NodeKind.ts` | Modify: Add issue types, isIssueType |
| core | `src/core/nodes/IssueNode.ts` | **NEW**: Node contract class |
| core | `src/core/nodes/index.ts` | Modify: Export IssueNode |
| core | `src/core/NodeFactory.ts` | Modify: Add createIssue |
| core | `src/plugins/IssueReporter.ts` | **NEW**: Utility class |
| core | `src/plugins/index.ts` | Modify: Export IssueReporter |
| core | `src/plugins/validation/SQLInjectionValidator.ts` | Modify: Use reportIssue |

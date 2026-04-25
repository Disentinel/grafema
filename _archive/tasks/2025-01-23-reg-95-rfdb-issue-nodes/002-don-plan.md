# Don Melton's Architectural Assessment: REG-95 RFDB Issue Nodes

## Current Architecture Assessment

### 1. Node System

**Current Pattern:**
- All nodes extend `BaseNodeRecord` from `packages/types/src/nodes.ts`
- Node types are either "base types" (`FUNCTION`, `CLASS`, etc.) or "namespaced types" (`http:route`, `db:query`, `guarantee:*`)
- Node creation goes through `NodeFactory` in `packages/core/src/core/NodeFactory.ts`
- Each node type has its own contract class in `packages/core/src/core/nodes/`

**Key files:**
- `/packages/types/src/nodes.ts` - Type definitions
- `/packages/core/src/core/nodes/NodeKind.ts` - Type constants and helpers
- `/packages/core/src/core/NodeFactory.ts` - Factory class
- `/packages/core/src/core/nodes/GuaranteeNode.ts` - Similar pattern to what we need

### 2. Edge System

**Current Pattern:**
- Edges defined in `packages/types/src/edges.ts`
- EDGE_TYPE constants for all edge types
- Current edge types include `GOVERNS`, `VIOLATES` for guarantees

### 3. Plugin System

**Current Pattern:**
- Plugins extend `Plugin` base class
- VALIDATION phase plugins already detect issues but store them in `PluginResult.metadata.issues`
- Issues are logged to console and returned in result, but NOT persisted in graph
- Example validators: `SQLInjectionValidator`, `TypeScriptDeadCodeValidator`, `GraphConnectivityValidator`

**Current issue structure in validators:**
```typescript
interface SQLInjectionIssue {
  type: string;           // 'SQL_INJECTION'
  severity: string;       // 'ERROR'
  message: string;
  nodeId: string;
  file?: string;
  line?: number;
  reason: string;
  nondeterministicSources: string[];
}
```

### 4. MCP Integration

**Current Pattern:**
- MCP handlers in `packages/mcp/src/handlers.ts`
- Already has guarantee handlers (`handleCreateGuarantee`, `handleListGuarantees`, etc.)
- Uses `GraphBackend` interface for all queries

## Is This The RIGHT Approach?

### Alignment with Project Vision

**"AI should query the graph, not read code."**

YES, this is the RIGHT approach because:
1. Currently, issues/warnings exist only in plugin execution output - ephemeral
2. AI agents cannot query "what security issues exist in this codebase?"
3. Adding ISSUE nodes makes problems queryable like any other code entity
4. This enables: "Show me all SQL injection warnings", "Find security issues in payments module"

### Architectural Concerns

**1. Issue Node Ownership Problem**

When do ISSUE nodes get cleared? Options:
- On every analysis run (full refresh)
- Per-file reanalysis (clear issues for that file)
- Never (accumulate forever)

**Recommendation:** Issues should be file-scoped like MODULE nodes. When a file is reanalyzed, its issues are cleared first. This matches the incremental analysis pattern.

**2. Issue ID Strategy**

Issues need stable IDs for:
- Avoiding duplicates on re-run
- Tracking resolution over time
- AI querying specific issues

**Recommendation:** Use namespaced format like `issue:sql-injection#<file>:<line>:<column>` or hash-based like `issue:security#<hash(plugin+file+line+message)>`

**3. Edge Direction**

User request says: `REPORTS_ISSUE // ISSUE -> CODE_NODE`

This is WRONG direction. Should be:
- `CODE_NODE -[HAS_ISSUE]-> ISSUE_NODE` (code has issue)

OR use `AFFECTS` semantics:
- `ISSUE_NODE -[AFFECTS]-> CODE_NODE` (issue affects code)

**Recommendation:** Follow the pattern of GOVERNS edge: `ISSUE -[AFFECTS]-> TARGET_NODE`. This allows querying "what affects this function?" including both guarantees and issues.

**4. Plugin API Design**

Two options:
1. **Implicit:** Plugin returns issues in metadata, orchestrator persists them
2. **Explicit:** Plugin calls `context.createIssue()` directly

**Recommendation:** Explicit is better. It's clearer, allows incremental creation, and matches how nodes/edges are already added via `graph.addNode()`.

## High-Level Implementation Plan

### Phase 1: Schema (types package)

1. Add `ISSUE` to `NODE_TYPE` in `packages/types/src/nodes.ts`
2. Add namespaced types: `issue:security`, `issue:performance`, `issue:style`, `issue:smell`
3. Define `IssueNodeRecord` interface
4. Add `AFFECTS` edge type to `packages/types/src/edges.ts`

### Phase 2: Node Contract (core package)

1. Create `packages/core/src/core/nodes/IssueNode.ts` following `GuaranteeNode` pattern
2. Add `createIssue()` to `NodeFactory`
3. Add `isIssueType()` helper to `NodeKind.ts`
4. Update `packages/core/src/core/nodes/index.ts` exports

### Phase 3: Plugin API (core package)

1. Extend `PluginContext` with issue creation helper:
   ```typescript
   interface PluginContext {
     // ... existing
     reportIssue(issue: IssueSpec): Promise<void>;
   }
   ```
2. Update `packages/types/src/plugins.ts` with issue-related types
3. Create `IssueReporter` utility class

### Phase 4: Migrate Validators

1. Migrate one validator as proof: `SQLInjectionValidator`
2. Replace `issues.push()` with `context.reportIssue()`
3. Ensure backward compatibility (still return issues in metadata)
4. Migrate remaining validators

### Phase 5: Query API

1. Add `getIssues()` to `GraphBackend` interface
2. Implement in RFDB backend
3. Add filtering by severity, category, file, plugin

### Phase 6: MCP Integration

1. Add `find_issues` MCP tool
2. Add `get_issues_for_node` MCP tool
3. Update `get_stats` to include issue counts

### Phase 7: CLI Integration

1. Add `grafema issues` command
2. Update `grafema overview` to show issue summary
3. Show issues in `grafema explore`

## Key Files That Need Changes

1. **`packages/types/src/nodes.ts`** - Add ISSUE type and interface
2. **`packages/types/src/edges.ts`** - Add AFFECTS edge
3. **`packages/types/src/plugins.ts`** - Add issue reporting types
4. **`packages/core/src/core/nodes/IssueNode.ts`** (NEW) - Node contract
5. **`packages/core/src/core/NodeFactory.ts`** - Add createIssue()
6. **`packages/core/src/core/nodes/NodeKind.ts`** - Add issue type helpers
7. **`packages/core/src/plugins/validation/SQLInjectionValidator.ts`** - Migrate first

## Questions That Need Answering Before Proceeding

1. **Issue Lifecycle:** Should issues be automatically cleared on reanalysis, or require explicit deletion?
   - My recommendation: Clear per-file on reanalysis, matching MODULE nodes behavior

2. **Issue Categories:** The user request lists `security | performance | style | smell`. Is this exhaustive or extensible?
   - My recommendation: Use string type, not enum. Allow custom categories via plugins.

3. **MVP Plugin:** User suggests "orphaned code detector". We already have `TypeScriptDeadCodeValidator` and `GraphConnectivityValidator`. Should we migrate one of these instead of building new?
   - My recommendation: Migrate `SQLInjectionValidator` first - it's the most compelling demo (security issues in graph!)

4. **Historical Tracking:** Should we track when issues were first detected / last seen?
   - My recommendation: Add `createdAt`, `lastSeenAt` timestamps for future "issue trends" features

5. **Suppression:** Should we support `// @grafema-ignore` comments to suppress issues?
   - My recommendation: Defer to future. Not needed for MVP.

## Red Flags

**None.** This feature is well-aligned with the project vision. The main risk is scope creep - we should keep Phase 1-4 tight and resist adding features like suppression, historical tracking, or fancy categorization until we have the basics working.

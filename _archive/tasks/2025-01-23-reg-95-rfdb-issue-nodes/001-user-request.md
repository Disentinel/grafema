# User Request: REG-95 RFDB Issue Nodes

## Source
Linear issue: REG-95

## Description
Add ISSUE nodes to RFDB for storing warnings/problems from analysis plugins.

## Problem
Current RFDB model cannot store:
- Warnings (orphaned code, complexity threshold)
- Security issues (SQL injection, XSS)
- Performance problems (N+1 queries, expensive loops)
- Style violations (naming, unused variables)

Plugins can analyze code but have nowhere to store results.

## Acceptance Criteria
- New node type `ISSUE` in RFDB schema
- Edge type `reports_issue` for linking issues to code
- Plugin API for creating issues
- Query API for getting issues by node
- Basic plugin (e.g., orphaned-code detector)

## Proposed Schema

### Issue Node
```typescript
interface IssueNode {
  id: NodeId;
  severity: 'error' | 'warning' | 'info';
  category: 'security' | 'performance' | 'style' | 'smell' | string;
  message: string;           // Human-readable description
  plugin: string;            // Plugin that created this issue
  metadata: Record<string, any>; // Extra context
}
```

### Edge Type
```typescript
EdgeType.REPORTS_ISSUE // ISSUE -> CODE_NODE
```

## Plugin API
```typescript
interface AnalysisPlugin {
  name: string;
  version: string;
  analyze(graph: Graph): Promise<Issue[]>;
}

interface Issue {
  severity: 'error' | 'warning' | 'info';
  category: 'security' | 'performance' | 'style' | 'smell';
  message: string;
  targetNodeId: string;
  metadata?: Record<string, any>;
}
```

## Query API
```typescript
// Get all issues for a node
const issues = await graph.getIssues(nodeId);

// Get issues by severity
const errors = await graph.getIssues({ severity: 'error' });

// Get issues by category
const securityIssues = await graph.getIssues({ category: 'security' });

// Get all issues in project
const allIssues = await graph.getAllIssues();
```

## CLI Integration
- Show issues in `overview`
- New `grafema issues` command
- Show issues in `explore` mode

## Implementation Phases
1. Schema (ISSUE node type, ReportsIssue edge type)
2. API (Plugin interface, issue creation, query API)
3. MVP Plugin (Orphaned code detector)
4. CLI Integration (overview, issues command, explore)

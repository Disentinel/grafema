# User Request: REG-118

## Linear Issue

**REG-118: Critical: Re-analysis duplicates nodes instead of updating them**

## Problem

When running `grafema analyze` twice on the same file, nodes are **duplicated** instead of **updated**.

**Example:**
- First analysis: 6 IMPORT nodes created
- Second analysis (same file, added empty lines): 12 IMPORT nodes (all duplicated)

This defeats the purpose of semantic IDs - the graph becomes polluted with duplicate data.

## Expected Behavior

Re-analyzing a file should:
1. Detect existing nodes with same semantic ID
2. Update their fields (line, column, etc.) if changed
3. NOT create duplicate nodes

## Root Cause Hypotheses (from issue)

1. GraphBuilder._bufferNode() doesn't check for existing IDs
2. RFDBServerBackend doesn't implement upsert logic
3. Orchestrator doesn't clear old nodes before re-analysis
4. IncrementalAnalysisPlugin not handling node updates

## Acceptance Criteria

- [ ] Running `grafema analyze` twice produces identical graph state
- [ ] Same semantic ID = update, not insert
- [ ] Tests verify no duplication on re-analysis

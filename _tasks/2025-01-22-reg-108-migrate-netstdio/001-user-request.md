# User Request: REG-108

## Linear Issue

**REG-108**: NodeFactory: Migrate net:stdio to use ExternalStdioNode

## Task

Use existing `NodeFactory.createExternalStdio()` for net:stdio node creation.

## Current State

net:stdio nodes created inline in:

* `GraphBuilder.ts:383` - console.log/error handling

## Changes Required

1. Update `GraphBuilder.bufferStdioNodes()` to use `NodeFactory.createExternalStdio()`

Note: `ExternalStdioNode` already exists in the codebase.

## Acceptance Criteria

- [ ] GraphBuilder uses NodeFactory.createExternalStdio()
- [ ] No inline net:stdio object literals
- [ ] Tests pass

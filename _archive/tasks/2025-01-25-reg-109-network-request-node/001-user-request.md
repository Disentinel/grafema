# User Request

**Linear Issue:** REG-109
**Title:** NodeFactory: Add NetworkRequestNode and migrate net:request creation

## Task

Add factory method for `net:request` singleton node creation.

## Current State

`net:request` nodes created inline in:
- `GraphBuilder.ts:661` - network request handling

## Changes Required

1. Add `NodeFactory.createNetworkRequest()` or use `HttpRequestNode`
2. Update `GraphBuilder.bufferHttpRequests()`

## Acceptance Criteria

- [ ] NodeFactory method exists for net:request
- [ ] No inline net:request object literals
- [ ] Tests pass

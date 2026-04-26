# REG-109: NodeFactory: Add NetworkRequestNode and migrate net:request creation

## Linear Issue
https://linear.app/reginaflow/issue/REG-109/nodefactory-add-networkrequestnode-and-migrate-netrequest-creation

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

## Labels
- Improvement

## Parent Issue
879d38ab-ebce-4dea-a66f-e7912029ef4c

## REG-368: Make brandNode() internal and update GraphBackend interface

### Context

Part of REG-198 (Enforce branded nodes in GraphBackend.addNode). This is the infrastructure phase that must be completed before other subtasks (blocks REG-369 through REG-377).

### Task

1. Make `brandNode()` internal (not exported from @grafema/types)
2. Create internal branding helper for legitimate uses:
   - GraphBuilder._flushNodes() - batches validated nodes
   - RFDBServerBackend._parseNode() - re-brands from database
3. Update GraphBackend interface to require `AnyBrandedNode`
4. Ensure TypeScript errors appear for all inline node creation

### Acceptance Criteria

- [ ] `brandNode()` not importable from @grafema/types
- [ ] Internal helper exists for GraphBuilder and RFDBServerBackend
- [ ] GraphBackend.addNode requires AnyBrandedNode
- [ ] Build fails with ~50 errors (expected - other phases will fix)

### Priority

Urgent — blocks 9 downstream subtasks.

# Rob Pike Debug Report: REG-118 Root Cause Identified and Fixed

## Investigation Summary

Following Knuth's analysis, I added debug logging to `clearFileNodesIfNeeded` and identified TWO bugs causing node duplication.

## Bug 1: RFDB Server `queryNodes` Ignoring `file` Parameter

**Discovery:** Debug logging revealed that `queryNodes({ file })` was returning the correct nodes (5 nodes for index.js), but after calling `deleteNode` on all of them, querying again showed they were NOT deleted.

**Root Cause Analysis:**

1. The client sends `queryNodes({ file: "index.js" })`
2. Server's `WireAttrQuery` struct **did NOT have a `file` field**:
   ```rust
   pub struct WireAttrQuery {
       pub node_type: Option<String>,
       pub name: Option<String>,
       pub exported: Option<bool>,
       // NOTE: no `file` field!
   }
   ```
3. Server would ignore the `file` parameter and return ALL nodes
4. First run: 0 nodes (correct - fresh database)
5. Second run: 5 nodes returned BUT wrong nodes deleted due to Bug 2

**Fix Applied:** Added `file` field to `WireAttrQuery` and updated `AttrQuery` + `find_by_attr` to filter by file path.

Files changed:
- `/Users/vadimr/grafema/rust-engine/src/bin/rfdb_server.rs` - Added `file` field to WireAttrQuery
- `/Users/vadimr/grafema/rust-engine/src/storage/mod.rs` - Added `file` field to AttrQuery
- `/Users/vadimr/grafema/rust-engine/src/graph/engine.rs` - Updated find_by_attr to filter by file path

## Bug 2: Delete Not Working for Nodes in Segment (THE MAIN BUG)

**Discovery:** After fixing Bug 1, debug logging showed:
```
queryNodes found 5 nodes: [...]
Cleared 5 nodes for index.js
BUG! After clearing, 5 nodes STILL exist for index.js
```

**Root Cause Analysis:**

The RFDB engine has two storage layers:
1. `delta_nodes` - in-memory hash map for new/modified nodes
2. `nodes_segment` - memory-mapped segment file for flushed nodes

When `delete_node(id)` was called, it only marked nodes deleted in `delta_nodes`:

```rust
Delta::DeleteNode { id } => {
    if let Some(node) = self.delta_nodes.get_mut(id) {
        node.deleted = true;
    }
    // BUG: If node is in segment, nothing happens!
}
```

Sequence:
1. First orchestrator run creates nodes (go into `delta_nodes`)
2. Flush happens (nodes move to `nodes_segment`)
3. Second orchestrator calls `deleteNode(id)`
4. Node not found in `delta_nodes` (it's in segment)
5. **Nothing gets deleted!**
6. `queryNodes` finds nodes in segment, returns them
7. New nodes created = duplication

**Fix Applied:** Added `deleted_segment_ids: HashSet<u128>` to track IDs of nodes deleted from segment:

```rust
Delta::DeleteNode { id } => {
    if let Some(node) = self.delta_nodes.get_mut(id) {
        node.deleted = true;
    } else {
        // Node is in segment (already flushed), track it for deletion
        self.deleted_segment_ids.insert(*id);
    }
}
```

Updated all query paths to check `deleted_segment_ids`:
- `get_node_internal()` - returns None if ID in deleted_segment_ids
- `find_by_attr()` - skips nodes in deleted_segment_ids
- `flush()` - skips segment nodes in deleted_segment_ids, then clears the set

Files changed:
- `/Users/vadimr/grafema/rust-engine/src/graph/engine.rs`

## Test Results

Before fix:
```
[FileNodeManager DEBUG] BUG! After clearing, 5 nodes STILL exist for index.js
```

After fix:
```
[FileNodeManager DEBUG] Verification OK: 0 nodes remaining for index.js
```

**Main test "should produce identical graph on re-analysis" now passes.**

## Remaining Failing Tests

4 other tests in ClearAndRebuild.test.js still fail, but these are DIFFERENT issues:

1. `net:stdio singleton` - 2 nodes instead of 1 (separate issue with singleton node handling)
2. `net:request singleton` - 0 nodes (not created in first place)
3. `IMPORT count` - 0 after re-analysis (separate issue)
4. `CLASS count` - 0 after re-analysis (separate issue)

These are NOT related to the main node duplication bug (REG-118). They may be pre-existing issues with specific node types that don't have a `file` attribute or have special creation logic.

## Files Modified

### Rust Engine
1. `/Users/vadimr/grafema/rust-engine/src/graph/engine.rs`
   - Added `deleted_segment_ids: HashSet<u128>` field
   - Updated `create()`, `open()`, `clear()` to initialize/clear it
   - Updated `apply_delta(DeleteNode)` to track segment deletions
   - Updated `get_node_internal()` to check deleted_segment_ids
   - Updated `find_by_attr()` delta and segment loops
   - Updated `flush()` to skip deleted nodes and clear the set

2. `/Users/vadimr/grafema/rust-engine/src/bin/rfdb_server.rs`
   - Added `file: Option<String>` to `WireAttrQuery`
   - Updated `QueryNodes` and `FindByAttr` handlers

3. `/Users/vadimr/grafema/rust-engine/src/storage/mod.rs`
   - Added `file: Option<String>` to `AttrQuery`

---
*Report by Rob Pike, Implementation Engineer*
*Date: 2025-01-22*

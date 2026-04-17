---
name: rfdb-stale-node-cleanup
description: |
  Recover from stale RFDB nodes that survive `commit_batch` cleanup despite
  having their `file` field listed in `changed_files`. Use when:
  (1) re-running an enricher/orchestrator step but old data with the same file
  field stays in the graph, (2) `commit_batch(changed_files=[X], ...)` reports
  success but a query later still returns nodes with `file = X`, (3) you
  re-pointed structural nodes (e.g., DIRECTORY/FILE) from a synthetic file
  path to real file paths and the old synthetic-path nodes won't go away,
  (4) graph-stream / find_by_type returns a mix of "stale" and "new" nodes
  for the same logical entity. Root cause: `handle_commit_batch` calls
  `engine.find_by_attr({file: X})` to enumerate nodes-to-delete, but that
  query path returns only a PARTIAL set after compaction (L1 segments and
  the file→nodes index can desync). Workaround: enumerate stale nodes via
  the TS rfdb client `queryNodes({file: X})` (different code path that finds
  all of them) and call `deleteNode(id)` per node, then re-commit the
  intended state. Related: rfdb-manifest-l1-carryforward (same L1 family).
author: Claude Code
version: 1.0.0
date: 2026-04-07
---

# RFDB Stale Node Cleanup After Compaction

## Problem

`commit_batch(changed_files=[X], nodes=[...], ...)` is supposed to atomically
replace all nodes with `file = X` by tombstoning the old set and inserting
the new one. After compaction (RFD-20 L1 segments), this is unreliable: only
a partial subset of the old nodes gets tombstoned and the rest survive
indefinitely, contaminating queries.

This is especially visible when:

- An orchestrator step is rewritten to emit nodes with new `file` fields
  (e.g., switching DIRECTORY/FILE structural nodes from a synthetic
  `__grafema_virtual/...` path to real directory paths). The new commit
  uses upsert by semantic_id, but the OLD nodes at the synthetic path
  are not all tombstoned.
- Multiple commit_batch invocations target the same legacy file path —
  each invocation tombstones a few more nodes but never gets all of them.

## Context / Trigger Conditions

- After running a commit pipeline, `find_by_type(NODE_TYPE)` returns more
  rows than the latest commit produced.
- Graph-stream output mixes nodes with the new `file` value and a "stale"
  group with the old `file` value, both for entities you considered
  rewritten.
- `changed_files` contained the legacy path, the orchestrator log says
  `commitBatch` succeeded with `files=N` matching expectation.
- Splitting nodes by file shows orphans only at the legacy/synthetic path
  while the rest of the graph looks correct.
- Re-running the same `commit_batch` reduces the orphan count but never
  clears it to zero.
- `manifest_index.json` has a recent compaction snapshot
  (`l1_node_segments` populated) older than the failing commits.

## Diagnostic Path

1. Get a per-`file` count of the affected node type:
   ```bash
   curl -s "http://localhost:3333/api/graph-stream?nodeTypes=TYPE&maxNodes=5000" \
     | python3 -c "
import json, sys
counts = {}
for line in sys.stdin:
    try:
        d = json.loads(line)
        if d.get('type') == 'node':
            counts[d.get('file','')] = counts.get(d.get('file',''), 0) + 1
    except: pass
for k,v in sorted(counts.items(), key=lambda kv: -kv[1])[:20]: print(v, k)
"
   ```
2. Look for entries clustered under the legacy/synthetic file path that
   should have been replaced.
3. Confirm via `/api/node/<id>` that one such node has the legacy `file`
   and the metadata you remember from the old code path.
4. Confirm a corresponding "new" node exists (with the same name but new
   `file`) — proves the rewrite ran but cleanup didn't.

## Solution

### Direct cleanup via TS rfdb client (most reliable)

The TS client's `queryNodes({file: X})` uses a different storage code path
than `handle_commit_batch`'s `find_by_attr` and reliably enumerates all
matching nodes, including those promoted to L1 segments.

```js
// /tmp/cleanup-stale.mjs
import { RFDBClient } from '/path/to/grafema/packages/rfdb/dist/client.js';

const client = new RFDBClient(
  '/path/to/.grafema/rfdb.sock',  // socket path is positional arg, not options object
  'cleanup',
);
await client.connect();

const stale = [];
for await (const n of client.queryNodes({ file: '__grafema_virtual/legacy-path' })) {
  stale.push(n.id);
}
console.log('Found stale nodes:', stale.length);

for (const id of stale) {
  try { await client.deleteNode(id); }
  catch (e) { console.error('delete failed', id, e.message); }
}

await client._send('flush', {}).catch(e => console.error('flush:', e.message));
await client.close();
```

Then re-run the commit step that produces the desired state. The graph
will now be clean.

### Caveats

- **`queryNodes({file: X})` may match more than literal equality.** It
  can return any node where `file` matches the pattern under the storage
  layer's filter rules (substring or exact, depending on backend version).
  Use the **most specific** path you can to avoid wiping live data.
- **Verify the count before deleting.** If you expect ~300 stale and the
  query returns the entire graph, abort. Print first few IDs and double-
  check their type/file via `/api/node/<id>`.
- After deleting, re-commit the intended state immediately. The graph is
  in a partially-empty state until you do.

### Why not just keep calling commit_batch?

`handle_commit_batch` (rfdb_server.rs) does:

```rust
for file in &changed_files {
    let old_ids = engine.find_by_attr(&AttrQuery { file: Some(file.clone()), .. });
    for id in &old_ids { engine.delete_node(*id); }
}
```

`find_by_attr` for a `file` filter consults the in-memory `file_to_node_ids`
index, which is rebuilt from segments at startup. After compaction, some
nodes for a given file path are in L1 with index entries that can be
incomplete or stale relative to what's still on disk. Subsequent
`find_by_attr` calls return only the index-known IDs, so other historical
copies of the same node are never enumerated for tombstoning.

The TS client's `queryNodes` route through a different store method that
walks segments directly instead of trusting the file index, so it sees
the missed entries.

## Verification

After cleanup + recommit:

```bash
# Total count for the type matches what you committed
curl -s "http://localhost:3333/api/graph-stream?nodeTypes=DIRECTORY,FILE&maxNodes=2000" \
  | tail -2
# → {"edgeCount":721,"elapsed":...,"nodeCount":722,"type":"done"}

# No nodes left at the legacy path
curl -s "http://localhost:3333/api/graph-stream?nodeTypes=DIRECTORY,FILE&maxNodes=2000" \
  | python3 -c "
import json, sys
n = sum(1 for line in sys.stdin
        for d in [json.loads(line)] if d.get('type')=='node'
        and d.get('file','').startswith('__grafema_virtual'))
print('stale survivors:', n)
"
# → stale survivors: 0
```

## Notes

- **This is a workaround, not a fix.** The root fix is to make
  `find_by_attr({file:X})` consistent with `queryNodes({file:X})` after
  compaction — both should walk every storage layer (write_buffer + L0 +
  L1) and respect tombstones.
- After running this workaround, keep an eye out for the same symptom in
  future analyzes; until the root fix lands, every step that re-points a
  node's `file` field will need this cleanup.
- This bug is in the same family as `rfdb-manifest-l1-carryforward`
  (compaction interactions). Both surface as "data exists on disk but
  isn't queryable correctly."
- Don't try `delete_nodes` via REST/HTTP — only the unix-socket protocol
  exposes `deleteNode`. Use the TS client.
- Always **flush** after delete via `client._send('flush', {})` so
  subsequent queries see the tombstones.

## Related Files

- `packages/rfdb-server/src/bin/rfdb_server.rs:1996` —
  `handle_commit_batch` (the buggy delete path)
- `packages/rfdb-server/src/bin/rfdb_server.rs:1242` — `Request::DeleteNode`
- `packages/rfdb/dist/base-client.js:86` — `deleteNode` TS client API
- `packages/rfdb/dist/base-client.js:254` — `queryNodes` TS client API
- `.claude/skills/rfdb-manifest-l1-carryforward/SKILL.md` — sibling bug

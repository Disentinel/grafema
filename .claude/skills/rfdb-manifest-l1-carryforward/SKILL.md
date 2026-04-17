---
name: rfdb-manifest-l1-carryforward
description: |
  Diagnose and fix RFDB data disappearing after compaction, where rfdb-server
  reports a tiny node count (e.g. "15 nodes") on startup despite manifest_index.json
  showing hundreds of thousands of nodes and segment files existing on disk.
  Use when: (1) rfdb-server logs "Default database: N nodes" with N orders of
  magnitude smaller than recent analysis output, (2) /api/stats returns only the
  most recent commit's nodes, (3) the issue appears AFTER a compaction event
  (manifest with l1_node_segments populated and node_segments: []), (4) subsequent
  commits dropped L1 references. Root cause: ManifestStore::create_manifest()
  initializes l1_node_segments/l1_edge_segments to Vec::new() instead of cloning
  from current manifest, so any commit AFTER compaction silently orphans all L1
  data even though segment .seg files still exist on disk. Compaction injects L1
  fields explicitly after create_manifest, but regular commits do not.
author: Claude Code
version: 1.0.0
date: 2026-04-07
---

# RFDB Manifest L1 Carry-Forward Bug

## Problem

After a successful `grafema analyze` of a large project, restarting rfdb-server
shows almost no data — `"Default database: 15 nodes, 0 edges"` — even though:

- Analysis logs show `Nodes: 326649, Edges: 648284`
- `manifest_index.json` shows snapshots with `total_nodes: 326000+`
- Segment files exist on disk (`segments/00/seg_*.seg`, hundreds of MB)
- The most recent manifest's `parent_version` chain has all the data

The data is on disk, but rfdb-server can't see it.

## Context / Trigger Conditions

- `rfdb-server` reports a node count that matches only the LAST commit (often
  a small METRIC commit at the end of analyze)
- `/api/stats` HTTP endpoint returns only types from the latest delta
- `cat .grafema/graph.rfdb/current.json` → high version number (e.g. 98)
- `cat manifests/000098.json` shows `node_segments` with just 1-2 small segments
- One of the recent manifests (e.g. 097) has `l1_node_segments` populated and
  `node_segments: []` (this is the compaction snapshot)
- The newest manifest does NOT have `l1_node_segments`
- Segment `.seg` files referenced by L1 segments still exist on disk

## Root Cause

`ManifestStore::create_manifest()` in
`packages/rfdb-server/src/storage_v2/manifest.rs` builds a new manifest by
copying parent_version but resetting L1 segments:

```rust
Ok(Manifest {
    // ...
    l1_node_segments: Vec::new(),  // ← drops L1 reference!
    l1_edge_segments: Vec::new(),
    last_compaction: None,
})
```

Compaction (`MultiShardStore::compact_with_threads`) calls `create_manifest`
and then explicitly overwrites:

```rust
manifest.l1_node_segments = l1_node_descs;
manifest.l1_edge_segments = l1_edge_descs;
```

But any **regular** commit after compaction (e.g. orchestrator's final METRIC
commit) calls `create_manifest` without overriding L1 fields → the new manifest
has zero L1 references → on next open, `MultiShardStore::open()` reads
`current.l1_node_segments` (empty) and loads only the tiny new delta.

## Solution

### 1. Fix the bug (carry-forward by default)

In `packages/rfdb-server/src/storage_v2/manifest.rs`, modify `create_manifest`
to inherit L1 segments from `self.current`:

```rust
let l1_node_segments = self.current.l1_node_segments.clone();
let l1_edge_segments = self.current.l1_edge_segments.clone();

Ok(Manifest {
    // ...
    l1_node_segments,
    l1_edge_segments,
    last_compaction: None,
})
```

Compaction code stays unchanged — it overrides these fields explicitly after
calling `create_manifest`, which is the correct behavior for replacing L1.

### 2. Recover the broken database (without re-running analysis)

If you don't want to re-analyze (a large project takes 10+ minutes),
hot-patch the latest manifest by copying L1 fields from the parent that has
them. Find the most recent compaction manifest by walking parent_version
chain and grepping for `l1_node_segments`.

Example Python recovery script:

```python
import json, os, tempfile

DB = '/path/to/.grafema/graph.rfdb'
LATEST = 98       # version_to_patch
PARENT = 97       # version with l1_node_segments populated

m_parent = json.load(open(f'{DB}/manifests/{PARENT:06d}.json'))
m_latest = json.load(open(f'{DB}/manifests/{LATEST:06d}.json'))

m_latest['l1_node_segments'] = m_parent['l1_node_segments']
m_latest['l1_edge_segments'] = m_parent['l1_edge_segments']

# Atomic write
path = f'{DB}/manifests/{LATEST:06d}.json'
fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path))
os.write(fd, json.dumps(m_latest, indent=2).encode())
os.close(fd)
os.rename(tmp, path)
```

Then restart rfdb-server. It should report the full node count.

## Verification

After applying the fix:

```bash
# Restart rfdb-server
/path/to/rfdb-server <db_path> --socket <sock> --http-port 3333 \
  > /tmp/rfdb.log 2>&1 &

# Check log: should show full node count
grep "Default database" /tmp/rfdb.log
# → [rfdb-server] Default database: 326649 nodes, 648284 edges

# Confirm via HTTP
curl -s http://localhost:3333/api/stats | head
# → {"edgeCount":648284,"nodeCount":326649,"nodesByType":{...}}
```

For the source-level fix, also add a regression test in
`storage_v2/manifest.rs` that:
1. Creates a manifest with L1 segments via compaction
2. Calls `create_manifest` again (regular commit)
3. Asserts the new manifest still has the L1 segments populated

## Diagnostic Path

When you see "rfdb-server reports tiny node count":

1. **Check disk has data:**
   ```bash
   du -sh .grafema/graph.rfdb/segments/*
   # Should show hundreds of MB if analysis ran
   ```

2. **Check manifest_index.json snapshot history:**
   ```bash
   python3 -c "import json; d=json.load(open('.grafema/graph.rfdb/manifest_index.json')); \
     [print(s['version'], s['stats']['total_nodes']) for s in d['snapshots'][-5:]]"
   ```
   If recent snapshots show large `total_nodes` but rfdb-server reports few,
   the loading is broken.

3. **Read latest manifest, look at `node_segments`, `l1_node_segments`,
   `parent_version`:**
   ```bash
   cat .grafema/graph.rfdb/manifests/000098.json | python3 -m json.tool
   ```
   If `node_segments` is small/empty and `l1_node_segments` is missing or
   empty — that's the bug.

4. **Walk parent_version chain to find the compaction snapshot** (the one
   with non-empty `l1_node_segments`):
   ```bash
   for v in 098 097 096 095; do
     echo "v$v:"
     python3 -c "import json; m=json.load(open('.grafema/graph.rfdb/manifests/000${v}.json')); \
       print('  l1_nodes:', len(m.get('l1_node_segments', []))); \
       print('  l1_edges:', len(m.get('l1_edge_segments', [])))"
   done
   ```

## Notes

- This is a write-time bug, not a read-time bug. The recovery patch fixes
  read-only access, but if you commit again WITHOUT the source fix,
  data will be lost AGAIN on the next regular commit after compaction.
- Always rebuild rfdb-server with the fix BEFORE running any new commit
  on a recovered database.
- Compaction tests do not catch this because they only verify the
  immediate post-compaction manifest, not subsequent commits.
- Related but distinct from `rfdb-v2-clear-ephemeral-trap`: that bug is
  about `--clear` flag making the engine ephemeral; this one is about
  manifest field initialization losing references after compaction.
- The orchestrator's final phase emits METRIC nodes via a regular
  `commit_batch`, which is the most common trigger for this bug because
  it always runs after analysis (which usually triggers compaction).

## Related Files

- `packages/rfdb-server/src/storage_v2/manifest.rs:797` — `create_manifest`
- `packages/rfdb-server/src/storage_v2/multi_shard.rs:168` — `MultiShardStore::open`
- `packages/rfdb-server/src/storage_v2/multi_shard.rs:1597` — compaction's
  manifest construction (override pattern)

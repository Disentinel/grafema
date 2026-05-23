---
name: backup-before-mass-updates
description: |
  Prevent data loss during mass writes, database operations, or destructive
  recovery actions. Use when: (1) about to write >100 records to any database,
  (2) about to rm/delete a data directory to "fix" a loading error,
  (3) about to restart a server that holds unflushed data,
  (4) about to run a migration or bulk ingest script,
  (5) RFDB "already exists" + "not found" race on database open.
  Root cause: 2026-05-23 incident where rm -rf on knowledge.rfdb lost
  120+ entities of ontological crawl data.
---

# Backup Before Mass Updates

## The Incident

2026-05-23: Git history ingest sent 5000+ edges in one batch to RFDB.
Server timed out. On restart, knowledge DB existed on disk but wouldn't
load ("already exists" on create, "not found" on open — RFDB only
auto-loads default DB). Instead of debugging the load, deleted the
directory to "unblock." Lost 120 ENTITY + 97 FACT nodes from ontological
crawl. Partial recovery from /tmp/ JSONL files and subagent output
transcripts.

## Rules

### Rule 1: Backup before destructive action

Before ANY of these, create a backup:
- `rm -rf` on a data directory
- `client.clear()` on a database
- Overwriting a database file
- Restarting a server that may have unflushed writes

Backup means: `cp -r dir dir.bak.$(date +%s)` or JSONL export.

### Rule 2: Cap batch sizes

Never send >100 records per batch to RFDB. The server processes
synchronously — a 5000-edge batch blocks for minutes and can OOM.

```javascript
const BATCH_SIZE = 50; // safe default
for (let i = 0; i < items.length; i += BATCH_SIZE) {
  await client.addEdges(items.slice(i, i + BATCH_SIZE), true);
}
```

### Rule 3: JSONL write-ahead log

All knowledge writes go to append-only JSONL FIRST, RFDB second.
File: `.grafema/crawl-findings.jsonl`
If RFDB crashes, replay from JSONL.

### Rule 4: Debug "already exists" + "not found"

This specific error pattern means: database files exist on disk but
server didn't load them on startup. RFDB only auto-loads `default` DB.

Fix: NOT `rm -rf`. Instead:
```
// The database exists on disk but isn't loaded in memory.
// openDatabase will load it from disk — just call it.
await client.openDatabase('knowledge', 'rw');
```

If openDatabase fails with "not found" despite files on disk:
1. Check if rfdb-server restarted (PID changed)
2. Check if another process holds LOCK file
3. Check db_config.json is valid
4. Last resort: `cp -r knowledge.rfdb knowledge.rfdb.bak && rm -rf knowledge.rfdb`

### Rule 5: Verify state before and after

Before mass operation: `client.getStats()` → record node/edge count.
After mass operation: `client.getStats()` → compare.
If counts dropped unexpectedly → stop, investigate.

## Recovery Sources (in priority order)

1. `.grafema/crawl-findings.jsonl` — JSONL write-ahead log
2. `/tmp/crawl-*.jsonl` — individual crawl session outputs
3. Subagent output files in `/private/tmp/claude-*/tasks/*.output` — contain full MCP tool call history, parseable
4. Git history — commits are always recoverable
5. Enox merged JSONL — `~/grafema-cloud/enox/merged/` — academic data re-migratable
6. This conversation context — manual replay of assertions

## Checklist (pre-flight for mass operations)

- [ ] Current stats recorded: `getStats()` → nodes/edges count
- [ ] JSONL backup exists or will be created
- [ ] Batch size ≤ 100
- [ ] No `rm -rf` without `.bak` copy first
- [ ] Recovery plan documented (which source to replay from)

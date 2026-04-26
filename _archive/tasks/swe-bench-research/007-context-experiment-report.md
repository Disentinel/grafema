# 007 — Grafema Context Experiment Report (preact-3345)

**Date:** 2026-02-11
**Task:** preactjs__preact-3345 (effect cleanup error handling)
**Model:** Sonnet 4.5
**Grafema version:** 0.2.5-beta (REG-400 + REG-406)

## Experiment Goal

Test whether `grafema context` command (REG-406) helps agent understand code
better by showing source code + semantic relationships in one command.

## Critical Finding: Pre-built Graphs Break in Docker

**Problem:** Grafema stores absolute host paths in `node.file`. When graph is
copied from host to Docker container, `getCodePreview()` can't find files →
`grafema context` shows NO source code.

**Impact:** All previous "grafema context" experiments were invalid — agent got
the same info as `grafema query`.

**Evidence:**
- Host path stored: `/Users/vadimr/swe-bench-research/preact-testbed/hooks/src/index.js`
- Docker path needed: `/testbed/hooks/src/index.js`
- `formatLocation()` shows: `../Users/vadimr/swe-bench-research/preact-testbed/hooks/src/index.js`
- `getCodePreview()` returns null (file doesn't exist at stored path)

**Solution:** Build graph inside Docker via `docker commit`:
1. Start SWE-bench container
2. Install grafema + rfdb-server
3. Run `grafema analyze` (graph built with Docker paths)
4. `docker commit` → new image with pre-built graph
5. Use new image for experiments (instant startup, correct paths)

**Root cause in code:** `JSModuleIndexer.ts:376` deliberately stores absolute path:
```typescript
file: currentFile, // Keep absolute path for file reading in analyzers
```

**Should file as product issue:** Portable graphs require relative paths.

## Run Results

### Run 1: Broken paths (no source code in context)
- `grafema context` output: edge list only, NO code snippets
- Agent saw same info as `grafema query`
- Used 3 grafema commands, then 28 cat/sed reads
- **Result: FAIL** (only fixed invokeCleanup, missed unmount handler)

### Run 2: Startup failed (rfdb-server not found by --auto-start)
- `grafema analyze --auto-start` → "RFDB server binary not found"
- Agent re-ran analyze itself, never used `context`
- **Result: FAIL**

### Run 3: Docker commit approach (WORKING context)
- `grafema context` shows full source + call sites with code
- Agent used 3 grafema commands (overview, query, context)
- On step 3: context showed invokeCleanup source + all 4 callers with code
- Agent identified the bug on step 4 (immediately after context)
- Still used 8 cat + 14 grep for verification/editing
- **Result: FAIL** (same fix strategy — only invokeCleanup, not unmount)

## Comparison Table

| Metric | v5 (query only) | v6 (working context) | Delta |
|--------|-----------------|---------------------|-------|
| Grafema cmds | 4 (query) | 3 (overview+query+context) | -1 |
| cat/sed reads | 21 | 18 | -14% |
| grep | 11 | 14 | +27% |
| Total steps | 48 | 50 | +4% |
| Result | FAIL | FAIL | same |
| Time to understanding | Step 13 | Step 4 | **3x faster** |

## Key Observation: Context Speeds Up Understanding, Not Resolution

**Context command helped:**
- Agent understood the bug on step 4 (vs step 13+ in v5)
- Saw all 4 call sites and try-catch wrappers immediately
- Correctly identified forEach + exception = remaining items skipped

**Context command didn't help with:**
- Fix strategy — agent chose "catch inside invokeCleanup" in both runs
- Gold patch requires changes to unmount handler (per-item try/catch in forEach)
- Agent doesn't see that catching inside invokeCleanup prevents proper error reporting

**Root cause of wrong fix:** The agent sees the problem pattern but chooses the
"simpler" fix (add try/catch inside the function) instead of the "correct" fix
(change how forEach handles errors at each call site). This is a model reasoning
issue, not a navigation issue.

## Graph Quality Improvements (REG-400)

| Metric | Old (pre-REG-400) | New | Change |
|--------|-------------------|-----|--------|
| Nodes | 3799 | 3814 | +0.4% |
| Edges (host) | 5190 | 19421 | +3.7x |
| Edges (Docker) | - | 12718 | (new baseline) |
| invokeCleanup callers | 0 | 4 | Fixed! |

Note: host vs Docker edge counts differ because host built includes some
duplicate edges from parallel analysis (to be investigated).

## Infrastructure Notes

### Docker commit workflow (recommended for SWE-bench)
```bash
# 1. Start container from SWE-bench image
docker run -d --name grafema-prebuild -w /testbed \
  -v .../grafema-install/node_modules:/opt/grafema/node_modules:ro \
  -v .../preact-testbed/.grafema/config.yaml:/tmp/grafema-config.yaml:ro \
  -v .../grafema-install/rfdb-server-linux:/opt/rfdb-server:ro \
  swebench/sweb.eval.x86_64.preactjs_1776_preact-3345:latest sleep 1h

# 2. Build graph inside container
docker exec grafema-prebuild bash -c '
  ln -sf /opt/grafema/node_modules/.bin/grafema /usr/local/bin/grafema &&
  cp /opt/rfdb-server /usr/local/bin/rfdb-server && chmod +x /usr/local/bin/rfdb-server &&
  mkdir -p /testbed/.grafema && cp /tmp/grafema-config.yaml /testbed/.grafema/config.yaml &&
  setsid rfdb-server /testbed/.grafema/graph.rfdb --socket /testbed/.grafema/rfdb.sock &
  sleep 2 && cd /testbed && grafema analyze
'

# 3. Stop server, commit image
docker exec grafema-prebuild pkill rfdb-server
docker commit grafema-prebuild swebench/preact-3345-grafema:latest

# 4. Tag for mini-SWE-agent (backup original)
docker tag swebench/sweb.eval.x86_64.preactjs_1776_preact-3345:latest :original
docker tag swebench/preact-3345-grafema:latest swebench/sweb.eval.x86_64.preactjs_1776_preact-3345:latest

# 5. Minimal startup (no analyze, just start server)
env_startup_command: |
  setsid rfdb-server /testbed/.grafema/graph.rfdb --socket /testbed/.grafema/rfdb.sock & sleep 2
```

### Startup issues encountered
- `--auto-start` doesn't find manually installed rfdb-server binary
- Must start rfdb-server manually before `grafema analyze`
- `grafema analyze` in startup can hang (use docker commit instead)

## Product Issues Filed

1. **REG-408** — Portable graphs: store relative paths for Docker/CI compatibility (High)
2. **REG-409** — Duplicate edges in context output (Medium)
3. **REG-410** — `--auto-start` should check PATH for rfdb-server binary (Low)

## Next Steps

1. Try different preact tasks (maybe simpler ones where context helps more)
2. Consider whether prompting can guide agent to "fix the caller, not the callee" strategy
3. Scale to all 17 preact tasks once infrastructure is stable

---
name: swe-bench-grafema-experiments
description: |
  Full runbook for A/B testing Grafema on SWE-bench Multilingual benchmark.
  Use when: (1) running SWE-bench experiments with/without Grafema, (2) setting up
  grafema-install for Docker containers, (3) preparing pre-built graph for a new repo,
  (4) evaluating results, (5) debugging Docker startup failures. Covers: mini-SWE-agent
  config, Docker volume mounting, rfdb-server setup, pnpm pack workflow, Node version
  compatibility, graph pre-building, and result evaluation.
author: Claude Code
version: 2.0.0
date: 2026-02-10
---

# SWE-bench Grafema A/B Experiments

## Overview

Measure whether graph context (Grafema) helps AI agents solve SWE-bench tasks better.
Two conditions per task: baseline (no Grafema) vs experimental (with Grafema).

## Infrastructure

| Component | Version | Location |
|-----------|---------|----------|
| mini-SWE-agent | 2.0.0a3 | `/Users/vadimr/swe-bench-research/mini-swe-agent/` |
| swebench | 4.1.0 | installed in mini-swe-agent venv |
| Python | 3.12 (brew) | venv: `mini-swe-agent/.venv/` |
| API key | `.env` | `~/Library/Application Support/mini-swe-agent/.env` |
| Grafema install | npm flat | `/Users/vadimr/swe-bench-research/grafema-install/` |

### Directory Structure

```
/Users/vadimr/swe-bench-research/
├── mini-swe-agent/             # Agent framework + venv
├── config/
│   ├── swebench-research.yaml  # Budget: step_limit=75, cost_limit=$3
│   └── sonnet-grafema.yaml     # Grafema condition config
├── grafema-install/
│   ├── node_modules/           # Flat npm install (NO symlinks!)
│   ├── rfdb-server-linux       # Linux binary for rfdb
│   └── package.json            # From pnpm pack tarballs
├── <repo>-testbed/
│   └── .grafema/               # Pre-built graph for repo
│       ├── config.yaml         # Services, plugins config
│       └── graph.rfdb          # The graph database
└── results/
    ├── <run-name>/
    │   ├── preds.json          # Predictions (dict format)
    │   ├── preds.jsonl         # Converted for swebench eval
    │   ├── minisweagent.log    # Agent log (Rich.Live captures stdout!)
    │   └── <instance_id>/
    │       └── <instance_id>.traj.json  # Trajectory
    └── ...
```

## Step 1: Build grafema-install (ONCE, rebuild after Grafema changes)

**CRITICAL**: This must produce a flat node_modules with NO symlinks. Symlinks break
inside Docker containers.

```bash
# 1. Build Grafema from main
cd /Users/vadimr/grafema
pnpm build

# 2. Pack all packages (pnpm pack resolves workspace:* protocol)
mkdir -p /tmp/grafema-packs
for pkg in types rfdb-client core rfdb cli api; do
  pnpm -C "packages/$pkg" pack --pack-destination /tmp/grafema-packs
done

# 3. Create package.json with container paths (for Docker install)
cd /Users/vadimr/swe-bench-research/grafema-install
cat > package.json << 'EOF'
{
  "name": "grafema-install",
  "private": true,
  "type": "module",
  "dependencies": {
    "@grafema/cli": "file:/packs/grafema-cli-0.2.5-beta.tgz",
    "@grafema/core": "file:/packs/grafema-core-0.2.5-beta.tgz",
    "@grafema/types": "file:/packs/grafema-types-0.2.5-beta.tgz",
    "@grafema/rfdb-client": "file:/packs/grafema-rfdb-client-0.2.5-beta.tgz",
    "@grafema/api": "file:/packs/grafema-api-0.2.5-beta.tgz"
  }
}
EOF

# 4. Install inside Node 20 Docker (matching SWE-bench container Node versions)
rm -rf node_modules package-lock.json
docker run --rm \
  -v /tmp/grafema-packs:/packs:ro \
  -v $(pwd):/install \
  node:20 bash -c 'cd /install && npm install'

# 5. Copy rfdb-server Linux binary
cp /Users/vadimr/grafema/packages/rfdb-server/prebuilt/linux-x64/rfdb-server \
   /Users/vadimr/swe-bench-research/grafema-install/rfdb-server-linux
chmod +x /Users/vadimr/swe-bench-research/grafema-install/rfdb-server-linux
```

### Verification

```bash
# Must be real directories, NOT symlinks
file grafema-install/node_modules/@grafema/cli
# Expected: directory (NOT "symbolic link to ...")

# Must have .bin/grafema
ls grafema-install/node_modules/.bin/grafema

# Quick Docker test
docker run --rm -v $(pwd)/grafema-install/node_modules:/opt/modules:ro \
  node:20 node /opt/modules/.bin/grafema --version
```

### Common Failures and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| `ERR_MODULE_NOT_FOUND: Cannot find package 'commander'` | Node 16 can't resolve ESM modules from grafema | Use Node 20 side-install (see below) |
| `SyntaxError: Invalid regular expression flags` `/v` | Node 18 container, deps need Node 20+ | After 2026-02-10: ink removed, should work on Node 18. If not: install inside `node:20` container |
| `workspace:*` in package.json | Used `npm pack` instead of `pnpm pack` | Always use `pnpm pack` to resolve workspace protocol |
| `@grafema/cli -> ../../../../grafema-worker-1/packages/cli` | `npm install file:../path` creates symlinks | Use `pnpm pack` + install from tarballs |
| `Cannot find module 'chalk'` | pnpm hoisted deps not available | Install from tarballs (flat npm), not from workspace |
| `grafema: command not found` | Symlink chain broken inside container | Verify with `docker exec <c> ls -la /usr/local/bin/grafema` |

### Node 16 Containers (e.g., preact)

Some SWE-bench containers use Node 16 which can't run grafema (ESM module resolution broken).
**Solution:** Install Node 20 binary alongside, create wrapper script. System Node stays untouched.

```bash
# Inside docker exec:
curl -fsSL https://nodejs.org/dist/v20.11.1/node-v20.11.1-linux-x64.tar.xz | tar xJ -C /opt
cat > /usr/local/bin/grafema << "WRAPPER"
#!/bin/bash
exec /opt/node-v20.11.1-linux-x64/bin/node /opt/grafema/node_modules/.bin/grafema "$@"
WRAPPER
chmod +x /usr/local/bin/grafema
```

**What docker commit captures:** Node 20 binary, grafema wrapper, rfdb-server, pre-built graph.
**What docker commit does NOT capture:** node_modules (was :ro bind mount) — still needs volume mount.

Check Node version FIRST: `docker run --rm <image> node --version`
- Node 20+: grafema works directly via `ln -sf`
- Node 18: grafema works directly (after ink removal fix 2026-02-10)
- Node 16: needs side-install pattern above

## Step 2: Pre-build Graph for a Repo (Docker Commit Method)

**CRITICAL:** Do NOT build graphs on the host and copy to Docker. Grafema stores
absolute paths in `node.file` — `getCodePreview()` silently fails when paths don't
exist, making `grafema context` show NO source code (same output as `grafema query`).

**Correct approach:** Build graph INSIDE Docker, then `docker commit`.

### 2a. Create Grafema config (on host)

```bash
mkdir -p /Users/vadimr/swe-bench-research/<repo>-testbed/.grafema
cat > /Users/vadimr/swe-bench-research/<repo>-testbed/.grafema/config.yaml << 'EOF'
services:
  - name: <service-name>
    path: "src"
    entrypoint: "src/index.js"

plugins:
  discovery: []
  indexing: [JSModuleIndexer]
  analysis: [JSASTAnalyzer]
  enrichment:
    - MethodCallResolver
    - ArgumentParameterLinker
    - AliasTracker
    - ClosureCaptureEnricher
    - ImportExportLinker
    - PrefixEvaluator
  validation: [GraphConnectivityValidator]

include: ["src/**/*.js"]
exclude: ["**/node_modules/**", "**/dist/**", "**/*.test.*"]
EOF
```

### 2b. Build graph inside Docker container

```bash
# 1. Start container from SWE-bench image
docker run -d --name grafema-prebuild -w /testbed \
  -v /Users/vadimr/swe-bench-research/grafema-install/node_modules:/opt/grafema/node_modules:ro \
  -v /Users/vadimr/swe-bench-research/<repo>-testbed/.grafema/config.yaml:/tmp/grafema-config.yaml:ro \
  -v /Users/vadimr/swe-bench-research/grafema-install/rfdb-server-linux:/opt/rfdb-server:ro \
  <swebench-image>:latest sleep 1h

# 2. Install grafema + build graph inside container
docker exec grafema-prebuild bash -c '
  ln -sf /opt/grafema/node_modules/.bin/grafema /usr/local/bin/grafema &&
  cp /opt/rfdb-server /usr/local/bin/rfdb-server && chmod +x /usr/local/bin/rfdb-server &&
  mkdir -p /testbed/.grafema &&
  cp /tmp/grafema-config.yaml /testbed/.grafema/config.yaml &&
  setsid /usr/local/bin/rfdb-server /testbed/.grafema/graph.rfdb \
    --socket /testbed/.grafema/rfdb.sock </dev/null >/dev/null 2>&1 & disown &&
  sleep 2 && cd /testbed && grafema analyze &&
  echo "=== VERIFY ===" && grafema overview &&
  echo "=== TEST CONTEXT ===" && grafema context "$(grafema query "" 2>&1 | grep "ID:" | head -1 | awk "{print \$2}")" 2>&1 | head -20
'

# 3. Stop server and commit
docker exec grafema-prebuild pkill rfdb-server
docker commit grafema-prebuild swebench/<repo>-grafema:latest
docker stop grafema-prebuild && docker rm grafema-prebuild

# 4. Tag for mini-SWE-agent (backup original first!)
docker tag <swebench-image>:latest <swebench-image>:original
docker tag swebench/<repo>-grafema:latest <swebench-image>:latest
```

### 2c. Verify context shows source code

```bash
# Must show "Source (lines X-Y):" section and code lines with " | "
docker run --rm -v .../grafema-install/node_modules:/opt/grafema/node_modules:ro \
  <swebench-image>:latest bash -c '
    setsid /usr/local/bin/rfdb-server /testbed/.grafema/graph.rfdb \
      --socket /testbed/.grafema/rfdb.sock & sleep 2 &&
    cd /testbed && grafema context "<any-semantic-id>" 2>&1 | head -20
  '
```

**Expected:** Output includes `Source (lines X-Y):` with code lines like `  >42 | function foo() {`
**If missing:** Graph was built with wrong paths. Rebuild using docker commit method above.

### Common Failures

| Symptom | Cause | Fix |
|---------|-------|-----|
| `grafema context` shows edges but NO source code | Graph stores host paths, files not found in Docker | Use docker commit method (build inside container) |
| `RFDB server binary not found` with `--auto-start` | Binary installed to PATH but auto-start checks node_modules | Start rfdb-server manually before `grafema analyze` |
| `grafema context` shows `../Users/vadimr/...` paths | Graph stores absolute host paths, `formatLocation()` computes wrong relative path | Rebuild graph inside Docker |
| `grafema analyze` hangs in startup command | Docker startup timeout or process management issue | Use docker commit instead of runtime analyze |

### Discovery Gotcha

If `grafema overview` shows 0 modules/functions: the repo likely has entry points in
`dist/` or `build/` which don't exist (not built). Use explicit `services` in config.yaml.
See skill `grafema-discovery-unbuilt-projects`.

### Restoring Original Image (for baseline runs or eval)

```bash
docker tag <swebench-image>:original <swebench-image>:latest
```

### Simplified Docker Commit Flow (for repos with same structure)

When running multiple tasks from the same repo (e.g., preact-2757, preact-2927, preact-3062),
each task has a different base commit but the same repo structure. The grafema config can
be reused but the graph must be rebuilt per task (different code state).

**Quick flow for subsequent tasks in same repo:**

```bash
# 1. Start container
docker run -d --name grafema-prebuild-XXXX -w /testbed \
  -v .../grafema-install/node_modules:/opt/grafema/node_modules:ro \
  -v .../REPO-testbed/.grafema/config.yaml:/tmp/grafema-config.yaml:ro \
  -v .../grafema-install/rfdb-server-linux:/opt/rfdb-server:ro \
  <swebench-image>:latest sleep 1h

# 2. Build (single docker exec — includes Node 20 side-install if needed)
docker exec grafema-prebuild-XXXX bash -c '
  curl -fsSL https://nodejs.org/dist/v20.11.1/node-v20.11.1-linux-x64.tar.xz | tar xJ -C /opt
  cat > /usr/local/bin/grafema << "WRAPPER"
#!/bin/bash
exec /opt/node-v20.11.1-linux-x64/bin/node /opt/grafema/node_modules/.bin/grafema "$@"
WRAPPER
  chmod +x /usr/local/bin/grafema
  cp /opt/rfdb-server /usr/local/bin/rfdb-server && chmod +x /usr/local/bin/rfdb-server
  mkdir -p /testbed/.grafema && cp /tmp/grafema-config.yaml /testbed/.grafema/config.yaml
  setsid /usr/local/bin/rfdb-server /testbed/.grafema/graph.rfdb \
    --socket /testbed/.grafema/rfdb.sock </dev/null >/dev/null 2>&1 & disown
  sleep 2 && cd /testbed && /usr/local/bin/grafema analyze && /usr/local/bin/grafema overview
'

# 3. Commit and tag
docker exec grafema-prebuild-XXXX pkill rfdb-server; sleep 1
docker commit grafema-prebuild-XXXX swebench/REPO-XXXX-grafema:latest
docker stop grafema-prebuild-XXXX && docker rm grafema-prebuild-XXXX
docker tag <swebench-image>:latest <swebench-image>:original
docker tag swebench/REPO-XXXX-grafema:latest <swebench-image>:latest
```

### Grafema Config Reuse

For same-repo tasks, one config works for all. Create once, mount for each:
- `preact-2757-testbed/.grafema/config.yaml` works for all 17 preact tasks
- Only needs updating if repo structure changes between versions

### Grafema Run Config Reuse

`config/sonnet-grafema-2757.yaml` works for **any** docker-commit image:
- Only mounts `node_modules` (graph is already inside the image)
- `env_startup_command` just starts rfdb-server (everything else committed)
- Rename to `config/sonnet-grafema-dockercommit.yaml` for clarity

## Step 3: Configure Experiment

### Baseline config (`config/swebench-research.yaml`)

```yaml
agent:
  step_limit: 75
  cost_limit: 3.0
model:
  model_name: "anthropic/claude-sonnet-4-5-20250929"
  model_kwargs:
    drop_params: true
    temperature: 0.0
```

### Grafema config (`config/sonnet-grafema.yaml`)

Key sections (see full file at `/Users/vadimr/swe-bench-research/config/sonnet-grafema.yaml`):

```yaml
environment:
  run_args:
    - "--rm"
    - "-v"
    - "/Users/vadimr/swe-bench-research/grafema-install/node_modules:/opt/grafema/node_modules:ro"
    - "-v"
    - "/Users/vadimr/swe-bench-research/<repo>-testbed/.grafema:/grafema-prebuilt:ro"
    - "-v"
    - "/Users/vadimr/swe-bench-research/grafema-install/rfdb-server-linux:/opt/rfdb-server:ro"

run:
  env_startup_command: |
    ln -sf /opt/grafema/node_modules/.bin/grafema /usr/local/bin/grafema && \
    cp /opt/rfdb-server /usr/local/bin/rfdb-server && chmod +x /usr/local/bin/rfdb-server && \
    cp -r /grafema-prebuilt /testbed/.grafema && \
    setsid /usr/local/bin/rfdb-server /testbed/.grafema/graph.rfdb \
      --socket /testbed/.grafema/rfdb.sock </dev/null >/dev/null 2>&1 & disown && \
    sleep 2 && echo "Grafema ready"
```

**IMPORTANT about `env_startup_command`:**
- `setsid ... & disown` is REQUIRED — Docker exec tracks all child processes
- `</dev/null >/dev/null 2>&1` prevents stdio from blocking Docker exec
- `sleep 2` gives rfdb-server time to start
- See skill `docker-exec-background-process` for details

**IMPORTANT about volume mounts:**
- The `.grafema` dir is copied (`cp -r`), not used in-place, because it's mounted read-only
  but rfdb-server needs write access for the socket file
- `rfdb-server-linux` is a separate mount because the binary isn't in node_modules
  (it's a native Rust binary from `packages/rfdb-server/prebuilt/linux-x64/`)

## Step 4: Run Experiment

```bash
cd /Users/vadimr/swe-bench-research
source mini-swe-agent/.venv/bin/activate

# Single task (for testing)
MSWEA_SILENT_STARTUP=1 python -m minisweagent.run.benchmarks.swebench \
    --subset multilingual --split test \
    --filter "preactjs__preact-3345" \
    -c mini-swe-agent/src/minisweagent/config/benchmarks/swebench.yaml \
    -c config/sonnet-grafema.yaml \
    -o results/<run-name>

# All JS/TS tasks
MSWEA_SILENT_STARTUP=1 python -m minisweagent.run.benchmarks.swebench \
    --subset multilingual --split test \
    --filter "^(axios|preact|babel|docusaurus|vuejs|three|immutable)" \
    -c mini-swe-agent/src/minisweagent/config/benchmarks/swebench.yaml \
    -c config/swebench-research.yaml \
    -o results/baseline
```

### Monitoring

```bash
# Rich.Live captures stdout — check log file instead:
tail -f results/<run-name>/minisweagent.log

# Container status:
docker ps --filter name=minisweagent

# Process alive?
ps aux | grep minisweagent | grep -v grep
```

### CLI flags

| Flag | Purpose |
|------|---------|
| `--filter "regex"` | Filter instance IDs (NOT `--instance-filter`) |
| `--slice "0:1"` | Take first N instances |
| `--redo-existing` | Re-run even if preds.json has entry |
| `-o results/name` | Output directory |
| `-c config.yaml` | Config file (can stack multiple) |
| `-m "model/name"` | Override model |

### Gotchas

- **Skipping tasks**: mini-SWE-agent skips based on `preds.json`, NOT trajectory files.
  Delete `preds.json` to re-run, or use `--redo-existing`.
- **step_limit=50 too low**: Agent needs ~49 steps. Use 75.
- **Rich.Live captures stdout**: Check `minisweagent.log`, not terminal output.

## Step 5: Evaluate Results

```bash
# 1. Convert preds.json (dict) to JSONL (swebench format)
python3 << 'PYEOF'
import json
with open('results/<run-name>/preds.json') as f:
    data = json.load(f)
with open('results/<run-name>/preds.jsonl', 'w') as f:
    for instance_id, pred in data.items():
        f.write(json.dumps(pred) + '\n')
PYEOF

# 2. Run swebench evaluation
python -m swebench.harness.run_evaluation \
    --dataset_name swe-bench/SWE-Bench_Multilingual \
    --predictions_path results/<run-name>/preds.jsonl \
    --max_workers 1 \
    --run_id <run-name>
```

## Step 6: Analyze Trajectories

```python
import json

with open('results/<run>/instance_id/instance_id.traj.json') as f:
    data = json.load(f)

# Structure: data['messages'] is list of {role, content} messages
# Check if grafema was actually used (not just mentioned in prompt):
for msg in data['messages']:
    if msg['role'] == 'tool':
        content = msg.get('content', '')
        if 'grafema' in content.lower():
            # Check returncode — 0 = success, 1 = error
            print(content[:200])
```

**CRITICAL**: Count SUCCESSFUL grafema executions (returncode=0 in tool messages),
not text references. The system prompt mentions "grafema" many times — don't count those.

## Docker Pitfalls (Learned the Hard Way)

### 1. Node Version Mismatch

SWE-bench containers have different Node versions per repo:
- **axios**: Node 20+ (grafema works)
- **preact**: Node 18 (grafema crashes if deps need Node 20+)
- **Other repos**: CHECK FIRST with `docker run --rm <image> node --version`

**After 2026-02-10 fix**: ink/react removed from CLI, all deps should be Node 18 compatible.
If a new dependency re-introduces Node 20+ requirement, use the `pnpm pack` + `node:20`
Docker install workflow above.

### 2. Symlinks in Docker Volumes

Docker volume mounts preserve symlinks but their TARGETS may not exist inside the container.

**Sources of broken symlinks:**
- `npm install file:../path` → creates symlink to host path
- pnpm workspace `node_modules/@scope/pkg` → symlinks to workspace packages
- `.bin/` entries → relative symlinks that may chain through broken paths

**Prevention**: Always install from tarballs (`pnpm pack` first), never from `file:` paths
pointing to local directories.

### 3. Background Process in Docker Exec

`docker exec <c> bash -c "server &"` HANGS because docker exec waits for ALL child
processes, not just the shell.

**Fix**: `setsid /path/to/server </dev/null >/dev/null 2>&1 & disown`
- `setsid` creates new session (detaches from docker exec's process group)
- `</dev/null >/dev/null 2>&1` closes all stdio
- `& disown` backgrounds and removes from job table

### 4. Read-Only Volume + Write-Needed Files

`.grafema/` is mounted read-only but rfdb-server creates a socket file.
**Fix**: `cp -r /grafema-prebuilt /testbed/.grafema` copies to writable location.

### 5. rfdb-server Binary Location

The binary is at `packages/rfdb-server/prebuilt/linux-x64/rfdb-server` in the Grafema repo.
It is NOT inside `node_modules/@grafema/rfdb/` after npm install. Must be mounted separately.

## Experiment Results So Far

### axios__axios-4731

| Condition | Submitted | Eval | Steps | Cost | Grafema cmds |
|-----------|-----------|------|-------|------|-------------|
| A (baseline) | Yes | PASS | 49 | $0.51 | N/A |
| B (grafema) | Yes | PASS | 37 | ~$0.40 | 37 |

Grafema saved 25% steps on this easy task.

### preactjs__preact-3345 (effect cleanup error handling)

| Condition | Submitted | Eval | Steps | Grafema cmds |
|-----------|-----------|------|-------|-------------|
| A (baseline) | No (exhausted) | N/A | 40 | N/A |
| B (grafema v5) | Yes | FAIL | 48 | 0 (crashed) |
| B (grafema v6 context) | Yes | FAIL | 50 | many |

Context accelerates navigation 3x but doesn't change design decisions.

### preactjs__preact-4436 (ref cleanup — React 19 feature)

| Condition | Submitted | Eval | Steps | File ops |
|-----------|-----------|------|-------|----------|
| A (baseline) | Yes | FAIL | 50 | 53 cat/grep |
| B (grafema) | Yes | FAIL | 37 | 0 cat/grep |

Grafema completely replaces file exploration (53→0 commands).

### preactjs__preact-2757 (progress element value=0)

| Condition | Submitted | Eval | Steps | File ops |
|-----------|-----------|------|-------|----------|
| A (baseline) | Yes | FAIL | 50 | 29 |
| B (grafema) | Yes | FAIL | 43 | 15 (-48%) |

Both produce identical patch. Node 16 required side-install workaround.

### preactjs__preact-2927 (contentEditable=undefined crash)

| Condition | Submitted | Eval | Steps | File ops |
|-----------|-----------|------|-------|----------|
| A (baseline) | Yes | FAIL | 41 | 28 |
| B (grafema) | Yes | FAIL | 45 | 17 (-39%) |

Both produce identical patch. Grafema doesn't help when bug keyword is DOM-specific.

### preactjs__preact-3062 (tabIndex not removed)

| Condition | Submitted | Eval | Steps | File ops |
|-----------|-----------|------|-------|----------|
| A (baseline) | Yes | FAIL | ~30 | ~25 |
| B (grafema) | **HUNG** | N/A | N/A | N/A |

Grafema condition hung 3 times. Cause unknown (not startup — verified separately).

### Key Findings

1. **Preact: 0/5 baseline, 0/4 grafema** — Sonnet can't solve Preact tasks
2. **Grafema consistently reduces file operations** by 39-100% where it works
3. **Grafema does NOT improve fix correctness** — same wrong patches
4. **Node 16 side-install works** — no test contamination
5. **Props.js tasks**: Sonnet produces same `removeAttribute` pattern on all 3, all fail
6. **REG-400** (callback resolution) was critical for graph quality
7. **REG-409** (edge uniqueness) reduced duplicate edges ~6%

## Checklist: Before Each Run

- [ ] `grafema-install/node_modules` has NO symlinks (`file ... | grep -v directory`)
- [ ] rfdb-server-linux binary exists and is executable
- [ ] Pre-built graph exists for the target repo
- [ ] Test startup in container: `docker run --rm ... bash -c "startup_cmd && grafema overview"`
- [ ] Check Node version: `docker run --rm <image> node --version`
- [ ] Delete old results if re-running: `rm -rf results/<name>`

## Checklist: After Each Run

- [ ] Check `minisweagent.log` — did agent start? Did grafema startup succeed?
- [ ] Check trajectory — did agent ACTUALLY use grafema (returncode=0)?
- [ ] Convert preds.json → preds.jsonl
- [ ] Run swebench evaluation
- [ ] Update results in `_tasks/swe-bench-research/` report files

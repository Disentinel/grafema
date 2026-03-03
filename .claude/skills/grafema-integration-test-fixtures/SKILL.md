---
name: grafema-integration-test-fixtures
description: |
  Fix integration test failures when grafema analyze produces 0 modules or graph queries
  return empty results in Node.js test fixtures. Use when: (1) `modulesCreated: 0` despite
  fixture files existing, (2) test runs grafema analyze + impact/overview and gets empty
  results, (3) socket path error "path must be shorter than SUN_LEN", (4) spawnSync hangs
  indefinitely after spawning grafema analyze. Root causes: missing entry point file,
  socket path too long (macOS limit), or inherited stderr pipe preventing spawnSync exit.
author: Claude Code
version: 1.0.0
date: 2026-02-21
---

# Grafema Integration Test Fixture Setup

## Problem
Integration tests that spin up `grafema analyze` against temp directories fail with
zero modules analyzed, empty graph results, hanging spawnSync, or socket path errors.

## Context / Trigger Conditions
1. `analyze failed: modulesCreated: 0` — JSModuleIndexer found no source files
2. `Failed to bind socket: path must be shorter than SUN_LEN` — socket path > 104 bytes
3. `spawnSync` never returns — rfdb-server inherits stderr pipe, holds it open
4. Impact/overview/query commands return no results despite analyze succeeding

## Solution

### Fix 1: Add `src/index.js` entry point to every fixture

JSModuleIndexer follows import chains starting from `package.json`'s `main` field.
If the entry point file doesn't exist OR doesn't import your fixture files, 0 modules
are discovered.

Every fixture setup function must write an entry point:
```javascript
// In your setupXxxProject() helper:
writeFileSync(
  join(srcDir, 'index.js'),
  `require('./impl');\nrequire('./service');\n`
);

writeFileSync(
  join(tempDir, 'package.json'),
  JSON.stringify({ name: 'test', version: '1.0.0', main: 'src/index.js' })
);
```

The entry point must transitively import all files you want in the graph.
Files not reachable from the entry point are NOT analyzed.

### Fix 2: Use short temp dir prefix (macOS SUN_LEN = 104 bytes)

Unix socket path limit on macOS is 104 bytes. The socket lives at:
`/private/var/folders/XX/YYYYYY/T/PREFIX-XXXXXX/.grafema/rfdb.sock`

The base path before the prefix is already ~60 characters. Keep prefixes short:
```javascript
// BAD — too long (109+ chars total):
tempDir = mkdtempSync(join(tmpdir(), 'grafema-impact-poly-test-'));

// GOOD — short prefix (91 chars total):
tempDir = mkdtempSync(join(tmpdir(), 'gfm-poly-'));
```

Guideline: keep prefix under 10 characters.

### Fix 3: Fix spawnSync hang from inherited stderr pipe

When tests call `grafema analyze` via `spawnSync`, the analyze process spawns
rfdb-server with `stdio: 'inherit'`. In non-TTY (spawnSync) environments, rfdb-server
inherits the stderr pipe from analyze. When analyze exits, rfdb-server still holds
that pipe. `spawnSync` waits for EOF on the pipe → hangs forever.

Fix in `packages/core/src/utils/startRfdbServer.ts`:
```typescript
// Before (hangs in tests):
stdio: ['ignore', 'ignore', 'inherit'],

// After (TTY detection):
stdio: ['ignore', 'ignore', process.stderr.isTTY ? 'inherit' : 'ignore'],
```

## Verification

After fixing:
1. `analyze` output shows `modulesCreated: N` where N > 0
2. Socket path: `echo -n "/private/var/folders/.../T/gfm-xxx-XXXXXX/.grafema/rfdb.sock" | wc -c` < 104
3. `spawnSync` returns within the `--auto-start` timeout (~5-10s)

## Example: Complete Fixture Helper

```javascript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'gfm-xxx-'));  // short prefix!
});

afterEach(() => {
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
});

async function setupProject(): Promise<void> {
  const srcDir = join(tempDir, 'src');
  mkdirSync(srcDir);

  writeFileSync(join(srcDir, 'impl.js'), `
class MyClass {
  doThing() { return true; }
}
module.exports = { MyClass };
`);

  writeFileSync(join(srcDir, 'consumer.js'), `
const { MyClass } = require('./impl');
function useIt() { new MyClass().doThing(); }
module.exports = { useIt };
`);

  // REQUIRED: entry point so JSModuleIndexer discovers all files
  writeFileSync(join(srcDir, 'index.js'), `require('./consumer');\n`);

  writeFileSync(
    join(tempDir, 'package.json'),
    JSON.stringify({ name: 'test', version: '1.0.0', main: 'src/index.js' })
  );

  // Run init + analyze
  const cli = '/path/to/grafema/dist/cli.js';
  spawnSync('node', [cli, 'init'], { cwd: tempDir, encoding: 'utf8' });
  const result = spawnSync('node', [cli, 'analyze', '--auto-start'], {
    cwd: tempDir, encoding: 'utf8', timeout: 30000
  });
  if (result.status !== 0) throw new Error(`analyze failed: ${result.stderr}`);
}
```

## Notes

- `consumer.js` requires `impl.js` — transitively reachable from `index.js`, so both are analyzed
- If you add a new fixture file mid-test (e.g., `service.js`), update `index.js` to require it
- On Linux, SUN_LEN is 108 bytes — still keep prefixes short for safety
- The spawnSync fix (`isTTY`) only applies to the rfdb-server stderr. Other stdio is unaffected.
- `grafema init` must run before `grafema analyze`; both must run in `tempDir` (cwd)

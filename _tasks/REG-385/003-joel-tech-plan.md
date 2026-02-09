# Joel's Tech Plan: REG-385 — Detect missing Node in PATH (nvm)

## Step 1: `checkNodeEnvironment()` in checks.ts

### Location
`packages/cli/src/commands/doctor/checks.ts` — add new exported function.

### Implementation

```typescript
/**
 * Check Node.js availability and version.
 * Level 0: System prerequisite — runs before all other checks.
 *
 * Detects:
 * - Node.js not in PATH (common with nvm in non-interactive shells)
 * - Node.js version below minimum required
 * - nvm installed but not loaded (NVM_DIR set but node not via nvm)
 */
export async function checkNodeEnvironment(): Promise<DoctorCheckResult> {
  // 1. Check node is available (we're running, so it IS — but check version)
  const nodeVersion = process.version; // e.g., "v20.11.0"
  const major = parseInt(nodeVersion.slice(1).split('.')[0], 10);

  const MIN_NODE_VERSION = 18;

  // 2. Detect nvm environment
  const nvmDir = process.env.NVM_DIR;
  const isNvm = nvmDir && process.execPath.includes('.nvm');

  // 3. Check if running via nvm-managed Node
  const details: Record<string, unknown> = {
    version: nodeVersion,
    execPath: process.execPath,
    nvm: isNvm || false,
  };

  if (major < MIN_NODE_VERSION) {
    return {
      name: 'node',
      status: 'fail',
      message: `Node.js ${nodeVersion} is below minimum required v${MIN_NODE_VERSION}`,
      recommendation: isNvm
        ? `Upgrade: nvm install ${MIN_NODE_VERSION} && nvm use ${MIN_NODE_VERSION}`
        : `Upgrade Node.js to v${MIN_NODE_VERSION} or later`,
      details,
    };
  }

  // Pass — include nvm info if relevant
  const nvmNote = isNvm ? ' (nvm)' : '';
  return {
    name: 'node',
    status: 'pass',
    message: `Node.js ${nodeVersion}${nvmNote}`,
    details,
  };
}
```

**Complexity:** O(1) — reads `process.version` and `process.env`. No spawning.

**Key insight:** If we're running in the doctor command, Node.js IS available (we wouldn't be executing otherwise). So the version check is the main value here. The "node not in PATH" scenario is caught at the shebang level before our code even runs.

However, the `init.ts` spawn scenario is different — the CLI is running, but `spawn('node', ...)` might fail if the shell can't resolve `node` (e.g., in containerized environments or when the shebang resolved via a direct path but `node` isn't in `$PATH`).

## Step 2: Wire into doctor.ts

### Location
`packages/cli/src/commands/doctor.ts` — add Level 0 before Level 1.

### Changes

```typescript
import { checkNodeEnvironment, ... } from './doctor/checks.js';

// In the action handler, before Level 1:

// Level 0: System prerequisites
checks.push(await checkNodeEnvironment());

// Level 1: Prerequisites (fail-fast)
const initCheck = await checkGrafemaInitialized(projectPath);
// ... rest unchanged
```

Also add Node.js version to the versions check output.

### Update `checkVersions` to include Node.js

In `checkVersions()`, add `nodeVersion: process.version` to the details and message:

```typescript
message: `CLI ${cliVersion}, Core ${coreVersion}, Node ${process.version}${rfdbVersion ? `, RFDB ${rfdbVersion}` : ''}`,
details: { cli: cliVersion, core: coreVersion, node: process.version, rfdb: rfdbVersion },
```

## Step 3: Improve init.ts spawn error handling

### Location
`packages/cli/src/commands/init.ts` — `runAnalyze()` function (lines 74-83).

### Current code
```typescript
function runAnalyze(projectPath: string): Promise<number> {
  return new Promise((resolve) => {
    const cliPath = join(__dirname, '..', 'cli.js');
    const child = spawn('node', [cliPath, 'analyze', projectPath], {
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}
```

### New code
```typescript
function runAnalyze(projectPath: string): Promise<number> {
  return new Promise((resolve) => {
    const cliPath = join(__dirname, '..', 'cli.js');
    const child = spawn('node', [cliPath, 'analyze', projectPath], {
      stdio: 'inherit',
    });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        console.error('');
        console.error('✗ Could not find "node" in PATH');
        console.error('');
        if (process.env.NVM_DIR) {
          console.error('  nvm detected but Node.js is not in PATH.');
          console.error('  Run: source ~/.nvm/nvm.sh');
          console.error('  Or add to your shell profile (~/.bashrc, ~/.zshrc):');
          console.error('    export NVM_DIR="$HOME/.nvm"');
          console.error('    [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"');
        } else {
          console.error('  Install Node.js: https://nodejs.org');
          console.error('  Or with nvm: https://github.com/nvm-sh/nvm');
        }
      }
      resolve(1);
    });
  });
}
```

**Edge case:** This `spawn('node', ...)` could fail even when the CLI itself is running via Node, because the CLI might have been invoked via an absolute path to node (e.g., `/home/user/.nvm/versions/node/v20/bin/node`) while `node` is not in `$PATH`. This is rare but possible in container/CI environments.

### Alternative: Use `process.execPath` instead of `'node'`

Better fix — use `process.execPath` which is the absolute path to the Node.js binary currently running:

```typescript
const child = spawn(process.execPath, [cliPath, 'analyze', projectPath], {
  stdio: 'inherit',
});
```

This eliminates the PATH lookup entirely and is more robust. The ENOENT error handling becomes a fallback safety net rather than the primary fix.

**Recommendation:** Do BOTH — use `process.execPath` AND add error handling with nvm guidance.

## Step 4: Tests

### Location
`packages/cli/test/doctor.test.ts`

### New tests

```typescript
describe('checkNodeEnvironment', () => {
  it('should pass with current Node.js version', () => {
    const result = runCli(['doctor', '--json'], tempDir);
    // Even without .grafema, JSON output for failed doctor should exist
    // But we need .grafema for doctor to get past init check

    mkdirSync(join(tempDir, '.grafema'));
    writeFileSync(join(tempDir, '.grafema', 'config.yaml'), validConfig);

    const doctorResult = runCli(['doctor', '--json'], tempDir);
    const parsed = JSON.parse(doctorResult.stdout);

    const nodeCheck = parsed.checks.find(c => c.name === 'node');
    assert.ok(nodeCheck, 'Should have node environment check');
    assert.strictEqual(nodeCheck.status, 'pass', 'Node check should pass');
    assert.ok(nodeCheck.message.includes(process.version), 'Should include Node version');
  });

  it('should include Node.js version in versions check', () => {
    mkdirSync(join(tempDir, '.grafema'));
    writeFileSync(join(tempDir, '.grafema', 'config.yaml'), validConfig);

    const result = runCli(['doctor', '--json'], tempDir);
    const parsed = JSON.parse(result.stdout);

    const versionsCheck = parsed.checks.find(c => c.name === 'versions');
    assert.ok(versionsCheck, 'Should have versions check');
    assert.ok(
      versionsCheck.message.includes('Node') || versionsCheck.details?.node,
      'Versions should include Node.js'
    );
  });
});
```

### Test for init.ts spawn fix

Testing `spawn` failure is complex. Instead, we test that `process.execPath` is used:

```typescript
describe('init spawn uses process.execPath', () => {
  it('should use process.execPath for analyze subprocess', () => {
    // Read source and verify it uses process.execPath
    // This is a static analysis test — verifying the pattern
    const initSrc = readFileSync(
      join(__dirname, '../src/commands/init.ts'), 'utf-8'
    );
    assert.ok(
      initSrc.includes('process.execPath'),
      'init.ts should use process.execPath for spawning node'
    );
  });
});
```

## Summary of Changes

| # | File | Change | Complexity |
|---|------|--------|------------|
| 1 | `checks.ts` | Add `checkNodeEnvironment()` | O(1) |
| 2 | `doctor.ts` | Wire Level 0 check | trivial |
| 3 | `checks.ts` | Add Node.js to `checkVersions()` output | trivial |
| 4 | `init.ts` | Use `process.execPath` + ENOENT error handling with nvm guidance | O(1) |
| 5 | `doctor.test.ts` | Add tests for node check and versions | — |

## Implementation Order

1. `checkNodeEnvironment()` in checks.ts (new function)
2. Wire into doctor.ts
3. Update `checkVersions()` to include Node
4. Fix `init.ts` spawn call
5. Write tests
6. Build and run tests

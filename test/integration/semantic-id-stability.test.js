/**
 * Semantic ID Stability Guarantee Test (REG-627)
 *
 * Invariant: semantic IDs must be stable across re-analysis of unchanged code.
 * This cannot be a Datalog rule (requires comparing two analysis runs).
 *
 * Test:
 * 1. Create a project with source files
 * 2. grafema init + grafema analyze → collect all node IDs
 * 3. grafema analyze --clear again (no code changes) → collect all node IDs
 * 4. Assert: all IDs identical between runs
 *
 * Requirements: RFDB server running (or use --auto-start), grafema-orchestrator binary.
 * This is an integration test — not run in CI by default.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '../..');
const cliPath = join(projectRoot, 'packages/cli/dist/cli.js');

/**
 * Collect all node IDs from the graph via raw Datalog query.
 * Returns sorted array of all node IDs in the graph.
 */
function collectNodeIds(tempDir) {
  const output = execSync(
    `node "${cliPath}" query --raw --json -l 10000 'node(X, T, N, F).'`,
    { cwd: tempDir, encoding: 'utf-8', timeout: 60000 }
  );

  const results = JSON.parse(output);
  // Raw Datalog results: array of { bindings: [{name: "X", value: "..."}, ...] }
  const ids = results.map(r => {
    // Handle both binding formats
    if (r.bindings) {
      const xBinding = r.bindings.find(b => b.name === 'X');
      return xBinding?.value;
    }
    return r.X || r.x;
  }).filter(Boolean).sort();

  return ids;
}

describe('Semantic ID Stability (REG-627)', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-id-stability-'));

    const srcDir = join(tempDir, 'src');
    const grafemaDir = join(tempDir, '.grafema');
    mkdirSync(srcDir);
    mkdirSync(grafemaDir, { recursive: true });

    writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
      name: 'stability-test',
      version: '1.0.0',
      type: 'module',
      main: 'src/index.js',
    }));

    // Write config compatible with grafema-orchestrator (Rust binary)
    writeFileSync(join(tempDir, 'grafema.config.yaml'), `
root: "."
include:
  - "src/**/*.js"
exclude:
  - "node_modules/**"
`);

    writeFileSync(join(srcDir, 'index.js'), `
import { authenticate } from './auth.js';
import { fetchUsers } from './api.js';

async function main() {
  const user = await authenticate('admin', 'secret');
  const users = await fetchUsers(user.token);
  console.log(users);
}

main();
`);

    writeFileSync(join(srcDir, 'auth.js'), `
export function authenticate(username, password) {
  const hash = hashPassword(password);
  return { token: username + ':' + hash, role: 'admin' };
}

function hashPassword(password) {
  let hash = 0;
  for (let i = 0; i < password.length; i++) {
    hash = ((hash << 5) - hash) + password.charCodeAt(i);
  }
  return hash.toString(16);
}

export class AuthService {
  constructor(config) {
    this.config = config;
  }

  validate(token) {
    return token && token.includes(':');
  }
}
`);

    writeFileSync(join(srcDir, 'api.js'), `
export async function fetchUsers(token) {
  const response = await fetch('/api/users', {
    headers: { Authorization: 'Bearer ' + token },
  });
  return response.json();
}

export function buildUrl(base, path) {
  return base + '/' + path;
}
`);
  });

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should produce identical node IDs on re-analysis of unchanged code', () => {
    // First analysis
    execSync(`node "${cliPath}" analyze --auto-start`, {
      cwd: tempDir,
      stdio: 'pipe',
      timeout: 120000,
    });

    const idsFirstRun = collectNodeIds(tempDir);
    assert.ok(idsFirstRun.length > 0, `First run should produce nodes, got ${idsFirstRun.length}`);

    // Second analysis — clear and re-analyze same code
    execSync(`node "${cliPath}" analyze --clear --auto-start`, {
      cwd: tempDir,
      stdio: 'pipe',
      timeout: 120000,
    });

    const idsSecondRun = collectNodeIds(tempDir);

    // Compare counts
    assert.strictEqual(
      idsFirstRun.length,
      idsSecondRun.length,
      `Node count changed: ${idsFirstRun.length} → ${idsSecondRun.length}`
    );

    // Find any ID differences
    const firstSet = new Set(idsFirstRun);
    const secondSet = new Set(idsSecondRun);
    const onlyInFirst = idsFirstRun.filter(id => !secondSet.has(id));
    const onlyInSecond = idsSecondRun.filter(id => !firstSet.has(id));

    if (onlyInFirst.length > 0 || onlyInSecond.length > 0) {
      const diff = [];
      if (onlyInFirst.length > 0) {
        diff.push(`IDs only in first run (${onlyInFirst.length}):\n  ${onlyInFirst.slice(0, 10).join('\n  ')}`);
      }
      if (onlyInSecond.length > 0) {
        diff.push(`IDs only in second run (${onlyInSecond.length}):\n  ${onlyInSecond.slice(0, 10).join('\n  ')}`);
      }
      assert.fail(`Semantic IDs changed between analysis runs:\n${diff.join('\n')}`);
    }

    assert.deepStrictEqual(idsFirstRun, idsSecondRun);
  });
});

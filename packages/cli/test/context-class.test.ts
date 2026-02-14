/**
 * Tests for `grafema context` command with CLASS targets - REG-411
 *
 * When `grafema context` is called on a CLASS node, it should show
 * all methods with their source code and edges, not just the constructor.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, '../dist/cli.js');

let cmdCounter = 0;

/**
 * Run CLI command by redirecting output to temp files.
 * This avoids the pipe-inheritance issue where rfdb-server keeps the pipe open,
 * causing execSync/spawnSync to hang indefinitely.
 */
function runCli(
  args: string[],
  cwd: string
): { stdout: string; stderr: string; status: number } {
  const id = ++cmdCounter;
  const outFile = `/tmp/gf-cli-out-${id}`;
  const errFile = `/tmp/gf-cli-err-${id}`;
  const quotedArgs = args.map(a => `'${a}'`).join(' ');
  const cmd = `node ${cliPath} ${quotedArgs} > '${outFile}' 2> '${errFile}'; echo $? > '${outFile}.rc'`;

  try {
    execSync(cmd, {
      cwd,
      timeout: 30000,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: 'ignore',
    });
  } catch {
    // timeout or error — still read files
  }

  const stdout = existsSync(outFile) ? readFileSync(outFile, 'utf-8') : '';
  const stderr = existsSync(errFile) ? readFileSync(errFile, 'utf-8') : '';
  const rcStr = existsSync(`${outFile}.rc`) ? readFileSync(`${outFile}.rc`, 'utf-8').trim() : '1';
  const status = parseInt(rcStr, 10) || 0;

  // Clean up temp files
  try { rmSync(outFile, { force: true }); } catch { /* ignore */ }
  try { rmSync(errFile, { force: true }); } catch { /* ignore */ }
  try { rmSync(`${outFile}.rc`, { force: true }); } catch { /* ignore */ }

  return { stdout, stderr, status };
}

function getSemanticId(queryPattern: string, cwd: string): string | null {
  const result = runCli(['query', queryPattern, '--json'], cwd);
  if (result.status !== 0) return null;
  try {
    // Find the JSON array in output, skipping log lines like "[RFDBServerBackend]..."
    // JSON arrays start with [ followed by newline+whitespace+{
    const match = result.stdout.match(/\[\s*\n\s*\{/);
    if (!match || match.index === undefined) return null;
    const jsonStr = result.stdout.slice(match.index);
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed[0].id;
  } catch { /* ignore */ }
  return null;
}

function parseContextJson(output: string): any {
  const lines = output.split('\n');
  const jsonStart = lines.findIndex(l => l.trimStart().startsWith('{'));
  if (jsonStart === -1) throw new Error(`No JSON found in output: ${output.substring(0, 200)}`);
  return JSON.parse(lines.slice(jsonStart).join('\n'));
}

// =============================================================================
// Main test suite — shared project setup for efficiency
// =============================================================================

describe('grafema context for CLASS nodes (REG-411)', { timeout: 120000 }, () => {
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync('/tmp/gf-ctx-');
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    writeFileSync(
      join(srcDir, 'models.js'),
      `class UserModel {
  constructor(config) {
    this.config = config;
  }
  findById(id) {
    return { id, type: 'user' };
  }
  create(data) {
    this.validate(data);
    return { ...data, id: Date.now() };
  }
  validate(data) {
    return data && data.name;
  }
  delete(id) {
    return true;
  }
}
module.exports = { UserModel };
`
    );

    writeFileSync(
      join(srcDir, 'services.js'),
      `const { UserModel } = require('./models');
function getUser(id) {
  const model = new UserModel({ db: 'users' });
  return model.findById(id);
}
module.exports = { getUser };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/models.js' })
    );

    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

    const analyzeResult = runCli(['analyze', '--auto-start'], tempDir);
    assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
  });

  after(() => {
    if (tempDir) {
      try { runCli(['server', 'stop'], tempDir); } catch { /* ignore */ }
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('should show all methods of a class in text output', () => {
    const classId = getSemanticId('class UserModel', tempDir);
    assert.ok(classId, 'Should find UserModel semantic ID');

    const result = runCli(['context', classId!], tempDir);
    assert.strictEqual(result.status, 0, `context failed: ${result.stderr}`);

    const output = result.stdout;

    assert.ok(output.includes('Methods (5)'), `Should show 5 methods. Output:\n${output}`);
    assert.ok(output.includes('constructor'), 'Should show constructor');
    assert.ok(output.includes('findById'), 'Should show findById');
    assert.ok(output.includes('create'), 'Should show create');
    assert.ok(output.includes('validate'), 'Should show validate');
    assert.ok(output.includes('delete'), 'Should show delete');
  });

  it('should show method source code, not just names', () => {
    const classId = getSemanticId('class UserModel', tempDir);
    assert.ok(classId);

    const result = runCli(['context', classId!], tempDir);
    assert.strictEqual(result.status, 0, `context failed: ${result.stderr}`);

    assert.ok(result.stdout.includes('this.validate(data)'), 'Should show create method body');
    assert.ok(result.stdout.includes('data && data.name'), 'Should show validate method body');
  });

  it('should show methods in source order', () => {
    const classId = getSemanticId('class UserModel', tempDir);
    assert.ok(classId);

    const result = runCli(['context', classId!], tempDir);
    assert.strictEqual(result.status, 0);

    const methodsIdx = result.stdout.indexOf('Methods (');
    assert.ok(methodsIdx !== -1, 'Should have Methods section');
    const methodsSection = result.stdout.slice(methodsIdx);

    const constructorPos = methodsSection.indexOf('constructor');
    const findByIdPos = methodsSection.indexOf('findById');
    const createPos = methodsSection.indexOf('create');
    const validatePos = methodsSection.indexOf('validate');
    const deletePos = methodsSection.indexOf('delete');

    assert.ok(constructorPos < findByIdPos, 'constructor before findById');
    assert.ok(findByIdPos < createPos, 'findById before create');
    assert.ok(createPos < validatePos, 'create before validate');
    assert.ok(validatePos < deletePos, 'validate before delete');
  });

  it('should show method edges (RETURNS)', () => {
    const classId = getSemanticId('class UserModel', tempDir);
    assert.ok(classId);

    const result = runCli(['context', classId!], tempDir);
    assert.strictEqual(result.status, 0);

    assert.ok(result.stdout.includes('RETURNS'), 'Should show RETURNS edges for methods');
  });

  it('should include memberContexts in JSON output', () => {
    const classId = getSemanticId('class UserModel', tempDir);
    assert.ok(classId);

    const result = runCli(['context', classId!, '--json'], tempDir);
    assert.strictEqual(result.status, 0, `context --json failed: ${result.stderr}`);

    const parsed = parseContextJson(result.stdout);

    assert.ok(Array.isArray(parsed.memberContexts), 'Should have memberContexts array');
    assert.strictEqual(parsed.memberContexts.length, 5, 'Should have 5 member contexts');

    const names = parsed.memberContexts.map((mc: any) => mc.node.name);
    assert.ok(names.includes('constructor'), 'constructor in memberContexts');
    assert.ok(names.includes('findById'), 'findById in memberContexts');
    assert.ok(names.includes('create'), 'create in memberContexts');
    assert.ok(names.includes('validate'), 'validate in memberContexts');
    assert.ok(names.includes('delete'), 'delete in memberContexts');

    const first = parsed.memberContexts[0];
    assert.ok(first.source, 'Member should have source');
    assert.ok(Array.isArray(first.outgoing), 'Member should have outgoing');
    assert.ok(Array.isArray(first.incoming), 'Member should have incoming');
  });

  it('should NOT include memberContexts for function nodes', () => {
    const funcId = getSemanticId('findById', tempDir);
    assert.ok(funcId, 'Should find findById');

    const result = runCli(['context', funcId!, '--json'], tempDir);
    assert.strictEqual(result.status, 0);

    const parsed = parseContextJson(result.stdout);
    assert.ok(!parsed.memberContexts, 'Function nodes should not have memberContexts');
    assert.ok(parsed.node, 'Should still have node field');
  });
});

// =============================================================================
// Edge case: class with only constructor
// =============================================================================

describe('context for class with only constructor', { timeout: 60000 }, () => {
  let tempDir: string;

  before(() => {
    tempDir = mkdtempSync('/tmp/gf-ct2-');
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    writeFileSync(
      join(srcDir, 'simple.js'),
      `class SimpleClass {
  constructor() {
    this.value = 42;
  }
}
module.exports = { SimpleClass };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-project', version: '1.0.0', main: 'src/simple.js' })
    );

    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

    const analyzeResult = runCli(['analyze', '--auto-start'], tempDir);
    assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
  });

  after(() => {
    if (tempDir) {
      try { runCli(['server', 'stop'], tempDir); } catch { /* ignore */ }
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('should show constructor as the only method', () => {
    const classId = getSemanticId('class SimpleClass', tempDir);
    assert.ok(classId, 'Should find SimpleClass');

    const result = runCli(['context', classId!, '--json'], tempDir);
    assert.strictEqual(result.status, 0);

    const parsed = parseContextJson(result.stdout);
    assert.ok(parsed.memberContexts, 'Should have memberContexts');
    assert.strictEqual(parsed.memberContexts.length, 1, 'Should have 1 method (constructor)');
    assert.strictEqual(parsed.memberContexts[0].node.name, 'constructor');
  });
});

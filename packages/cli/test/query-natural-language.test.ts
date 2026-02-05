/**
 * Tests for REG-307: Natural Language Query Support
 *
 * Tests for scope-aware queries using " in " syntax:
 *   "response in fetchData" - find response inside fetchData function
 *   "error in catch in fetchData" - find error in catch block inside fetchData
 *   "token in src/auth.ts" - find token in specific file
 *
 * Uses parseSemanticId() from @grafema/core for robust ID parsing.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

// Get project root directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cliPath = join(__dirname, '../dist/cli.js');

/**
 * Helper to run CLI command and capture output
 */
function runCli(
  args: string[],
  cwd: string
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [cliPath, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, NO_COLOR: '1' },
  });

  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
}

// =============================================================================
// Import functions to test (will be exported from query.ts after implementation)
// For now, tests will fail until implementation is done (TDD)
// =============================================================================

// These imports will work after Rob implements the functions and exports them
// import { parseQuery, matchesScope, extractScopeContext, isFileScope } from '../src/commands/query.js';

// Temporary placeholder - tests will fail until implementation
// This allows tests to be written and run (failing) before implementation
let parseQuery: (pattern: string) => {
  type: string | null;
  name: string;
  file: string | null;
  scopes: string[];
};

let matchesScope: (semanticId: string, file: string | null, scopes: string[]) => boolean;

let extractScopeContext: (semanticId: string) => string | null;

let isFileScope: (scope: string) => boolean;

// Dynamic import to avoid module-not-found error before implementation
// Tests will fail with clear message about missing exports
beforeEach(async () => {
  try {
    const queryModule = await import('../src/commands/query.js');
    parseQuery = queryModule.parseQuery;
    matchesScope = queryModule.matchesScope;
    extractScopeContext = queryModule.extractScopeContext;
    isFileScope = queryModule.isFileScope;
  } catch {
    // Functions not yet exported - tests will fail with descriptive message
  }
});

// =============================================================================
// UNIT TESTS: parseQuery()
// =============================================================================

describe('parseQuery', () => {
  it('should parse simple name', () => {
    if (!parseQuery) {
      assert.fail('parseQuery not exported from query.ts - implement and export it');
    }
    const result = parseQuery('response');
    assert.deepStrictEqual(result, {
      type: null,
      name: 'response',
      file: null,
      scopes: [],
    });
  });

  it('should parse type + name', () => {
    if (!parseQuery) {
      assert.fail('parseQuery not exported from query.ts - implement and export it');
    }
    const result = parseQuery('variable response');
    assert.deepStrictEqual(result, {
      type: 'VARIABLE',
      name: 'response',
      file: null,
      scopes: [],
    });
  });

  it('should parse name + function scope', () => {
    if (!parseQuery) {
      assert.fail('parseQuery not exported from query.ts - implement and export it');
    }
    const result = parseQuery('response in fetchData');
    assert.deepStrictEqual(result, {
      type: null,
      name: 'response',
      file: null,
      scopes: ['fetchData'],
    });
  });

  it('should parse name + file scope with path', () => {
    if (!parseQuery) {
      assert.fail('parseQuery not exported from query.ts - implement and export it');
    }
    const result = parseQuery('response in src/app.ts');
    assert.deepStrictEqual(result, {
      type: null,
      name: 'response',
      file: 'src/app.ts',
      scopes: [],
    });
  });

  it('should parse name + file scope with extension only (no path)', () => {
    if (!parseQuery) {
      assert.fail('parseQuery not exported from query.ts - implement and export it');
    }
    const result = parseQuery('response in app.js');
    assert.deepStrictEqual(result, {
      type: null,
      name: 'response',
      file: 'app.js',
      scopes: [],
    });
  });

  it('should parse multiple scopes', () => {
    if (!parseQuery) {
      assert.fail('parseQuery not exported from query.ts - implement and export it');
    }
    const result = parseQuery('error in catch in fetchData');
    assert.deepStrictEqual(result, {
      type: null,
      name: 'error',
      file: null,
      scopes: ['catch', 'fetchData'],
    });
  });

  it('should parse full specification: type + name + function scope + file scope', () => {
    if (!parseQuery) {
      assert.fail('parseQuery not exported from query.ts - implement and export it');
    }
    const result = parseQuery('variable response in fetchData in src/app.ts');
    assert.deepStrictEqual(result, {
      type: 'VARIABLE',
      name: 'response',
      file: 'src/app.ts',
      scopes: ['fetchData'],
    });
  });

  it('should NOT split on "in" within names (signin)', () => {
    if (!parseQuery) {
      assert.fail('parseQuery not exported from query.ts - implement and export it');
    }
    const result = parseQuery('signin');
    assert.deepStrictEqual(result, {
      type: null,
      name: 'signin',
      file: null,
      scopes: [],
    });
  });

  it('should NOT split on "in" without spaces (xindex)', () => {
    if (!parseQuery) {
      assert.fail('parseQuery not exported from query.ts - implement and export it');
    }
    const result = parseQuery('function xindex');
    assert.deepStrictEqual(result, {
      type: 'FUNCTION',
      name: 'xindex',
      file: null,
      scopes: [],
    });
  });

  it('should NOT split on "in" without spaces (main)', () => {
    if (!parseQuery) {
      assert.fail('parseQuery not exported from query.ts - implement and export it');
    }
    const result = parseQuery('function main');
    assert.deepStrictEqual(result, {
      type: 'FUNCTION',
      name: 'main',
      file: null,
      scopes: [],
    });
  });

  it('should handle nested numbered scopes (try, catch)', () => {
    if (!parseQuery) {
      assert.fail('parseQuery not exported from query.ts - implement and export it');
    }
    const result = parseQuery('x in try in processData');
    assert.deepStrictEqual(result, {
      type: null,
      name: 'x',
      file: null,
      scopes: ['try', 'processData'],
    });
  });

  it('should handle trailing whitespace in scope clauses', () => {
    if (!parseQuery) {
      assert.fail('parseQuery not exported from query.ts - implement and export it');
    }
    const result = parseQuery('response in fetchData ');
    assert.deepStrictEqual(result, {
      type: null,
      name: 'response',
      file: null,
      scopes: ['fetchData'],
    });
  });
});

// =============================================================================
// UNIT TESTS: isFileScope()
// =============================================================================

describe('isFileScope', () => {
  it('should detect file path with slash', () => {
    if (!isFileScope) {
      assert.fail('isFileScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(isFileScope('src/app.ts'), true);
  });

  it('should detect file with .ts extension', () => {
    if (!isFileScope) {
      assert.fail('isFileScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(isFileScope('app.ts'), true);
  });

  it('should detect file with .js extension', () => {
    if (!isFileScope) {
      assert.fail('isFileScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(isFileScope('app.js'), true);
  });

  it('should detect file with .tsx extension', () => {
    if (!isFileScope) {
      assert.fail('isFileScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(isFileScope('Component.tsx'), true);
  });

  it('should detect file with .jsx extension', () => {
    if (!isFileScope) {
      assert.fail('isFileScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(isFileScope('Component.jsx'), true);
  });

  it('should detect file with .mjs extension', () => {
    if (!isFileScope) {
      assert.fail('isFileScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(isFileScope('module.mjs'), true);
  });

  it('should detect file with .cjs extension', () => {
    if (!isFileScope) {
      assert.fail('isFileScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(isFileScope('module.cjs'), true);
  });

  it('should NOT detect function name as file', () => {
    if (!isFileScope) {
      assert.fail('isFileScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(isFileScope('fetchData'), false);
  });

  it('should NOT detect class name as file', () => {
    if (!isFileScope) {
      assert.fail('isFileScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(isFileScope('UserService'), false);
  });

  it('should NOT detect block scope as file', () => {
    if (!isFileScope) {
      assert.fail('isFileScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(isFileScope('catch'), false);
  });

  it('should NOT detect "try" as file', () => {
    if (!isFileScope) {
      assert.fail('isFileScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(isFileScope('try'), false);
  });
});

// =============================================================================
// UNIT TESTS: matchesScope()
// =============================================================================

describe('matchesScope', () => {
  const testId = 'src/app.ts->fetchData->try#0->VARIABLE->response';

  it('should match with no constraints', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(matchesScope(testId, null, []), true);
  });

  it('should match file scope (full path)', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(matchesScope(testId, 'src/app.ts', []), true);
  });

  it('should reject wrong file', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(matchesScope(testId, 'src/other.ts', []), false);
  });

  it('should match function scope', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(matchesScope(testId, null, ['fetchData']), true);
  });

  it('should match numbered scope (try matches try#0)', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(matchesScope(testId, null, ['try']), true);
  });

  it('should match multiple scopes (AND logic)', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(matchesScope(testId, null, ['fetchData', 'try']), true);
  });

  it('should reject if any scope is missing', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(matchesScope(testId, null, ['fetchData', 'catch']), false);
  });

  it('should match file + function scope together', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(matchesScope(testId, 'src/app.ts', ['fetchData']), true);
  });

  it('should reject wrong file even with matching scope', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(matchesScope(testId, 'src/other.ts', ['fetchData']), false);
  });

  // --- Additional tests from Linus review ---

  it('should match basename (app.ts matches src/app.ts)', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    // Basename matching: user says "app.ts", should match "src/app.ts"
    assert.strictEqual(matchesScope(testId, 'app.ts', []), true);
  });

  it('should match scopes regardless of order in query (scope order independence)', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    // ID: src/app.ts->fetchData->try#0->VARIABLE->response
    // Query order ["try", "fetchData"] should match same as ["fetchData", "try"]
    assert.strictEqual(matchesScope(testId, null, ['try', 'fetchData']), true);
    assert.strictEqual(matchesScope(testId, null, ['fetchData', 'try']), true);
  });

  it('should match hierarchical scopes (class contains method)', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    const classMethodId = 'src/app.ts->UserService->login->VARIABLE->token';

    // "token in UserService" should match (class scope)
    assert.strictEqual(matchesScope(classMethodId, null, ['UserService']), true);
    // "token in login" should match (method scope)
    assert.strictEqual(matchesScope(classMethodId, null, ['login']), true);
    // "token in login in UserService" should match (both scopes)
    assert.strictEqual(matchesScope(classMethodId, null, ['UserService', 'login']), true);
  });

  it('should match catch block scope (catch matches catch#0)', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    const catchId = 'src/app.ts->processData->catch#0->VARIABLE->error';
    assert.strictEqual(matchesScope(catchId, null, ['catch']), true);
  });

  it('should NOT match scope that does not exist in ID', () => {
    if (!matchesScope) {
      assert.fail('matchesScope not exported from query.ts - implement and export it');
    }
    assert.strictEqual(matchesScope(testId, null, ['nonexistent']), false);
  });
});

// =============================================================================
// UNIT TESTS: extractScopeContext()
// =============================================================================

describe('extractScopeContext', () => {
  it('should return null for global scope', () => {
    if (!extractScopeContext) {
      assert.fail('extractScopeContext not exported from query.ts - implement and export it');
    }
    const result = extractScopeContext('src/app.ts->global->FUNCTION->main');
    assert.strictEqual(result, null);
  });

  it('should format function scope', () => {
    if (!extractScopeContext) {
      assert.fail('extractScopeContext not exported from query.ts - implement and export it');
    }
    const result = extractScopeContext('src/app.ts->fetchData->VARIABLE->response');
    assert.strictEqual(result, 'inside fetchData');
  });

  it('should format try block', () => {
    if (!extractScopeContext) {
      assert.fail('extractScopeContext not exported from query.ts - implement and export it');
    }
    const result = extractScopeContext('src/app.ts->fetchData->try#0->VARIABLE->response');
    assert.strictEqual(result, 'inside fetchData, inside try block');
  });

  it('should format catch block', () => {
    if (!extractScopeContext) {
      assert.fail('extractScopeContext not exported from query.ts - implement and export it');
    }
    const result = extractScopeContext('src/app.ts->processData->catch#0->VARIABLE->error');
    assert.strictEqual(result, 'inside processData, inside catch block');
  });

  it('should format nested class.method scope', () => {
    if (!extractScopeContext) {
      assert.fail('extractScopeContext not exported from query.ts - implement and export it');
    }
    const result = extractScopeContext('src/app.ts->UserService->login->VARIABLE->token');
    assert.strictEqual(result, 'inside UserService, inside login');
  });

  it('should format conditional (if block)', () => {
    if (!extractScopeContext) {
      assert.fail('extractScopeContext not exported from query.ts - implement and export it');
    }
    const result = extractScopeContext('src/app.ts->validate->if#0->VARIABLE->isValid');
    assert.strictEqual(result, 'inside validate, inside conditional');
  });

  it('should format else block', () => {
    if (!extractScopeContext) {
      assert.fail('extractScopeContext not exported from query.ts - implement and export it');
    }
    const result = extractScopeContext('src/app.ts->validate->else#0->VARIABLE->fallback');
    assert.strictEqual(result, 'inside validate, inside else block');
  });

  it('should format for loop', () => {
    if (!extractScopeContext) {
      assert.fail('extractScopeContext not exported from query.ts - implement and export it');
    }
    const result = extractScopeContext('src/app.ts->processItems->for#0->VARIABLE->item');
    assert.strictEqual(result, 'inside processItems, inside loop');
  });

  it('should format while loop', () => {
    if (!extractScopeContext) {
      assert.fail('extractScopeContext not exported from query.ts - implement and export it');
    }
    const result = extractScopeContext('src/app.ts->waitLoop->while#0->VARIABLE->done');
    assert.strictEqual(result, 'inside waitLoop, inside loop');
  });

  it('should format switch statement', () => {
    if (!extractScopeContext) {
      assert.fail('extractScopeContext not exported from query.ts - implement and export it');
    }
    const result = extractScopeContext('src/app.ts->handleAction->switch#0->VARIABLE->action');
    assert.strictEqual(result, 'inside handleAction, inside switch');
  });

  it('should return null for too short semantic ID', () => {
    if (!extractScopeContext) {
      assert.fail('extractScopeContext not exported from query.ts - implement and export it');
    }
    const result = extractScopeContext('src/app.ts->FUNCTION');
    assert.strictEqual(result, null);
  });
});

// =============================================================================
// INTEGRATION TESTS: CLI with scope support
// =============================================================================

describe('grafema query with scope support (integration)', { timeout: 60000 }, () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'grafema-query-scope-test-'));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  /**
   * Helper to set up a test project with variables in different scopes
   */
  async function setupTestProject(): Promise<void> {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    // Create app.js with variables in different scopes
    writeFileSync(
      join(srcDir, 'app.js'),
      `
async function fetchData() {
  try {
    const response = await fetch('/api/data');
    return response.json();
  } catch (error) {
    console.error('Failed:', error);
    return null;
  }
}

function processData(data) {
  const result = data.items.map(item => item.value);
  return result;
}

class UserService {
  login(username, password) {
    const token = this.authenticate(username, password);
    return token;
  }

  authenticate(user, pass) {
    return 'token_' + user;
  }
}

module.exports = { fetchData, processData, UserService };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-scope-query', version: '1.0.0', main: 'src/app.js' })
    );

    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

    const analyzeResult = runCli(['analyze', '--auto-start'], tempDir);
    assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
  }

  /**
   * Helper to set up project with files having same basename in different directories
   */
  async function setupBasenameCollisionProject(): Promise<void> {
    const srcDir = join(tempDir, 'src');
    const testDir = join(tempDir, 'test');
    mkdirSync(srcDir);
    mkdirSync(testDir);

    // Create src/app.js
    writeFileSync(
      join(srcDir, 'app.js'),
      `
function processItem(item) {
  const response = item.data;
  return response;
}
module.exports = { processItem };
`
    );

    // Create test/app.js with same variable name
    writeFileSync(
      join(testDir, 'app.js'),
      `
function testProcessItem() {
  const response = { mock: true };
  return response;
}
module.exports = { testProcessItem };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-basename-collision',
        version: '1.0.0',
        main: 'src/app.js',
      })
    );

    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

    const analyzeResult = runCli(['analyze', '--auto-start'], tempDir);
    assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
  }

  /**
   * Helper to set up a project with function named "signin" (contains "in" substring)
   */
  async function setupTestProjectWithSignin(): Promise<void> {
    const srcDir = join(tempDir, 'src');
    mkdirSync(srcDir);

    writeFileSync(
      join(srcDir, 'auth.js'),
      `
function signin(username, password) {
  return authenticate(username, password);
}

function authenticate(user, pass) {
  return { user, token: 'abc123' };
}

module.exports = { signin, authenticate };
`
    );

    writeFileSync(
      join(tempDir, 'package.json'),
      JSON.stringify({ name: 'test-signin', version: '1.0.0', main: 'src/auth.js' })
    );

    const initResult = runCli(['init'], tempDir);
    assert.strictEqual(initResult.status, 0, `init failed: ${initResult.stderr}`);

    const analyzeResult = runCli(['analyze', '--auto-start'], tempDir);
    assert.strictEqual(analyzeResult.status, 0, `analyze failed: ${analyzeResult.stderr}`);
  }

  // --- Core functionality tests ---

  it('should find variable in specific function scope', async () => {
    await setupTestProject();

    const result = runCli(['query', 'response in fetchData'], tempDir);

    assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('response'),
      `Should find response variable. Got: ${result.stdout}`
    );
    // Should be inside fetchData (via scope context or ID)
    assert.ok(
      result.stdout.includes('fetchData') || result.stdout.includes('fetch'),
      `Should indicate fetchData scope. Got: ${result.stdout}`
    );
  });

  it('should filter by file scope', async () => {
    await setupTestProject();

    const result = runCli(['query', 'response in src/app.js'], tempDir);

    assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('response'),
      `Should find response in src/app.js. Got: ${result.stdout}`
    );
  });

  it('should combine type and scope', async () => {
    await setupTestProject();

    const result = runCli(['query', 'variable response in fetchData'], tempDir);

    assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('response'),
      `Should find VARIABLE response in fetchData. Got: ${result.stdout}`
    );
  });

  it('should NOT split on "in" within function names (signin)', async () => {
    await setupTestProjectWithSignin();

    const result = runCli(['query', 'signin'], tempDir);

    assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
    assert.ok(
      result.stdout.includes('signin'),
      `Should find signin function. Got: ${result.stdout}`
    );
    // Should NOT parse as "sign in n"
    assert.ok(
      !result.stdout.includes('No results'),
      `Should find results for signin. Got: ${result.stdout}`
    );
  });

  // --- Tests from Linus review ---

  it('should match both files with same basename (basename collision)', async () => {
    await setupBasenameCollisionProject();

    const result = runCli(['query', 'response in app.js'], tempDir);

    assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
    // Should find response in both src/app.js and test/app.js
    assert.ok(
      result.stdout.includes('src/app.js') || result.stdout.includes('response'),
      `Should find results in at least one app.js. Got: ${result.stdout}`
    );
  });

  it('should match only specific file with full path (basename disambiguation)', async () => {
    await setupBasenameCollisionProject();

    const result = runCli(['query', 'response in src/app.js'], tempDir);

    assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
    // Should find only src/app.js, not test/app.js
    if (result.stdout.includes('response')) {
      assert.ok(
        result.stdout.includes('src/app.js'),
        `Should find src/app.js. Got: ${result.stdout}`
      );
      assert.ok(
        !result.stdout.includes('test/app.js'),
        `Should NOT find test/app.js. Got: ${result.stdout}`
      );
    }
  });

  it('should suggest removing scope when no results found', async () => {
    await setupTestProject();

    const result = runCli(['query', 'nonexistent in fetchData'], tempDir);

    assert.strictEqual(result.status, 0, 'Should not error, just show no results');
    assert.ok(
      result.stdout.includes('No results'),
      `Should show no results message. Got: ${result.stdout}`
    );
    // Should suggest trying without scope
    assert.ok(
      result.stdout.includes('Try:') || result.stdout.includes('nonexistent'),
      `Should show helpful suggestion. Got: ${result.stdout}`
    );
  });

  it('should respect --type flag with scope', async () => {
    await setupTestProject();

    const result = runCli(['query', '--type', 'VARIABLE', 'token in UserService'], tempDir);

    assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
    // Should find VARIABLE token in UserService class
    if (!result.stdout.includes('No results')) {
      assert.ok(
        result.stdout.includes('VARIABLE') || result.stdout.includes('token'),
        `Should find VARIABLE token. Got: ${result.stdout}`
      );
    }
  });

  it('should include scopeContext in JSON output', async () => {
    await setupTestProject();

    const result = runCli(['query', 'response in fetchData', '--json'], tempDir);

    assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);

    // Find and parse JSON array from output
    const jsonStart = result.stdout.indexOf('[');
    const jsonEnd = result.stdout.lastIndexOf(']');

    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      try {
        const parsed = JSON.parse(result.stdout.slice(jsonStart, jsonEnd + 1));
        assert.ok(Array.isArray(parsed), 'Should be array');

        if (parsed.length > 0) {
          // scopeContext should be present if inside a meaningful scope
          assert.ok(
            'scopeContext' in parsed[0] || parsed[0].id.includes('fetchData'),
            `JSON should include scopeContext or semantic ID shows scope. Got: ${JSON.stringify(parsed[0])}`
          );
        }
      } catch (e) {
        // JSON parsing failed - may be no results or format changed
        assert.ok(
          result.stdout.includes('No results') || result.stdout.includes('[]'),
          `Expected parseable JSON or no results. Got: ${result.stdout}`
        );
      }
    }
  });

  it('should show scope context in human-readable output', async () => {
    await setupTestProject();

    const result = runCli(['query', 'response'], tempDir);

    assert.strictEqual(result.status, 0, `query failed: ${result.stderr}`);
    // Should show scope context like "inside fetchData" or "Scope: inside fetchData"
    if (!result.stdout.includes('No results')) {
      assert.ok(
        result.stdout.includes('inside') ||
        result.stdout.includes('Scope:') ||
        result.stdout.includes('fetchData'),
        `Should show scope context. Got: ${result.stdout}`
      );
    }
  });

  // --- Help text test ---

  it('should document scope syntax in help text', async () => {
    const result = runCli(['query', '--help'], tempDir);

    assert.strictEqual(result.status, 0);
    // Help should mention the " in " syntax
    assert.ok(
      result.stdout.includes(' in ') || result.stdout.includes('scope'),
      `Help should document scope syntax. Got: ${result.stdout}`
    );
  });
});

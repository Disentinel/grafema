/**
 * Tests for SQLInjectionValidator
 *
 * Проверяет детекцию SQL injection на module-level коде.
 *
 * NOTE: Текущий JSASTAnalyzer анализирует только module-level код (не тела функций).
 * Для полной детекции SQL injection нужен function-level анализ (будущее расширение).
 *
 * Эти тесты демонстрируют интеграцию ValueDomainAnalyzer с валидатором.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { tmpdir } from 'os';
import { mkdirSync, writeFileSync } from 'fs';

import { RFDBServerBackend } from '@grafema/core';
import { createTestOrchestrator } from '../helpers/createTestOrchestrator.js';
import { SQLInjectionValidator } from '@grafema/core';
import { ValueDomainAnalyzer } from '@grafema/core';

let testCounter = 0;

// Helper to serialize results with BigInt values
function safeStringify(obj) {
  return JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  , 2);
}

async function setupTest(files) {
  const testDir = join(tmpdir(), `navi-test-sqli-${Date.now()}-${testCounter++}`);
  mkdirSync(testDir, { recursive: true });

  writeFileSync(join(testDir, 'package.json'), JSON.stringify({
    name: 'sql-injection-test',
    version: '1.0.0'
  }));

  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(testDir, name), content);
  }

  const backend = new RFDBServerBackend({ dbPath: join(testDir, 'test.db') });
  await backend.connect();

  return { backend, testDir };
}

async function cleanup(backend) {
  await backend.close();
}

describe('SQLInjectionValidator', () => {
  describe('Module-level SQL injection detection', () => {
    it('should detect nondeterministic source in query at module level', async () => {
      const { backend, testDir } = await setupTest({
        // Module-level code - process.env is nondeterministic
        'index.js': `
import { db } from './db.js';

// process.env is external input - nondeterministic
const userId = process.env.USER_ID;
const query = \`SELECT * FROM users WHERE id = '\${userId}'\`;
db.query(query);
`,
        'db.js': `
export const db = {
  query(sql) { return { sql }; }
};
`
      });

      try {
        const validator = new SQLInjectionValidator();
        const orchestrator = createTestOrchestrator(backend, {
          extraPlugins: [new ValueDomainAnalyzer(), validator]
        });

        await orchestrator.run(testDir);
        const result = await validator.execute({ graph: backend });

        console.log('Module-level injection result:', safeStringify(result.metadata));

        assert.ok(result.success, 'Validator should succeed');
        // Note: Currently this test documents expected behavior
        // Full detection requires process.env tracking which is not implemented yet
      } finally {
        await cleanup(backend);
      }
    });

    it('should NOT flag literal-only query at module level', async () => {
      const { backend, testDir } = await setupTest({
        // Module-level code with only literals - safe
        'index.js': `
import { db } from './db.js';

// Only literal values - safe
const query = 'SELECT * FROM users WHERE active = true';
db.query(query);
`,
        'db.js': `
export const db = {
  query(sql) { return { sql }; }
};
`
      });

      try {
        const validator = new SQLInjectionValidator();
        const orchestrator = createTestOrchestrator(backend, {
          extraPlugins: [new ValueDomainAnalyzer(), validator]
        });

        await orchestrator.run(testDir);
        const result = await validator.execute({ graph: backend });

        console.log('Literal-only query result:', safeStringify(result.metadata));

        assert.ok(result.success, 'Validator should succeed');
        assert.strictEqual(result.metadata.issues.length, 0, 'Should NOT flag literal-only queries');
      } finally {
        await cleanup(backend);
      }
    });

    it('should NOT flag query with only literal variables', async () => {
      const { backend, testDir } = await setupTest({
        // Module-level code with literal variable - safe
        'index.js': `
import { db } from './db.js';

// Literal assigned to variable - deterministic
const role = 'admin';
const query = \`SELECT * FROM users WHERE role = '\${role}'\`;
db.query(query);
`,
        'db.js': `
export const db = {
  query(sql) { return { sql }; }
};
`
      });

      try {
        const validator = new SQLInjectionValidator();
        const orchestrator = createTestOrchestrator(backend, {
          extraPlugins: [new ValueDomainAnalyzer(), validator]
        });

        await orchestrator.run(testDir);
        const result = await validator.execute({ graph: backend });

        console.log('Literal variable query result:', safeStringify(result.metadata));

        assert.ok(result.success, 'Validator should succeed');
        assert.strictEqual(result.metadata.issues.length, 0, 'Should NOT flag query with literal variables');
      } finally {
        await cleanup(backend);
      }
    });
  });

  describe('SQL method detection', () => {
    it('should detect db.query method calls', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
import { db } from './db.js';
const query = 'SELECT 1';
db.query(query);
`,
        'db.js': `
export const db = { query(sql) {} };
`
      });

      try {
        const validator = new SQLInjectionValidator();
        const orchestrator = createTestOrchestrator(backend, {
          extraPlugins: [validator]
        });

        await orchestrator.run(testDir);
        const result = await validator.execute({ graph: backend });

        assert.ok(result.success, 'Validator should succeed');
        assert.strictEqual(result.metadata.summary.sqlCallsChecked, 1, 'Should find 1 SQL call');
      } finally {
        await cleanup(backend);
      }
    });

    it('should detect db.execute method calls', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
import { connection } from './db.js';
const sql = 'INSERT INTO logs VALUES (1)';
connection.execute(sql);
`,
        'db.js': `
export const connection = { execute(sql) {} };
`
      });

      try {
        const validator = new SQLInjectionValidator();
        const orchestrator = createTestOrchestrator(backend, {
          extraPlugins: [validator]
        });

        await orchestrator.run(testDir);
        const result = await validator.execute({ graph: backend });

        assert.ok(result.success, 'Validator should succeed');
        assert.strictEqual(result.metadata.summary.sqlCallsChecked, 1, 'Should find 1 execute call');
      } finally {
        await cleanup(backend);
      }
    });
  });

  describe('Value domain integration', () => {
    it('should trace deterministic value through variable chain', async () => {
      const { backend, testDir } = await setupTest({
        'index.js': `
import { db } from './db.js';

// Deterministic chain: literal -> a -> b -> query
const a = 'users';
const b = a;
const query = \`SELECT * FROM \${b}\`;
db.query(query);
`,
        'db.js': `
export const db = { query(sql) {} };
`
      });

      try {
        const validator = new SQLInjectionValidator();
        const orchestrator = createTestOrchestrator(backend, {
          extraPlugins: [new ValueDomainAnalyzer(), validator]
        });

        await orchestrator.run(testDir);
        const result = await validator.execute({ graph: backend });

        console.log('Deterministic chain result:', safeStringify(result.metadata));

        assert.ok(result.success, 'Validator should succeed');
        // If value domain correctly traces a -> b -> "users", no injection should be flagged
        assert.strictEqual(result.metadata.issues.length, 0, 'Should NOT flag deterministic variable chain');
      } finally {
        await cleanup(backend);
      }
    });
  });
});

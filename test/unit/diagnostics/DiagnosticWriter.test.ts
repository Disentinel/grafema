/**
 * DiagnosticWriter Tests
 *
 * Tests for DiagnosticWriter class.
 * Based on specification: _tasks/2026-01-23-reg-78-error-handling-diagnostics/003-joel-tech-plan.md
 *
 * Tests:
 * - write() creates .grafema/diagnostics.log
 * - JSON lines format (one diagnostic per line)
 * - Creates directory if it doesn't exist
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { DiagnosticCollector, DiagnosticWriter } from '@grafema/core';
import type { Diagnostic } from '@grafema/core';
import type { PluginPhase } from '@grafema/types';

// =============================================================================
// Helper to create collector with diagnostics
// =============================================================================

/**
 * Create a DiagnosticCollector pre-populated with diagnostics
 */
function createCollectorWithDiagnostics(diagnostics: Omit<Diagnostic, 'timestamp'>[]): DiagnosticCollector {
  const collector = new DiagnosticCollector();
  for (const diag of diagnostics) {
    collector.add(diag);
  }
  return collector;
}

// =============================================================================
// Test Helpers
// =============================================================================

function createDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    code: 'ERR_TEST',
    severity: 'error',
    message: 'Test error message',
    phase: 'INDEXING',
    plugin: 'TestPlugin',
    timestamp: Date.now(),
    ...overrides,
  };
}

function createTempDir(): string {
  const dir = join(tmpdir(), `grafema-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupTempDir(dir: string): void {
  try {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
}

// =============================================================================
// TESTS: DiagnosticWriter
// =============================================================================

describe('DiagnosticWriter', () => {
  let tempDir: string;
  let writer: DiagnosticWriter;

  beforeEach(() => {
    tempDir = createTempDir();
    writer = new DiagnosticWriter();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  // ===========================================================================
  // TESTS: write()
  // ===========================================================================

  describe('write()', () => {
    it('should create diagnostics.log file', async () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'ERR_TEST' }),
      ]);

      const grafemaDir = join(tempDir, '.grafema');

      await writer.write(collector, grafemaDir);

      const logPath = join(grafemaDir, 'diagnostics.log');
      assert.ok(existsSync(logPath), 'diagnostics.log should exist');
    });

    it('should create directory if it does not exist', async () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'ERR_TEST' }),
      ]);

      const grafemaDir = join(tempDir, 'nested', 'path', '.grafema');
      assert.ok(!existsSync(grafemaDir), 'Directory should not exist initially');

      await writer.write(collector, grafemaDir);

      assert.ok(existsSync(grafemaDir), 'Directory should be created');
    });

    it('should write JSON lines format', async () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'ERR_1', message: 'First error' }),
        createDiagnostic({ code: 'ERR_2', message: 'Second error' }),
      ]);

      const grafemaDir = join(tempDir, '.grafema');
      await writer.write(collector, grafemaDir);

      const logPath = join(grafemaDir, 'diagnostics.log');
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      assert.strictEqual(lines.length, 2, 'Should have 2 lines');

      // Each line should be valid JSON
      for (const line of lines) {
        assert.doesNotThrow(() => JSON.parse(line), `Line should be valid JSON: ${line}`);
      }
    });

    it('should include all diagnostic fields in JSON', async () => {
      const diag = createDiagnostic({
        code: 'ERR_PARSE_FAILURE',
        severity: 'warning',
        message: 'Parse failed',
        file: 'src/app.js',
        line: 42,
        phase: 'INDEXING',
        plugin: 'JSModuleIndexer',
        suggestion: 'Fix syntax error',
        timestamp: 1704067200000,
      });
      const collector = createCollectorWithDiagnostics([diag]);

      const grafemaDir = join(tempDir, '.grafema');
      await writer.write(collector, grafemaDir);

      const logPath = join(grafemaDir, 'diagnostics.log');
      const content = readFileSync(logPath, 'utf-8');
      const parsed = JSON.parse(content.trim());

      assert.strictEqual(parsed.code, 'ERR_PARSE_FAILURE');
      assert.strictEqual(parsed.severity, 'warning');
      assert.strictEqual(parsed.message, 'Parse failed');
      assert.strictEqual(parsed.file, 'src/app.js');
      assert.strictEqual(parsed.line, 42);
      assert.strictEqual(parsed.phase, 'INDEXING');
      assert.strictEqual(parsed.plugin, 'JSModuleIndexer');
      assert.strictEqual(parsed.suggestion, 'Fix syntax error');
      assert.ok(typeof parsed.timestamp === 'number', 'Timestamp should be a number');
    });

    it('should handle empty diagnostics', async () => {
      const collector = createCollectorWithDiagnostics([]);

      const grafemaDir = join(tempDir, '.grafema');
      await writer.write(collector, grafemaDir);

      const logPath = join(grafemaDir, 'diagnostics.log');
      assert.ok(existsSync(logPath), 'File should be created even if empty');

      const content = readFileSync(logPath, 'utf-8');
      assert.strictEqual(content.trim(), '', 'Content should be empty');
    });

    it('should overwrite existing file', async () => {
      const grafemaDir = join(tempDir, '.grafema');
      mkdirSync(grafemaDir, { recursive: true });

      const logPath = join(grafemaDir, 'diagnostics.log');
      writeFileSync(logPath, 'old content\n', 'utf-8');

      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'NEW_ERROR' }),
      ]);

      await writer.write(collector, grafemaDir);

      const content = readFileSync(logPath, 'utf-8');
      assert.ok(!content.includes('old content'), 'Should overwrite old content');
      assert.ok(content.includes('NEW_ERROR'), 'Should have new content');
    });

    it('should handle many diagnostics', async () => {
      const diagnostics: Omit<Diagnostic, 'timestamp'>[] = [];
      for (let i = 0; i < 100; i++) {
        diagnostics.push({
          code: `ERR_${i}`,
          severity: 'error',
          message: `Error number ${i}`,
          phase: 'INDEXING',
          plugin: 'TestPlugin',
        });
      }
      const collector = createCollectorWithDiagnostics(diagnostics);

      const grafemaDir = join(tempDir, '.grafema');
      await writer.write(collector, grafemaDir);

      const logPath = join(grafemaDir, 'diagnostics.log');
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      assert.strictEqual(lines.length, 100, 'Should have 100 lines');
    });

    it('should handle special characters in messages', async () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          message: 'Error with "quotes", \\ backslashes, and \n newlines',
          file: '/path/with spaces/file.js',
        }),
      ]);

      const grafemaDir = join(tempDir, '.grafema');
      await writer.write(collector, grafemaDir);

      const logPath = join(grafemaDir, 'diagnostics.log');
      const content = readFileSync(logPath, 'utf-8');

      // Should be valid JSON (special chars properly escaped)
      assert.doesNotThrow(() => JSON.parse(content.trim()));

      const parsed = JSON.parse(content.trim());
      assert.ok(parsed.message.includes('quotes'));
      assert.ok(parsed.file.includes('spaces'));
    });

    it('should handle unicode in messages', async () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          message: 'Error: \u041e\u0448\u0438\u0431\u043a\u0430 \u0432 \u0444\u0430\u0439\u043b\u0435',
          file: 'src/\u043a\u043e\u043c\u043f\u043e\u043d\u0435\u043d\u0442.js',
        }),
      ]);

      const grafemaDir = join(tempDir, '.grafema');
      await writer.write(collector, grafemaDir);

      const logPath = join(grafemaDir, 'diagnostics.log');
      const content = readFileSync(logPath, 'utf-8');

      assert.doesNotThrow(() => JSON.parse(content.trim()));

      const parsed = JSON.parse(content.trim());
      assert.ok(parsed.message.includes('\u041e\u0448\u0438\u0431\u043a\u0430'));
    });
  });

  // ===========================================================================
  // TESTS: getLogPath()
  // ===========================================================================

  describe('getLogPath()', () => {
    it('should return path to diagnostics.log', () => {
      const logPath = writer.getLogPath('/project/.grafema');

      assert.ok(logPath.endsWith('diagnostics.log'));
      assert.ok(logPath.includes('.grafema'));
    });

    it('should join paths correctly', () => {
      const logPath = writer.getLogPath('/project/.grafema');

      assert.strictEqual(logPath, '/project/.grafema/diagnostics.log');
    });

    it('should handle paths with trailing slash', () => {
      const logPath1 = writer.getLogPath('/project/.grafema');
      const logPath2 = writer.getLogPath('/project/.grafema/');

      // Both should produce valid paths
      assert.ok(logPath1.includes('diagnostics.log'));
      assert.ok(logPath2.includes('diagnostics.log'));
    });
  });

  // ===========================================================================
  // TESTS: Error handling
  // ===========================================================================

  describe('error handling', () => {
    it('should handle permission errors gracefully', async () => {
      // This test is platform-dependent and may not work on all systems
      // Skip if running as root or on Windows
      if (process.platform === 'win32' || process.getuid?.() === 0) {
        return;
      }

      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'ERR_TEST' }),
      ]);

      // Try to write to a read-only location (may fail)
      const readOnlyDir = '/usr/local/.grafema-test-readonly';

      try {
        await writer.write(collector, readOnlyDir);
        // If it succeeds (unlikely), clean up
        cleanupTempDir(readOnlyDir);
        assert.fail('Should have thrown permission error');
      } catch (error) {
        // Expected - permission denied
        assert.ok(error instanceof Error);
      }
    });
  });

  // ===========================================================================
  // TESTS: One diagnostic per line
  // ===========================================================================

  describe('JSON lines format', () => {
    it('should write one diagnostic per line', async () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'ERR_1' }),
        createDiagnostic({ code: 'ERR_2' }),
        createDiagnostic({ code: 'ERR_3' }),
      ]);

      const grafemaDir = join(tempDir, '.grafema');
      await writer.write(collector, grafemaDir);

      const logPath = join(grafemaDir, 'diagnostics.log');
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      assert.strictEqual(lines.length, 3, 'Each diagnostic should be on its own line');

      // Verify each line is independent JSON
      assert.strictEqual(JSON.parse(lines[0]).code, 'ERR_1');
      assert.strictEqual(JSON.parse(lines[1]).code, 'ERR_2');
      assert.strictEqual(JSON.parse(lines[2]).code, 'ERR_3');
    });

    it('should not wrap in array (not JSON array format)', async () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'ERR_1' }),
        createDiagnostic({ code: 'ERR_2' }),
      ]);

      const grafemaDir = join(tempDir, '.grafema');
      await writer.write(collector, grafemaDir);

      const logPath = join(grafemaDir, 'diagnostics.log');
      const content = readFileSync(logPath, 'utf-8');

      // Should NOT be a JSON array
      assert.ok(!content.trim().startsWith('['), 'Should not be JSON array');
      assert.ok(!content.trim().endsWith(']'), 'Should not be JSON array');
    });

    it('should preserve diagnostic order', async () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'FIRST', timestamp: 1000 }),
        createDiagnostic({ code: 'SECOND', timestamp: 2000 }),
        createDiagnostic({ code: 'THIRD', timestamp: 3000 }),
      ]);

      const grafemaDir = join(tempDir, '.grafema');
      await writer.write(collector, grafemaDir);

      const logPath = join(grafemaDir, 'diagnostics.log');
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      assert.strictEqual(JSON.parse(lines[0]).code, 'FIRST');
      assert.strictEqual(JSON.parse(lines[1]).code, 'SECOND');
      assert.strictEqual(JSON.parse(lines[2]).code, 'THIRD');
    });
  });

  // ===========================================================================
  // TESTS: Real-world scenarios
  // ===========================================================================

  describe('real-world scenarios', () => {
    it('should write typical analysis diagnostics', async () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({
          code: 'ERR_PARSE_FAILURE',
          severity: 'warning',
          message: 'Syntax error in file',
          file: 'src/components/Button.jsx',
          line: 15,
          plugin: 'JSModuleIndexer',
          phase: 'INDEXING',
          suggestion: 'Check JSX syntax',
        }),
        createDiagnostic({
          code: 'ERR_FILE_UNREADABLE',
          severity: 'error',
          message: 'Permission denied',
          file: 'src/secrets.json',
          plugin: 'FileReader',
          phase: 'DISCOVERY',
          suggestion: 'Check file permissions',
        }),
        createDiagnostic({
          code: 'ERR_DATABASE_LOCKED',
          severity: 'fatal',
          message: 'Database is locked',
          plugin: 'RFDBPlugin',
          phase: 'INDEXING',
          suggestion: 'Close other Grafema instances',
        }),
      ]);

      const grafemaDir = join(tempDir, '.grafema');
      await writer.write(collector, grafemaDir);

      const logPath = join(grafemaDir, 'diagnostics.log');
      const content = readFileSync(logPath, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim());

      // Verify all diagnostics are written
      assert.strictEqual(lines.length, 3);

      // Verify structure of each
      for (const line of lines) {
        const parsed = JSON.parse(line);
        assert.ok(parsed.code);
        assert.ok(parsed.severity);
        assert.ok(parsed.message);
        assert.ok(parsed.plugin);
        assert.ok(parsed.phase);
        assert.ok(typeof parsed.timestamp === 'number');
      }
    });

    it('should be readable by simple line-by-line parsing', async () => {
      const collector = createCollectorWithDiagnostics([
        createDiagnostic({ code: 'ERR_1' }),
        createDiagnostic({ code: 'ERR_2' }),
      ]);

      const grafemaDir = join(tempDir, '.grafema');
      await writer.write(collector, grafemaDir);

      const logPath = join(grafemaDir, 'diagnostics.log');
      const content = readFileSync(logPath, 'utf-8');

      // Simulate reading line by line (as a tool would)
      const diagnostics: Diagnostic[] = [];
      for (const line of content.split('\n')) {
        if (line.trim()) {
          diagnostics.push(JSON.parse(line));
        }
      }

      assert.strictEqual(diagnostics.length, 2);
      assert.strictEqual(diagnostics[0].code, 'ERR_1');
      assert.strictEqual(diagnostics[1].code, 'ERR_2');
    });
  });
});

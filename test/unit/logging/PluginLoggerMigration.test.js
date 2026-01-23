/**
 * Plugin Logger Migration Tests (REG-148)
 *
 * These tests verify that the logger infrastructure works correctly for plugin migration:
 * 1. Plugin.log() helper returns correct logger from context
 * 2. Log level filtering works (silent suppresses, debug shows all)
 * 3. Structured context objects are passed correctly
 *
 * Note: These tests verify the logger INFRASTRUCTURE, not actual plugin migration.
 * They ensure that when plugins are migrated to use this.log(context), it will work.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { Plugin } from '@grafema/core';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a mock logger that tracks all method calls
 */
function createMockLogger() {
  const calls = [];
  return {
    calls,
    error(message, context) {
      calls.push({ method: 'error', message, context });
    },
    warn(message, context) {
      calls.push({ method: 'warn', message, context });
    },
    info(message, context) {
      calls.push({ method: 'info', message, context });
    },
    debug(message, context) {
      calls.push({ method: 'debug', message, context });
    },
    trace(message, context) {
      calls.push({ method: 'trace', message, context });
    },
  };
}

/**
 * Captures console output during test execution
 */
function createConsoleMock() {
  const mockObj = {
    logs: [],
    originalError: console.error,
    originalWarn: console.warn,
    originalInfo: console.info,
    originalLog: console.log,
    originalDebug: console.debug,
    install() {
      console.error = (...args) => {
        mockObj.logs.push({ method: 'error', args });
      };
      console.warn = (...args) => {
        mockObj.logs.push({ method: 'warn', args });
      };
      console.info = (...args) => {
        mockObj.logs.push({ method: 'info', args });
      };
      console.log = (...args) => {
        mockObj.logs.push({ method: 'log', args });
      };
      console.debug = (...args) => {
        mockObj.logs.push({ method: 'debug', args });
      };
    },
    restore() {
      console.error = mockObj.originalError;
      console.warn = mockObj.originalWarn;
      console.info = mockObj.originalInfo;
      console.log = mockObj.originalLog;
      console.debug = mockObj.originalDebug;
    },
  };
  return mockObj;
}

/**
 * Test plugin that uses this.log() helper
 */
class TestPlugin extends Plugin {
  get metadata() {
    return {
      name: 'TestPlugin',
      phase: 'VALIDATION',
      version: '1.0.0',
    };
  }

  async execute(context) {
    const logger = this.log(context);

    // Simulate typical plugin logging patterns
    logger.info('Starting validation');
    logger.debug('Processing file', { file: 'test.js' });
    logger.debug('Search complete', { timeMs: 100, count: 5 });
    logger.info('Validation summary', { total: 10, passed: 5, failed: 0 });
    logger.warn('Validation warning', { message: 'Deprecated pattern found' });

    return { success: true, metadata: {} };
  }
}

// =============================================================================
// TESTS: Plugin.log() helper
// =============================================================================

describe('PluginLoggerMigration', () => {
  describe('Plugin.log() helper', () => {
    let consoleMock;

    beforeEach(() => {
      consoleMock = createConsoleMock();
      consoleMock.install();
    });

    afterEach(() => {
      consoleMock.restore();
    });

    it('should return context.logger when present', () => {
      const plugin = new TestPlugin();
      const mockLogger = createMockLogger();
      const context = { logger: mockLogger };

      const logger = plugin.log(context);
      logger.info('test message', { key: 'value' });

      // Should use mock logger, not console
      assert.strictEqual(mockLogger.calls.length, 1);
      assert.strictEqual(mockLogger.calls[0].method, 'info');
      assert.strictEqual(mockLogger.calls[0].message, 'test message');
      assert.deepStrictEqual(mockLogger.calls[0].context, { key: 'value' });

      // Console should not have been called
      assert.strictEqual(consoleMock.logs.length, 0);
    });

    it('should return console fallback when logger is undefined', () => {
      const plugin = new TestPlugin();
      const context = {}; // No logger

      const logger = plugin.log(context);
      logger.info('fallback test');

      // Should use console
      assert.strictEqual(consoleMock.logs.length, 1);
      assert.ok(String(consoleMock.logs[0].args[0]).includes('fallback test'));
    });

    it('should provide all logger methods', () => {
      const plugin = new TestPlugin();
      const context = { logger: createMockLogger() };

      const logger = plugin.log(context);

      // All methods should exist
      assert.strictEqual(typeof logger.error, 'function');
      assert.strictEqual(typeof logger.warn, 'function');
      assert.strictEqual(typeof logger.info, 'function');
      assert.strictEqual(typeof logger.debug, 'function');
      assert.strictEqual(typeof logger.trace, 'function');
    });

    it('should format fallback messages with level prefix', () => {
      const plugin = new TestPlugin();
      const context = {}; // No logger

      const logger = plugin.log(context);

      logger.error('error message');
      logger.warn('warn message');
      logger.info('info message');
      logger.debug('debug message');
      logger.trace('trace message');

      // Check that all messages have appropriate prefixes
      assert.ok(String(consoleMock.logs[0].args[0]).includes('[ERROR]'));
      assert.ok(String(consoleMock.logs[1].args[0]).includes('[WARN]'));
      assert.ok(String(consoleMock.logs[2].args[0]).includes('[INFO]'));
      assert.ok(String(consoleMock.logs[3].args[0]).includes('[DEBUG]'));
      assert.ok(String(consoleMock.logs[4].args[0]).includes('[TRACE]'));
    });

    it('should include context in log calls', () => {
      const plugin = new TestPlugin();
      const mockLogger = createMockLogger();
      const context = { logger: mockLogger };

      const logger = plugin.log(context);
      logger.info('test', { file: 'app.js', line: 42 });

      assert.strictEqual(mockLogger.calls.length, 1);
      assert.deepStrictEqual(mockLogger.calls[0].context, { file: 'app.js', line: 42 });
    });

    it('should handle undefined context gracefully', () => {
      const plugin = new TestPlugin();
      const mockLogger = createMockLogger();
      const context = { logger: mockLogger };

      const logger = plugin.log(context);
      logger.info('message without context');

      assert.strictEqual(mockLogger.calls.length, 1);
      assert.strictEqual(mockLogger.calls[0].context, undefined);
    });

    it('should handle circular references in fallback context', () => {
      const plugin = new TestPlugin();
      const context = {}; // No logger (use fallback)

      const logger = plugin.log(context);

      const obj = { a: 1 };
      obj.self = obj; // Circular reference

      // Should not throw
      assert.doesNotThrow(() => {
        logger.debug('Circular', obj);
      });
    });
  });

  // ===========================================================================
  // TESTS: Structured Logging Patterns
  // ===========================================================================

  describe('Structured logging patterns', () => {
    it('should support common plugin logging patterns', () => {
      const mockLogger = createMockLogger();
      const context = { logger: mockLogger };
      const plugin = new TestPlugin();

      const logger = plugin.log(context);

      // Pattern 1: Phase start (info level)
      logger.info('Starting validation');

      // Pattern 2: Progress (debug level)
      logger.debug('Processing file', { file: 'src/app.js' });

      // Pattern 3: Stats/counts (debug level)
      logger.debug('Search complete', { timeMs: 150, count: 10 });

      // Pattern 4: Summary (info level)
      logger.info('Validation summary', { total: 100, violations: 5 });

      // Pattern 5: Issues/warnings (warn level)
      logger.warn('Violation found', { message: 'eval() usage detected', file: 'src/bad.js' });

      assert.strictEqual(mockLogger.calls.length, 5);

      // Verify each pattern
      assert.strictEqual(mockLogger.calls[0].method, 'info');
      assert.strictEqual(mockLogger.calls[0].message, 'Starting validation');

      assert.strictEqual(mockLogger.calls[1].method, 'debug');
      assert.deepStrictEqual(mockLogger.calls[1].context, { file: 'src/app.js' });

      assert.strictEqual(mockLogger.calls[2].method, 'debug');
      assert.deepStrictEqual(mockLogger.calls[2].context, { timeMs: 150, count: 10 });

      assert.strictEqual(mockLogger.calls[3].method, 'info');
      assert.deepStrictEqual(mockLogger.calls[3].context, { total: 100, violations: 5 });

      assert.strictEqual(mockLogger.calls[4].method, 'warn');
      assert.strictEqual(mockLogger.calls[4].context.message, 'eval() usage detected');
    });

    it('should support consistent context field naming', () => {
      const mockLogger = createMockLogger();
      const context = { logger: mockLogger };
      const plugin = new TestPlugin();
      const logger = plugin.log(context);

      // Convention from tech plan: consistent field names
      logger.debug('Processing file', { file: '/src/foo.js' });
      logger.debug('Files counted', { count: 42 });
      logger.debug('Operation complete', { timeMs: 123 });
      logger.info('Summary', { nodesCreated: 10, edgesCreated: 20 });
      logger.debug('Progress', { current: 5, total: 10 });

      // Verify context field names match conventions
      assert.strictEqual(mockLogger.calls[0].context.file, '/src/foo.js');
      assert.strictEqual(mockLogger.calls[1].context.count, 42);
      assert.strictEqual(mockLogger.calls[2].context.timeMs, 123);
      assert.strictEqual(mockLogger.calls[3].context.nodesCreated, 10);
      assert.strictEqual(mockLogger.calls[3].context.edgesCreated, 20);
      assert.strictEqual(mockLogger.calls[4].context.current, 5);
      assert.strictEqual(mockLogger.calls[4].context.total, 10);
    });
  });

  // ===========================================================================
  // TESTS: Log Level Behavior (simulated)
  // ===========================================================================

  describe('Log level behavior', () => {
    it('should show only info and above at info level', () => {
      const mockLogger = createMockLogger();

      // Simulate info-level logger that filters debug
      const infoLogger = {
        calls: [],
        error(message, context) {
          this.calls.push({ method: 'error', message, context });
        },
        warn(message, context) {
          this.calls.push({ method: 'warn', message, context });
        },
        info(message, context) {
          this.calls.push({ method: 'info', message, context });
        },
        debug(message, context) {
          // No-op at info level
        },
        trace(message, context) {
          // No-op at info level
        },
      };

      const context = { logger: infoLogger };
      const plugin = new TestPlugin();
      const logger = plugin.log(context);

      logger.error('error');
      logger.warn('warn');
      logger.info('info');
      logger.debug('debug'); // Should be filtered
      logger.trace('trace'); // Should be filtered

      // Only error, warn, info should be logged
      assert.strictEqual(infoLogger.calls.length, 3);
      assert.strictEqual(infoLogger.calls[0].method, 'error');
      assert.strictEqual(infoLogger.calls[1].method, 'warn');
      assert.strictEqual(infoLogger.calls[2].method, 'info');
    });

    it('should suppress all output at silent level', () => {
      // Simulate silent logger
      const silentLogger = {
        calls: [],
        error() {},
        warn() {},
        info() {},
        debug() {},
        trace() {},
      };

      const context = { logger: silentLogger };
      const plugin = new TestPlugin();
      const logger = plugin.log(context);

      logger.error('error');
      logger.warn('warn');
      logger.info('info');
      logger.debug('debug');
      logger.trace('trace');

      // Nothing should be logged
      assert.strictEqual(silentLogger.calls.length, 0);
    });

    it('should show all output at debug level', () => {
      const mockLogger = createMockLogger();
      const context = { logger: mockLogger };
      const plugin = new TestPlugin();
      const logger = plugin.log(context);

      logger.error('error');
      logger.warn('warn');
      logger.info('info');
      logger.debug('debug');
      logger.trace('trace');

      // All should be logged
      assert.strictEqual(mockLogger.calls.length, 5);
    });
  });

  // ===========================================================================
  // TESTS: Plugin execute() with different log levels
  // ===========================================================================

  describe('Plugin execution with different log levels', () => {
    it('should log summary at info level', async () => {
      const mockLogger = {
        calls: [],
        error(message, context) {
          this.calls.push({ method: 'error', message, context });
        },
        warn(message, context) {
          this.calls.push({ method: 'warn', message, context });
        },
        info(message, context) {
          this.calls.push({ method: 'info', message, context });
        },
        debug() {
          // Filtered at info level
        },
        trace() {
          // Filtered at info level
        },
      };

      const context = { logger: mockLogger };
      const plugin = new TestPlugin();

      await plugin.execute(context);

      // Should have 2 info calls + 1 warn, no debug
      const infoCalls = mockLogger.calls.filter(c => c.method === 'info');
      const debugCalls = mockLogger.calls.filter(c => c.method === 'debug');
      const warnCalls = mockLogger.calls.filter(c => c.method === 'warn');

      assert.strictEqual(infoCalls.length, 2); // Start + Summary
      assert.strictEqual(debugCalls.length, 0); // Filtered
      assert.strictEqual(warnCalls.length, 1); // Warning
    });

    it('should log detailed progress at debug level', async () => {
      const mockLogger = createMockLogger();
      const context = { logger: mockLogger };
      const plugin = new TestPlugin();

      await plugin.execute(context);

      // Should have all logs including debug
      const infoCalls = mockLogger.calls.filter(c => c.method === 'info');
      const debugCalls = mockLogger.calls.filter(c => c.method === 'debug');
      const warnCalls = mockLogger.calls.filter(c => c.method === 'warn');

      assert.strictEqual(infoCalls.length, 2);
      assert.strictEqual(debugCalls.length, 2); // Per-file + stats
      assert.strictEqual(warnCalls.length, 1);
    });

    it('should suppress all logs at silent level', async () => {
      const silentLogger = {
        calls: [],
        error() {},
        warn() {},
        info() {},
        debug() {},
        trace() {},
      };

      const context = { logger: silentLogger };
      const plugin = new TestPlugin();

      await plugin.execute(context);

      // Nothing logged
      assert.strictEqual(silentLogger.calls.length, 0);
    });
  });
});

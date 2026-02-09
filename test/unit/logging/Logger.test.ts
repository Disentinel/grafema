/**
 * Logger Tests
 *
 * Tests for ConsoleLogger and createLogger factory.
 * Based on specification: _tasks/2026-01-23-reg-78-error-handling-diagnostics/003-joel-tech-plan.md
 *
 * Tests:
 * - Respects logLevel threshold (silent, errors, warnings, info, debug)
 * - Each method (error, warn, info, debug, trace) works
 * - Context is formatted correctly
 * - Methods are no-ops when below threshold
 * - createLogger() factory function works
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ConsoleLogger,
  FileLogger,
  MultiLogger,
  createLogger,
  type Logger,
  type LogLevel,
} from '@grafema/core';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Captures console output during test execution
 */
interface ConsoleMock {
  logs: { method: string; args: unknown[] }[];
  originalError: typeof console.error;
  originalWarn: typeof console.warn;
  originalInfo: typeof console.info;
  originalLog: typeof console.log;
  originalDebug: typeof console.debug;
  install: () => void;
  restore: () => void;
}

function createConsoleMock(): ConsoleMock {
  const mockObj: ConsoleMock = {
    logs: [],
    originalError: console.error,
    originalWarn: console.warn,
    originalInfo: console.info,
    originalLog: console.log,
    originalDebug: console.debug,
    install() {
      console.error = (...args: unknown[]) => {
        mockObj.logs.push({ method: 'error', args });
      };
      console.warn = (...args: unknown[]) => {
        mockObj.logs.push({ method: 'warn', args });
      };
      console.info = (...args: unknown[]) => {
        mockObj.logs.push({ method: 'info', args });
      };
      console.log = (...args: unknown[]) => {
        mockObj.logs.push({ method: 'log', args });
      };
      console.debug = (...args: unknown[]) => {
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

// =============================================================================
// TESTS: Logger Interface
// =============================================================================

describe('Logger', () => {
  describe('Logger interface', () => {
    it('should define error method', () => {
      const logger = createLogger('info');
      assert.strictEqual(typeof logger.error, 'function');
    });

    it('should define warn method', () => {
      const logger = createLogger('info');
      assert.strictEqual(typeof logger.warn, 'function');
    });

    it('should define info method', () => {
      const logger = createLogger('info');
      assert.strictEqual(typeof logger.info, 'function');
    });

    it('should define debug method', () => {
      const logger = createLogger('info');
      assert.strictEqual(typeof logger.debug, 'function');
    });

    it('should define trace method', () => {
      const logger = createLogger('info');
      assert.strictEqual(typeof logger.trace, 'function');
    });
  });

  // ===========================================================================
  // TESTS: ConsoleLogger
  // ===========================================================================

  describe('ConsoleLogger', () => {
    let consoleMock: ConsoleMock;

    beforeEach(() => {
      consoleMock = createConsoleMock();
      consoleMock.install();
    });

    afterEach(() => {
      consoleMock.restore();
    });

    describe('constructor', () => {
      it('should create logger with default level', () => {
        const logger = new ConsoleLogger();
        // Default should be 'info'
        assert.ok(logger instanceof ConsoleLogger);
      });

      it('should create logger with specified level', () => {
        const logger = new ConsoleLogger('debug');
        assert.ok(logger instanceof ConsoleLogger);
      });

      it('should accept all valid log levels', () => {
        const levels: LogLevel[] = ['silent', 'errors', 'warnings', 'info', 'debug'];
        for (const level of levels) {
          const logger = new ConsoleLogger(level);
          assert.ok(logger instanceof ConsoleLogger, `Should accept level: ${level}`);
        }
      });
    });

    describe('error()', () => {
      it('should log error messages', () => {
        const logger = new ConsoleLogger('errors');
        logger.error('Something went wrong');

        assert.strictEqual(consoleMock.logs.length, 1);
        assert.strictEqual(consoleMock.logs[0].method, 'error');
        assert.ok(
          String(consoleMock.logs[0].args[0]).includes('Something went wrong'),
          'Should include message'
        );
      });

      it('should include context in output', () => {
        const logger = new ConsoleLogger('errors');
        logger.error('Error occurred', { filePath: 'src/app.js', line: 42 });

        assert.strictEqual(consoleMock.logs.length, 1);
        const output = String(consoleMock.logs[0].args[0]);
        assert.ok(output.includes('Error occurred'), 'Should include message');
        // Context should be formatted (as JSON or key=value)
      });

      it('should work at all log levels except silent', () => {
        const levels: LogLevel[] = ['errors', 'warnings', 'info', 'debug'];
        for (const level of levels) {
          consoleMock.logs = [];
          const logger = new ConsoleLogger(level);
          logger.error('Test error');
          assert.strictEqual(consoleMock.logs.length, 1, `error() should work at ${level} level`);
        }
      });

      it('should be no-op at silent level', () => {
        const logger = new ConsoleLogger('silent');
        logger.error('This should not appear');
        assert.strictEqual(consoleMock.logs.length, 0);
      });
    });

    describe('warn()', () => {
      it('should log warning messages', () => {
        const logger = new ConsoleLogger('warnings');
        logger.warn('Warning: deprecated API');

        assert.strictEqual(consoleMock.logs.length, 1);
        assert.strictEqual(consoleMock.logs[0].method, 'warn');
        assert.ok(
          String(consoleMock.logs[0].args[0]).includes('deprecated API'),
          'Should include message'
        );
      });

      it('should include context in output', () => {
        const logger = new ConsoleLogger('warnings');
        logger.warn('Deprecated', { feature: 'oldMethod', replacement: 'newMethod' });

        assert.strictEqual(consoleMock.logs.length, 1);
      });

      it('should work at warnings, info, debug levels', () => {
        const levels: LogLevel[] = ['warnings', 'info', 'debug'];
        for (const level of levels) {
          consoleMock.logs = [];
          const logger = new ConsoleLogger(level);
          logger.warn('Test warning');
          assert.strictEqual(consoleMock.logs.length, 1, `warn() should work at ${level} level`);
        }
      });

      it('should be no-op at silent and errors levels', () => {
        const silentLevels: LogLevel[] = ['silent', 'errors'];
        for (const level of silentLevels) {
          consoleMock.logs = [];
          const logger = new ConsoleLogger(level);
          logger.warn('This should not appear');
          assert.strictEqual(consoleMock.logs.length, 0, `warn() should be no-op at ${level} level`);
        }
      });
    });

    describe('info()', () => {
      it('should log info messages', () => {
        const logger = new ConsoleLogger('info');
        logger.info('Processing files');

        assert.strictEqual(consoleMock.logs.length, 1);
        assert.ok(
          String(consoleMock.logs[0].args[0]).includes('Processing files'),
          'Should include message'
        );
      });

      it('should include context in output', () => {
        const logger = new ConsoleLogger('info');
        logger.info('Indexing', { files: 150, elapsed: '2.5s' });

        assert.strictEqual(consoleMock.logs.length, 1);
      });

      it('should work at info and debug levels', () => {
        const levels: LogLevel[] = ['info', 'debug'];
        for (const level of levels) {
          consoleMock.logs = [];
          const logger = new ConsoleLogger(level);
          logger.info('Test info');
          assert.strictEqual(consoleMock.logs.length, 1, `info() should work at ${level} level`);
        }
      });

      it('should be no-op at silent, errors, warnings levels', () => {
        const silentLevels: LogLevel[] = ['silent', 'errors', 'warnings'];
        for (const level of silentLevels) {
          consoleMock.logs = [];
          const logger = new ConsoleLogger(level);
          logger.info('This should not appear');
          assert.strictEqual(consoleMock.logs.length, 0, `info() should be no-op at ${level} level`);
        }
      });
    });

    describe('debug()', () => {
      it('should log debug messages', () => {
        const logger = new ConsoleLogger('debug');
        logger.debug('Debug info');

        assert.strictEqual(consoleMock.logs.length, 1);
        assert.ok(
          String(consoleMock.logs[0].args[0]).includes('Debug info'),
          'Should include message'
        );
      });

      it('should include context in output', () => {
        const logger = new ConsoleLogger('debug');
        logger.debug('Variable state', { x: 10, y: 20, result: 'computed' });

        assert.strictEqual(consoleMock.logs.length, 1);
      });

      it('should work only at debug level', () => {
        consoleMock.logs = [];
        const logger = new ConsoleLogger('debug');
        logger.debug('Test debug');
        assert.strictEqual(consoleMock.logs.length, 1);
      });

      it('should be no-op at silent, errors, warnings, info levels', () => {
        const silentLevels: LogLevel[] = ['silent', 'errors', 'warnings', 'info'];
        for (const level of silentLevels) {
          consoleMock.logs = [];
          const logger = new ConsoleLogger(level);
          logger.debug('This should not appear');
          assert.strictEqual(consoleMock.logs.length, 0, `debug() should be no-op at ${level} level`);
        }
      });
    });

    describe('trace()', () => {
      it('should log trace messages', () => {
        const logger = new ConsoleLogger('debug');
        logger.trace('Entering function');

        assert.strictEqual(consoleMock.logs.length, 1);
        assert.ok(
          String(consoleMock.logs[0].args[0]).includes('Entering function'),
          'Should include message'
        );
      });

      it('should include context in output', () => {
        const logger = new ConsoleLogger('debug');
        logger.trace('Function call', { fn: 'processData', args: [1, 2, 3] });

        assert.strictEqual(consoleMock.logs.length, 1);
      });

      it('should work only at debug level', () => {
        consoleMock.logs = [];
        const logger = new ConsoleLogger('debug');
        logger.trace('Test trace');
        assert.strictEqual(consoleMock.logs.length, 1);
      });

      it('should be no-op at silent, errors, warnings, info levels', () => {
        const silentLevels: LogLevel[] = ['silent', 'errors', 'warnings', 'info'];
        for (const level of silentLevels) {
          consoleMock.logs = [];
          const logger = new ConsoleLogger(level);
          logger.trace('This should not appear');
          assert.strictEqual(consoleMock.logs.length, 0, `trace() should be no-op at ${level} level`);
        }
      });
    });

    // =========================================================================
    // TESTS: Log Level Threshold
    // =========================================================================

    describe('log level threshold', () => {
      it('silent: should suppress all output', () => {
        const logger = new ConsoleLogger('silent');

        logger.error('error');
        logger.warn('warn');
        logger.info('info');
        logger.debug('debug');
        logger.trace('trace');

        assert.strictEqual(consoleMock.logs.length, 0);
      });

      it('errors: should only show errors', () => {
        const logger = new ConsoleLogger('errors');

        logger.error('error');
        logger.warn('warn');
        logger.info('info');
        logger.debug('debug');
        logger.trace('trace');

        assert.strictEqual(consoleMock.logs.length, 1);
        assert.ok(String(consoleMock.logs[0].args[0]).includes('error'));
      });

      it('warnings: should show errors and warnings', () => {
        const logger = new ConsoleLogger('warnings');

        logger.error('error');
        logger.warn('warn');
        logger.info('info');
        logger.debug('debug');
        logger.trace('trace');

        assert.strictEqual(consoleMock.logs.length, 2);
      });

      it('info: should show errors, warnings, and info', () => {
        const logger = new ConsoleLogger('info');

        logger.error('error');
        logger.warn('warn');
        logger.info('info');
        logger.debug('debug');
        logger.trace('trace');

        assert.strictEqual(consoleMock.logs.length, 3);
      });

      it('debug: should show all messages', () => {
        const logger = new ConsoleLogger('debug');

        logger.error('error');
        logger.warn('warn');
        logger.info('info');
        logger.debug('debug');
        logger.trace('trace');

        assert.strictEqual(consoleMock.logs.length, 5);
      });
    });

    // =========================================================================
    // TESTS: Context Formatting
    // =========================================================================

    describe('context formatting', () => {
      it('should handle empty context', () => {
        const logger = new ConsoleLogger('info');
        logger.info('Message without context');

        assert.strictEqual(consoleMock.logs.length, 1);
      });

      it('should handle undefined context', () => {
        const logger = new ConsoleLogger('info');
        logger.info('Message', undefined);

        assert.strictEqual(consoleMock.logs.length, 1);
      });

      it('should handle complex nested context', () => {
        const logger = new ConsoleLogger('debug');
        logger.debug('Complex', {
          nested: {
            deep: {
              value: 42,
            },
          },
          array: [1, 2, 3],
        });

        assert.strictEqual(consoleMock.logs.length, 1);
      });

      it('should handle context with special characters', () => {
        const logger = new ConsoleLogger('info');
        logger.info('Special', {
          path: '/path/to/file with spaces.js',
          message: 'Contains "quotes" and \'apostrophes\'',
        });

        assert.strictEqual(consoleMock.logs.length, 1);
      });
    });

    // =========================================================================
    // TESTS: Error Handling in Logger
    // =========================================================================

    describe('error handling', () => {
      it('should not throw when logging', () => {
        const logger = new ConsoleLogger('info');

        assert.doesNotThrow(() => {
          logger.info('Normal message');
        });
      });

      it('should handle circular references in context gracefully', () => {
        const logger = new ConsoleLogger('debug');

        const obj: Record<string, unknown> = { a: 1 };
        obj.self = obj; // Circular reference

        // Should not throw
        assert.doesNotThrow(() => {
          logger.debug('Circular', obj);
        });
      });
    });
  });

  // ===========================================================================
  // TESTS: createLogger Factory
  // ===========================================================================

  describe('createLogger()', () => {
    let consoleMock: ConsoleMock;

    beforeEach(() => {
      consoleMock = createConsoleMock();
      consoleMock.install();
    });

    afterEach(() => {
      consoleMock.restore();
    });

    it('should create a Logger instance', () => {
      const logger = createLogger('info');
      assert.ok(logger, 'Should return a logger');
      assert.strictEqual(typeof logger.error, 'function');
      assert.strictEqual(typeof logger.warn, 'function');
      assert.strictEqual(typeof logger.info, 'function');
      assert.strictEqual(typeof logger.debug, 'function');
      assert.strictEqual(typeof logger.trace, 'function');
    });

    it('should create ConsoleLogger with specified level', () => {
      const logger = createLogger('debug');
      logger.debug('Test');
      assert.strictEqual(consoleMock.logs.length, 1);
    });

    it('should respect silent level', () => {
      const logger = createLogger('silent');
      logger.error('Should not appear');
      logger.warn('Should not appear');
      logger.info('Should not appear');
      logger.debug('Should not appear');
      logger.trace('Should not appear');
      assert.strictEqual(consoleMock.logs.length, 0);
    });

    it('should respect errors level', () => {
      const logger = createLogger('errors');
      logger.error('Error');
      logger.warn('Warning');
      assert.strictEqual(consoleMock.logs.length, 1);
    });

    it('should respect warnings level', () => {
      const logger = createLogger('warnings');
      logger.error('Error');
      logger.warn('Warning');
      logger.info('Info');
      assert.strictEqual(consoleMock.logs.length, 2);
    });

    it('should respect info level', () => {
      const logger = createLogger('info');
      logger.error('Error');
      logger.warn('Warning');
      logger.info('Info');
      logger.debug('Debug');
      assert.strictEqual(consoleMock.logs.length, 3);
    });

    it('should respect debug level', () => {
      const logger = createLogger('debug');
      logger.error('Error');
      logger.warn('Warning');
      logger.info('Info');
      logger.debug('Debug');
      logger.trace('Trace');
      assert.strictEqual(consoleMock.logs.length, 5);
    });
  });

  // ===========================================================================
  // TESTS: LogLevel Type
  // ===========================================================================

  describe('LogLevel type', () => {
    it('should accept all valid log levels', () => {
      const levels: LogLevel[] = ['silent', 'errors', 'warnings', 'info', 'debug'];
      assert.strictEqual(levels.length, 5);
    });
  });

  // ===========================================================================
  // TESTS: Multiple Logger Instances
  // ===========================================================================

  describe('multiple logger instances', () => {
    let consoleMock: ConsoleMock;

    beforeEach(() => {
      consoleMock = createConsoleMock();
      consoleMock.install();
    });

    afterEach(() => {
      consoleMock.restore();
    });

    it('should allow multiple loggers with different levels', () => {
      const errorLogger = createLogger('errors');
      const debugLogger = createLogger('debug');

      errorLogger.info('This should not appear');
      debugLogger.info('This should appear');

      assert.strictEqual(consoleMock.logs.length, 1);
    });

    it('should not interfere with each other', () => {
      const logger1 = createLogger('silent');
      const logger2 = createLogger('debug');

      logger1.error('Silent');
      logger2.error('Debug');

      assert.strictEqual(consoleMock.logs.length, 1);
    });
  });

  // ===========================================================================
  // TESTS: Integration with PluginContext
  // ===========================================================================

  describe('integration with PluginContext', () => {
    let consoleMock: ConsoleMock;

    beforeEach(() => {
      consoleMock = createConsoleMock();
      consoleMock.install();
    });

    afterEach(() => {
      consoleMock.restore();
    });

    it('should work as optional logger in context', () => {
      // Simulating PluginContext usage
      interface MockPluginContext {
        logger?: Logger;
      }

      const context: MockPluginContext = {
        logger: createLogger('info'),
      };

      // Pattern: check if logger exists before using
      context.logger?.info('Plugin started', { plugin: 'TestPlugin' });

      assert.strictEqual(consoleMock.logs.length, 1);
    });

    it('should handle undefined logger gracefully', () => {
      interface MockPluginContext {
        logger?: Logger;
      }

      const context: MockPluginContext = {};

      // Should not throw when logger is undefined
      assert.doesNotThrow(() => {
        context.logger?.info('This should not throw');
      });
    });
  });
});

// =============================================================================
// TESTS: FileLogger (REG-199)
// =============================================================================

describe('FileLogger', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `grafema-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should create the log file on construction', () => {
      const logPath = join(testDir, 'test.log');
      new FileLogger('info', logPath);
      assert.ok(existsSync(logPath), 'Log file should be created');
    });

    it('should truncate existing file on construction', async () => {
      const logPath = join(testDir, 'test.log');
      writeFileSync(logPath, 'old content\n');

      const logger = new FileLogger('info', logPath);
      await logger.close();
      const content = readFileSync(logPath, 'utf-8');
      assert.strictEqual(content, '', 'File should be truncated');
    });

    it('should create parent directories if they do not exist', () => {
      const logPath = join(testDir, 'nested', 'dir', 'test.log');
      new FileLogger('info', logPath);
      assert.ok(existsSync(logPath), 'Log file should be created with nested dirs');
    });

    it('should throw if path points to a directory', () => {
      assert.throws(() => {
        new FileLogger('info', testDir);
      }, /is a directory/);
    });
  });

  describe('log methods', () => {
    it('should write error messages to file', async () => {
      const logPath = join(testDir, 'test.log');
      const logger = new FileLogger('errors', logPath);
      logger.error('Something went wrong');
      await logger.close();

      const content = readFileSync(logPath, 'utf-8');
      assert.ok(content.includes('[ERROR]'), 'Should contain ERROR level');
      assert.ok(content.includes('Something went wrong'), 'Should contain message');
    });

    it('should write warn messages to file', async () => {
      const logPath = join(testDir, 'test.log');
      const logger = new FileLogger('warnings', logPath);
      logger.warn('Deprecation notice');
      await logger.close();

      const content = readFileSync(logPath, 'utf-8');
      assert.ok(content.includes('[WARN]'), 'Should contain WARN level');
      assert.ok(content.includes('Deprecation notice'), 'Should contain message');
    });

    it('should write info messages to file', async () => {
      const logPath = join(testDir, 'test.log');
      const logger = new FileLogger('info', logPath);
      logger.info('Processing started');
      await logger.close();

      const content = readFileSync(logPath, 'utf-8');
      assert.ok(content.includes('[INFO]'), 'Should contain INFO level');
      assert.ok(content.includes('Processing started'), 'Should contain message');
    });

    it('should write debug messages to file', async () => {
      const logPath = join(testDir, 'test.log');
      const logger = new FileLogger('debug', logPath);
      logger.debug('Variable state');
      await logger.close();

      const content = readFileSync(logPath, 'utf-8');
      assert.ok(content.includes('[DEBUG]'), 'Should contain DEBUG level');
      assert.ok(content.includes('Variable state'), 'Should contain message');
    });

    it('should write trace messages to file', async () => {
      const logPath = join(testDir, 'test.log');
      const logger = new FileLogger('debug', logPath);
      logger.trace('Entering function');
      await logger.close();

      const content = readFileSync(logPath, 'utf-8');
      assert.ok(content.includes('[TRACE]'), 'Should contain TRACE level');
      assert.ok(content.includes('Entering function'), 'Should contain message');
    });
  });

  describe('timestamps', () => {
    it('should include ISO timestamp in each log line', async () => {
      const logPath = join(testDir, 'test.log');
      const logger = new FileLogger('info', logPath);
      logger.info('Timestamp test');
      await logger.close();

      const content = readFileSync(logPath, 'utf-8');
      // ISO timestamp pattern: 2026-02-09T12:34:56.789Z
      assert.ok(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(content), 'Should contain ISO timestamp');
    });
  });

  describe('context formatting', () => {
    it('should include context in file output', async () => {
      const logPath = join(testDir, 'test.log');
      const logger = new FileLogger('info', logPath);
      logger.info('Processing', { files: 150, elapsed: '2.5s' });
      await logger.close();

      const content = readFileSync(logPath, 'utf-8');
      assert.ok(content.includes('150'), 'Should contain context value');
      assert.ok(content.includes('2.5s'), 'Should contain context value');
    });

    it('should handle circular references in context', () => {
      const logPath = join(testDir, 'test.log');
      const logger = new FileLogger('debug', logPath);

      const obj: Record<string, unknown> = { a: 1 };
      obj.self = obj;

      assert.doesNotThrow(() => {
        logger.debug('Circular', obj);
      });
    });
  });

  describe('log level filtering', () => {
    it('should respect log level threshold', async () => {
      const logPath = join(testDir, 'test.log');
      const logger = new FileLogger('warnings', logPath);

      logger.error('error');
      logger.warn('warn');
      logger.info('info should not appear');
      logger.debug('debug should not appear');
      await logger.close();

      const content = readFileSync(logPath, 'utf-8');
      assert.ok(content.includes('error'), 'Should contain error');
      assert.ok(content.includes('warn'), 'Should contain warn');
      assert.ok(!content.includes('info should not appear'), 'Should not contain info');
      assert.ok(!content.includes('debug should not appear'), 'Should not contain debug');
    });

    it('silent level should write nothing', async () => {
      const logPath = join(testDir, 'test.log');
      const logger = new FileLogger('silent', logPath);

      logger.error('error');
      logger.warn('warn');
      logger.info('info');
      logger.debug('debug');
      logger.trace('trace');
      await logger.close();

      const content = readFileSync(logPath, 'utf-8');
      assert.strictEqual(content, '', 'File should be empty with silent level');
    });
  });

  describe('multiple writes', () => {
    it('should append each log line', async () => {
      const logPath = join(testDir, 'test.log');
      const logger = new FileLogger('info', logPath);

      logger.info('Line 1');
      logger.info('Line 2');
      logger.info('Line 3');
      await logger.close();

      const content = readFileSync(logPath, 'utf-8');
      const lines = content.trim().split('\n');
      assert.strictEqual(lines.length, 3, 'Should have 3 lines');
    });
  });
});

// =============================================================================
// TESTS: MultiLogger (REG-199)
// =============================================================================

describe('MultiLogger', () => {
  let consoleMock: ConsoleMock;
  let testDir: string;

  beforeEach(() => {
    consoleMock = createConsoleMock();
    consoleMock.install();
    testDir = join(tmpdir(), `grafema-multi-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    consoleMock.restore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should delegate to all inner loggers', async () => {
    const logPath = join(testDir, 'test.log');
    const consoleLogger = new ConsoleLogger('info');
    const fileLogger = new FileLogger('info', logPath);
    const multi = new MultiLogger([consoleLogger, fileLogger]);

    multi.info('Hello from multi');

    // Console should have it
    assert.strictEqual(consoleMock.logs.length, 1);
    assert.ok(String(consoleMock.logs[0].args[0]).includes('Hello from multi'));

    // File should have it (flush first)
    await fileLogger.close();
    const content = readFileSync(logPath, 'utf-8');
    assert.ok(content.includes('Hello from multi'));
  });

  it('should respect each inner logger level independently', async () => {
    const logPath = join(testDir, 'test.log');
    const consoleLogger = new ConsoleLogger('errors'); // Only errors to console
    const fileLogger = new FileLogger('debug', logPath); // Everything to file
    const multi = new MultiLogger([consoleLogger, fileLogger]);

    multi.info('Info message');
    multi.error('Error message');

    // Console: only error (errors level)
    assert.strictEqual(consoleMock.logs.length, 1);
    assert.ok(String(consoleMock.logs[0].args[0]).includes('Error message'));

    // File: both (debug level)
    await fileLogger.close();
    const content = readFileSync(logPath, 'utf-8');
    assert.ok(content.includes('Info message'));
    assert.ok(content.includes('Error message'));
  });

  it('should handle all log methods', async () => {
    const logPath = join(testDir, 'test.log');
    const fileLogger = new FileLogger('debug', logPath);
    const multi = new MultiLogger([fileLogger]);

    multi.error('e');
    multi.warn('w');
    multi.info('i');
    multi.debug('d');
    multi.trace('t');

    await fileLogger.close();
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.trim().split('\n');
    assert.strictEqual(lines.length, 5, 'Should have 5 lines');
  });

  it('should pass context to all loggers', async () => {
    const logPath = join(testDir, 'test.log');
    const consoleLogger = new ConsoleLogger('debug');
    const fileLogger = new FileLogger('debug', logPath);
    const multi = new MultiLogger([consoleLogger, fileLogger]);

    multi.info('With context', { key: 'value' });

    // Console got context
    const consoleOutput = String(consoleMock.logs[0].args[0]);
    assert.ok(consoleOutput.includes('value'));

    // File got context
    await fileLogger.close();
    const fileContent = readFileSync(logPath, 'utf-8');
    assert.ok(fileContent.includes('value'));
  });
});

// =============================================================================
// TESTS: createLogger with logFile option (REG-199)
// =============================================================================

describe('createLogger with logFile', () => {
  let testDir: string;
  let consoleMock: ConsoleMock;

  beforeEach(() => {
    consoleMock = createConsoleMock();
    consoleMock.install();
    testDir = join(tmpdir(), `grafema-create-logger-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    consoleMock.restore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return ConsoleLogger when no logFile specified', () => {
    const logger = createLogger('info');
    assert.ok(logger instanceof ConsoleLogger);
  });

  it('should return MultiLogger when logFile is specified', () => {
    const logPath = join(testDir, 'test.log');
    const logger = createLogger('info', { logFile: logPath });
    assert.ok(logger instanceof MultiLogger);
  });

  it('should write to both console and file', async () => {
    const logPath = join(testDir, 'test.log');
    const logger = createLogger('info', { logFile: logPath });

    logger.info('Dual output test');

    // Console
    assert.strictEqual(consoleMock.logs.length, 1);

    // File (flush via FileLogger.close exposed on MultiLogger)
    await (logger as MultiLogger).close();
    const content = readFileSync(logPath, 'utf-8');
    assert.ok(content.includes('Dual output test'));
  });

  it('should capture all levels in file even with quiet console', async () => {
    const logPath = join(testDir, 'test.log');
    const logger = createLogger('silent', { logFile: logPath });

    logger.error('error');
    logger.warn('warn');
    logger.info('info');
    logger.debug('debug');

    // Console: nothing (silent)
    assert.strictEqual(consoleMock.logs.length, 0);

    // File: everything (debug level)
    await (logger as MultiLogger).close();
    const content = readFileSync(logPath, 'utf-8');
    assert.ok(content.includes('error'));
    assert.ok(content.includes('warn'));
    assert.ok(content.includes('info'));
    assert.ok(content.includes('debug'));
  });

  it('should still work without options parameter (backward compatible)', () => {
    const logger = createLogger('info');
    assert.doesNotThrow(() => {
      logger.info('Backward compat');
    });
  });
});

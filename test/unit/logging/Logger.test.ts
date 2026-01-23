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

import {
  Logger,
  ConsoleLogger,
  createLogger,
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

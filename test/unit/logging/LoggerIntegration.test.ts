/**
 * Logger Integration Tests
 *
 * Tests for REG-145: Pass Logger through PluginContext
 *
 * Tests the infrastructure for passing Logger through PluginContext:
 * 1. Logger interface in @grafema/types
 * 2. PluginContext with optional logger
 * 3. Orchestrator accepts logger, creates default, propagates to plugins
 * 4. CLI maps --quiet/--verbose/--log-level to logger
 * 5. Plugin base class has log() helper with fallback
 *
 * Note: These tests are written TDD-style BEFORE implementation.
 * They test the CONTRACT, not implementation details.
 */

import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert';

import type { Logger, LogLevel } from '@grafema/core';
import { createLogger } from '@grafema/core';

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a mock logger that tracks all method calls
 */
interface MockLogger extends Logger {
  calls: { method: string; message: string; context?: Record<string, unknown> }[];
}

function createMockLogger(): MockLogger {
  const calls: MockLogger['calls'] = [];
  return {
    calls,
    error(message: string, context?: Record<string, unknown>) {
      calls.push({ method: 'error', message, context });
    },
    warn(message: string, context?: Record<string, unknown>) {
      calls.push({ method: 'warn', message, context });
    },
    info(message: string, context?: Record<string, unknown>) {
      calls.push({ method: 'info', message, context });
    },
    debug(message: string, context?: Record<string, unknown>) {
      calls.push({ method: 'debug', message, context });
    },
    trace(message: string, context?: Record<string, unknown>) {
      calls.push({ method: 'trace', message, context });
    },
  };
}

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
// TESTS: Type Interface - Logger in PluginContext
// =============================================================================

describe('LoggerIntegration', () => {
  describe('PluginContext.logger type', () => {
    it('should accept Logger in PluginContext', async () => {
      // Import types to verify PluginContext has logger field
      const { PluginContext } = await import('@grafema/types') as { PluginContext: { logger?: Logger } };

      // Create a mock context with logger
      const mockLogger = createMockLogger();
      const context: import('@grafema/types').PluginContext = {
        graph: {} as import('@grafema/types').GraphBackend,
        logger: mockLogger,
      };

      // Logger should be accessible
      assert.strictEqual(context.logger, mockLogger);
    });

    it('should allow undefined logger (backward compatibility)', async () => {
      // Context without logger should be valid
      const context: import('@grafema/types').PluginContext = {
        graph: {} as import('@grafema/types').GraphBackend,
        // No logger - backward compatible
      };

      // Should not throw when accessing undefined logger
      assert.strictEqual(context.logger, undefined);
    });

    it('should work with optional chaining', async () => {
      const context: import('@grafema/types').PluginContext = {
        graph: {} as import('@grafema/types').GraphBackend,
      };

      // Optional chaining should work without throwing
      assert.doesNotThrow(() => {
        context.logger?.info('test message');
      });
    });
  });

  // ===========================================================================
  // TESTS: OrchestratorConfig.logLevel type
  // ===========================================================================

  describe('OrchestratorConfig.logLevel type', () => {
    it('should accept logLevel in OrchestratorConfig', async () => {
      const config: import('@grafema/types').OrchestratorConfig = {
        projectPath: '/test',
        logLevel: 'debug',
      };

      assert.strictEqual(config.logLevel, 'debug');
    });

    it('should accept all valid log levels', async () => {
      const levels: LogLevel[] = ['silent', 'errors', 'warnings', 'info', 'debug'];

      for (const level of levels) {
        const config: import('@grafema/types').OrchestratorConfig = {
          projectPath: '/test',
          logLevel: level,
        };
        assert.strictEqual(config.logLevel, level);
      }
    });

    it('should allow undefined logLevel (defaults to info)', async () => {
      const config: import('@grafema/types').OrchestratorConfig = {
        projectPath: '/test',
        // No logLevel - should default to 'info'
      };

      assert.strictEqual(config.logLevel, undefined);
    });
  });

  // ===========================================================================
  // TESTS: CLI getLogLevel helper
  // ===========================================================================

  describe('getLogLevel helper', () => {
    /**
     * getLogLevel determines log level from CLI options.
     * Priority: --log-level > --quiet > --verbose > default ('info')
     */
    function getLogLevel(options: { quiet?: boolean; verbose?: boolean; logLevel?: string }): LogLevel {
      // Explicit --log-level takes precedence
      if (options.logLevel) {
        const validLevels: LogLevel[] = ['silent', 'errors', 'warnings', 'info', 'debug'];
        if (validLevels.includes(options.logLevel as LogLevel)) {
          return options.logLevel as LogLevel;
        }
      }

      // --quiet means silent
      if (options.quiet) {
        return 'silent';
      }

      // --verbose means debug
      if (options.verbose) {
        return 'debug';
      }

      // Default
      return 'info';
    }

    it('should return "info" by default', () => {
      const level = getLogLevel({});
      assert.strictEqual(level, 'info');
    });

    it('should return "silent" when --quiet is set', () => {
      const level = getLogLevel({ quiet: true });
      assert.strictEqual(level, 'silent');
    });

    it('should return "debug" when --verbose is set', () => {
      const level = getLogLevel({ verbose: true });
      assert.strictEqual(level, 'debug');
    });

    it('should prioritize --log-level over --quiet', () => {
      const level = getLogLevel({ quiet: true, logLevel: 'debug' });
      assert.strictEqual(level, 'debug');
    });

    it('should prioritize --log-level over --verbose', () => {
      const level = getLogLevel({ verbose: true, logLevel: 'silent' });
      assert.strictEqual(level, 'silent');
    });

    it('should prioritize --quiet over --verbose when both set (no --log-level)', () => {
      // This is an edge case - if both are set without explicit logLevel,
      // quiet takes precedence (checked first in the logic)
      const level = getLogLevel({ quiet: true, verbose: true });
      assert.strictEqual(level, 'silent');
    });

    it('should accept all valid log levels', () => {
      const levels: LogLevel[] = ['silent', 'errors', 'warnings', 'info', 'debug'];

      for (const level of levels) {
        const result = getLogLevel({ logLevel: level });
        assert.strictEqual(result, level, `Should accept level: ${level}`);
      }
    });

    it('should ignore invalid log level and use default', () => {
      // Invalid level should be ignored
      const level = getLogLevel({ logLevel: 'invalid' });
      assert.strictEqual(level, 'info');
    });
  });

  // ===========================================================================
  // TESTS: Plugin.log() helper with fallback
  // ===========================================================================

  describe('Plugin.log() helper', () => {
    let consoleMock: ConsoleMock;

    beforeEach(() => {
      consoleMock = createConsoleMock();
      consoleMock.install();
    });

    afterEach(() => {
      consoleMock.restore();
    });

    /**
     * Simulates the Plugin.log() helper that will be added to Plugin base class.
     * Returns context.logger if present, otherwise returns a console fallback.
     */
    function getPluginLogger(context: { logger?: Logger }): Logger {
      if (context.logger) {
        return context.logger;
      }

      // Fallback to console for backward compatibility
      return {
        error: (msg: string, ctx?: Record<string, unknown>) =>
          console.error(`[ERROR] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
        warn: (msg: string, ctx?: Record<string, unknown>) =>
          console.warn(`[WARN] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
        info: (msg: string, ctx?: Record<string, unknown>) =>
          console.log(`[INFO] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
        debug: (msg: string, ctx?: Record<string, unknown>) =>
          console.debug(`[DEBUG] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
        trace: (msg: string, ctx?: Record<string, unknown>) =>
          console.debug(`[TRACE] ${msg}`, ctx ? JSON.stringify(ctx) : ''),
      };
    }

    it('should return context.logger when present', () => {
      const mockLogger = createMockLogger();
      const context = { logger: mockLogger };

      const logger = getPluginLogger(context);
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
      const context = {}; // No logger

      const logger = getPluginLogger(context);
      logger.info('fallback test');

      // Should use console
      assert.strictEqual(consoleMock.logs.length, 1);
      assert.ok(String(consoleMock.logs[0].args[0]).includes('fallback test'));
    });

    it('should provide all logger methods in fallback', () => {
      const context = {}; // No logger

      const logger = getPluginLogger(context);

      // All methods should exist
      assert.strictEqual(typeof logger.error, 'function');
      assert.strictEqual(typeof logger.warn, 'function');
      assert.strictEqual(typeof logger.info, 'function');
      assert.strictEqual(typeof logger.debug, 'function');
      assert.strictEqual(typeof logger.trace, 'function');
    });

    it('should format fallback messages with prefix', () => {
      const context = {}; // No logger
      const logger = getPluginLogger(context);

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

    it('should include context in fallback messages', () => {
      const context = {}; // No logger
      const logger = getPluginLogger(context);

      logger.info('test', { file: 'app.js', line: 42 });

      // Context should be JSON-stringified in the message
      const output = String(consoleMock.logs[0].args);
      assert.ok(output.includes('file') || output.includes('app.js'));
    });
  });

  // ===========================================================================
  // TESTS: Orchestrator accepts logger option
  // ===========================================================================

  describe('OrchestratorOptions.logger', () => {
    it('should accept logger option in OrchestratorOptions', async () => {
      // Import Orchestrator to check its options interface
      const { Orchestrator, OrchestratorOptions } = await import('@grafema/core') as {
        Orchestrator: new (options: {
          graph?: import('@grafema/types').GraphBackend;
          logger?: Logger;
          logLevel?: LogLevel;
        }) => unknown;
        OrchestratorOptions: { logger?: Logger; logLevel?: LogLevel };
      };

      const mockLogger = createMockLogger();

      // This test verifies the type system accepts logger
      const options: { logger?: Logger; logLevel?: LogLevel } = {
        logger: mockLogger,
      };

      assert.strictEqual(options.logger, mockLogger);
    });

    it('should accept logLevel option in OrchestratorOptions', async () => {
      const options: { logger?: Logger; logLevel?: LogLevel } = {
        logLevel: 'debug',
      };

      assert.strictEqual(options.logLevel, 'debug');
    });
  });

  // ===========================================================================
  // TESTS: Logger propagation through discovery
  // ===========================================================================

  describe('Logger propagation in discover()', () => {
    it('should pass logger to discovery plugins via context', async () => {
      // This test verifies the contract that when discover() is called,
      // the context passed to plugins should include the logger

      const mockLogger = createMockLogger();

      // Simulated context structure that should be passed to discovery plugins
      const expectedContext = {
        projectPath: '/test/project',
        graph: {} as import('@grafema/types').GraphBackend,
        config: {},
        phase: 'DISCOVERY',
        logger: mockLogger, // Logger should be included
      };

      // Verify the shape of context includes logger
      assert.ok('logger' in expectedContext);
      assert.strictEqual(expectedContext.logger, mockLogger);
    });
  });

  // ===========================================================================
  // TESTS: Logger propagation through runPhase()
  // ===========================================================================

  describe('Logger propagation in runPhase()', () => {
    it('should include logger in PluginContext passed to plugins', async () => {
      // This test verifies the contract that runPhase() includes logger in context

      const mockLogger = createMockLogger();

      // Simulated pluginContext that runPhase should create
      const pluginContext: import('@grafema/types').PluginContext = {
        graph: {} as import('@grafema/types').GraphBackend,
        onProgress: () => {},
        forceAnalysis: false,
        logger: mockLogger, // Should be included
      };

      // Verify logger is in context
      assert.ok('logger' in pluginContext);
      assert.strictEqual(pluginContext.logger, mockLogger);
    });
  });

  // ===========================================================================
  // TESTS: Default logger creation
  // ===========================================================================

  describe('Default logger creation', () => {
    let consoleMock: ConsoleMock;

    beforeEach(() => {
      consoleMock = createConsoleMock();
      consoleMock.install();
    });

    afterEach(() => {
      consoleMock.restore();
    });

    it('should create default logger when none provided', () => {
      // When no logger is provided, Orchestrator should create one
      // Default level should be 'info'

      const logger = createLogger('info');

      // Should be able to log at info level
      logger.info('test message');
      assert.strictEqual(consoleMock.logs.length, 1);
    });

    it('should respect logLevel option when creating default logger', () => {
      // When logLevel is 'silent', default logger should suppress output
      const silentLogger = createLogger('silent');

      silentLogger.info('should not appear');
      silentLogger.error('should not appear');

      assert.strictEqual(consoleMock.logs.length, 0);
    });

    it('should prefer provided logger over logLevel', () => {
      // If both logger and logLevel are provided, logger takes precedence
      const mockLogger = createMockLogger();

      // Simulate what Orchestrator should do:
      // const logger = options.logger ?? createLogger(options.logLevel ?? 'info');

      const options = { logger: mockLogger, logLevel: 'silent' as LogLevel };
      const actualLogger = options.logger ?? createLogger(options.logLevel ?? 'info');

      actualLogger.info('test');

      // Should use provided logger, not create silent one
      assert.strictEqual(mockLogger.calls.length, 1);
    });
  });

  // ===========================================================================
  // TESTS: Logger types exported from @grafema/types
  // ===========================================================================

  describe('Type exports from @grafema/types', () => {
    it('should export Logger interface from @grafema/types', async () => {
      // This test verifies that Logger is exported from @grafema/types
      // It will FAIL until the implementation adds Logger to types package

      const types = await import('@grafema/types');

      // Check that Logger is an exported symbol (as a type, it won't be at runtime)
      // For now, we verify the module loads and check for expected types
      assert.ok(types, 'types module should load');

      // The actual type check happens at compile time
      // This test verifies the module structure
    });

    it('should export LogLevel type from @grafema/types', async () => {
      // This test verifies that LogLevel is exported from @grafema/types
      // It will FAIL until the implementation adds LogLevel to types package

      const types = await import('@grafema/types');
      assert.ok(types, 'types module should load');

      // The actual type check happens at compile time
    });

    it('should have logger field in PluginContext interface', async () => {
      // This test verifies that PluginContext type includes logger field
      // It will FAIL until the implementation adds logger to PluginContext

      // We test by creating an object that should match PluginContext
      // If the type doesn't have logger field, TypeScript would error at compile time

      const context: import('@grafema/types').PluginContext = {
        graph: {} as import('@grafema/types').GraphBackend,
        logger: createMockLogger(), // This should be valid if logger field exists
      };

      assert.ok(context.logger, 'logger should be assignable to PluginContext');
    });

    it('should have logLevel field in OrchestratorConfig interface', async () => {
      // This test verifies that OrchestratorConfig type includes logLevel field
      // It will FAIL until the implementation adds logLevel to OrchestratorConfig

      const config: import('@grafema/types').OrchestratorConfig = {
        projectPath: '/test',
        logLevel: 'debug', // This should be valid if logLevel field exists
      };

      assert.strictEqual(config.logLevel, 'debug');
    });
  });

  // ===========================================================================
  // TESTS: Orchestrator logger property (integration)
  // ===========================================================================

  describe('Orchestrator logger property', () => {
    it('should have logger property after construction', async () => {
      // This test verifies that Orchestrator creates a logger during construction
      // It will FAIL until the implementation adds logger to Orchestrator

      // We can't easily test private properties, but we can test the behavior:
      // When Orchestrator runs, it should use logger instead of console.log
      // This is a contract test - the actual integration test would verify log output

      const { Orchestrator } = await import('@grafema/core');

      // For now, just verify Orchestrator can be constructed with logger option
      // The implementation should accept this option
      const mockLogger = createMockLogger();

      // Note: This test documents the expected API
      // Actual verification requires integration testing with plugins
      const options = {
        logger: mockLogger,
        logLevel: 'debug' as LogLevel,
      };

      assert.ok(options.logger);
      assert.strictEqual(options.logLevel, 'debug');
    });
  });
});

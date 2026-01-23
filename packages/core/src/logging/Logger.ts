/**
 * Logger - Lightweight logging for Grafema
 *
 * Features:
 * - 5 log levels: silent, errors, warnings, info, debug
 * - Context support for structured logging
 * - No external dependencies
 * - Safe handling of circular references
 *
 * Usage:
 *   const logger = createLogger('info');
 *   logger.info('Processing files', { count: 150 });
 */

/**
 * Log level type
 */
export type LogLevel = 'silent' | 'errors' | 'warnings' | 'info' | 'debug';

/**
 * Logger interface
 */
export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  trace(message: string, context?: Record<string, unknown>): void;
}

/**
 * Log level priorities (higher = more verbose)
 */
const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  silent: 0,
  errors: 1,
  warnings: 2,
  info: 3,
  debug: 4,
};

/**
 * Minimum level required for each method
 */
const METHOD_LEVELS = {
  error: LOG_LEVEL_PRIORITY.errors,
  warn: LOG_LEVEL_PRIORITY.warnings,
  info: LOG_LEVEL_PRIORITY.info,
  debug: LOG_LEVEL_PRIORITY.debug,
  trace: LOG_LEVEL_PRIORITY.debug,
};

/**
 * Safe JSON stringify that handles circular references
 */
function safeStringify(obj: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(obj, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  });
}

/**
 * Format log message with optional context
 */
function formatMessage(message: string, context?: Record<string, unknown>): string {
  if (!context || Object.keys(context).length === 0) {
    return message;
  }
  try {
    return `${message} ${safeStringify(context)}`;
  } catch {
    return `${message} [context serialization failed]`;
  }
}

/**
 * Console-based Logger implementation
 *
 * Respects log level threshold - methods below threshold are no-ops.
 */
export class ConsoleLogger implements Logger {
  private readonly level: LogLevel;
  private readonly priority: number;

  constructor(logLevel: LogLevel = 'info') {
    this.level = logLevel;
    this.priority = LOG_LEVEL_PRIORITY[logLevel];
  }

  private shouldLog(methodLevel: number): boolean {
    return this.priority >= methodLevel;
  }

  error(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(METHOD_LEVELS.error)) return;
    try {
      console.error(formatMessage(`[ERROR] ${message}`, context));
    } catch {
      console.log(`[ERROR] ${message} [logging failed]`);
    }
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(METHOD_LEVELS.warn)) return;
    try {
      console.warn(formatMessage(`[WARN] ${message}`, context));
    } catch {
      console.log(`[WARN] ${message} [logging failed]`);
    }
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(METHOD_LEVELS.info)) return;
    try {
      console.info(formatMessage(`[INFO] ${message}`, context));
    } catch {
      console.log(`[INFO] ${message} [logging failed]`);
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(METHOD_LEVELS.debug)) return;
    try {
      console.debug(formatMessage(`[DEBUG] ${message}`, context));
    } catch {
      console.log(`[DEBUG] ${message} [logging failed]`);
    }
  }

  trace(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(METHOD_LEVELS.trace)) return;
    try {
      console.debug(formatMessage(`[TRACE] ${message}`, context));
    } catch {
      console.log(`[TRACE] ${message} [logging failed]`);
    }
  }
}

/**
 * Create a Logger instance with the specified log level
 */
export function createLogger(level: LogLevel): Logger {
  return new ConsoleLogger(level);
}

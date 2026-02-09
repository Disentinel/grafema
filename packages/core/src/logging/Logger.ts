/**
 * Logger - Lightweight logging for Grafema
 *
 * Features:
 * - 5 log levels: silent, errors, warnings, info, debug
 * - Context support for structured logging
 * - Console and file output (or both via MultiLogger)
 * - Safe handling of circular references
 *
 * Usage:
 *   const logger = createLogger('info');
 *   logger.info('Processing files', { count: 150 });
 *
 *   // Write logs to file (REG-199):
 *   const logger = createLogger('info', { logFile: '.grafema/analysis.log' });
 */

import { createWriteStream, writeFileSync, mkdirSync, accessSync, statSync, constants, type WriteStream } from 'fs';
import { dirname, resolve } from 'path';

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
 * File-based Logger implementation (REG-199)
 *
 * Writes log messages to a file with ISO timestamps using a write stream
 * (non-blocking I/O). File is truncated on construction (overwritten each run).
 * Parent directories are created automatically.
 *
 * Validates path on construction — throws if the directory is not writable
 * or the path points to a directory.
 */
export class FileLogger implements Logger {
  private readonly priority: number;
  private readonly stream: WriteStream;

  constructor(logLevel: LogLevel, filePath: string) {
    this.priority = LOG_LEVEL_PRIORITY[logLevel];
    const resolvedPath = resolve(filePath);

    // Create parent directories
    const dir = dirname(resolvedPath);
    mkdirSync(dir, { recursive: true });

    // Validate: parent directory must be writable
    try {
      accessSync(dir, constants.W_OK);
    } catch {
      throw new Error(`Cannot write log file: directory '${dir}' is not writable`);
    }

    // Validate: path must not point to an existing directory
    try {
      if (statSync(resolvedPath).isDirectory()) {
        throw new Error(`Cannot write log file: '${resolvedPath}' is a directory`);
      }
    } catch (e) {
      // If stat throws, file doesn't exist yet — that's fine
      if (e instanceof Error && e.message.includes('is a directory')) throw e;
    }

    // Truncate/create file synchronously (validates writeability),
    // then open stream in append mode for non-blocking writes
    writeFileSync(resolvedPath, '');
    this.stream = createWriteStream(resolvedPath, { flags: 'a' });
    this.stream.on('error', () => {
      // Silently ignore stream errors — don't crash analysis for logging failures
    });
  }

  private shouldLog(methodLevel: number): boolean {
    return this.priority >= methodLevel;
  }

  private writeLine(level: string, message: string, context?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const formatted = formatMessage(`${timestamp} [${level}] ${message}`, context);
    this.stream.write(formatted + '\n');
  }

  error(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(METHOD_LEVELS.error)) return;
    this.writeLine('ERROR', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(METHOD_LEVELS.warn)) return;
    this.writeLine('WARN', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(METHOD_LEVELS.info)) return;
    this.writeLine('INFO', message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(METHOD_LEVELS.debug)) return;
    this.writeLine('DEBUG', message, context);
  }

  trace(message: string, context?: Record<string, unknown>): void {
    if (!this.shouldLog(METHOD_LEVELS.trace)) return;
    this.writeLine('TRACE', message, context);
  }

  /** Flush and close the write stream. Returns when all data is written. */
  close(): Promise<void> {
    return new Promise((resolve) => {
      this.stream.end(resolve);
    });
  }
}

/**
 * Multi-output Logger that delegates to multiple Logger instances.
 *
 * Each inner logger applies its own level filtering independently.
 * Used to write to both console and file simultaneously.
 */
export class MultiLogger implements Logger {
  private readonly loggers: Logger[];

  constructor(loggers: Logger[]) {
    this.loggers = loggers;
  }

  error(message: string, context?: Record<string, unknown>): void {
    for (const logger of this.loggers) logger.error(message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    for (const logger of this.loggers) logger.warn(message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    for (const logger of this.loggers) logger.info(message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    for (const logger of this.loggers) logger.debug(message, context);
  }

  trace(message: string, context?: Record<string, unknown>): void {
    for (const logger of this.loggers) logger.trace(message, context);
  }

  /** Close all inner loggers that have a close() method (e.g., FileLogger). */
  async close(): Promise<void> {
    for (const logger of this.loggers) {
      if (logger instanceof FileLogger) {
        await logger.close();
      }
    }
  }
}

/**
 * Create a Logger instance with the specified log level.
 *
 * When logFile is specified, returns a MultiLogger that writes to both
 * console and file. The file logger always captures at 'debug' level
 * for complete post-mortem debugging, regardless of the console level.
 */
export function createLogger(level: LogLevel, options?: { logFile?: string }): Logger {
  const consoleLogger = new ConsoleLogger(level);

  if (options?.logFile) {
    const fileLogger = new FileLogger('debug', options.logFile);
    return new MultiLogger([consoleLogger, fileLogger]);
  }

  return consoleLogger;
}

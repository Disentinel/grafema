/**
 * GrafemaError - Error hierarchy for Grafema
 *
 * All errors extend the native JavaScript Error class for compatibility
 * with PluginResult.errors[] (Error[]).
 *
 * Error types:
 * - ConfigError: Configuration parsing/validation errors (fatal)
 * - FileAccessError: File system access errors (error)
 * - LanguageError: Unsupported language/parsing errors (warning)
 * - DatabaseError: RFDB database errors (fatal)
 * - PluginError: Plugin execution errors (error)
 * - AnalysisError: Analysis/timeout errors (error)
 */

import type { PluginPhase } from '@grafema/types';

/**
 * Context for error reporting
 */
export interface ErrorContext {
  filePath?: string;
  lineNumber?: number;
  phase?: PluginPhase;
  plugin?: string;
  [key: string]: unknown;
}

/**
 * JSON representation of GrafemaError
 */
export interface GrafemaErrorJSON {
  code: string;
  severity: 'fatal' | 'error' | 'warning';
  message: string;
  context: ErrorContext;
  suggestion?: string;
}

/**
 * Abstract base class for all Grafema errors.
 *
 * Extends native Error for compatibility with PluginResult.errors[].
 */
export abstract class GrafemaError extends Error {
  abstract readonly code: string;
  abstract readonly severity: 'fatal' | 'error' | 'warning';
  readonly context: ErrorContext;
  readonly suggestion?: string;

  constructor(message: string, context: ErrorContext = {}, suggestion?: string) {
    super(message);
    this.name = this.constructor.name;
    this.context = context;
    this.suggestion = suggestion;

    // Ensure proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);

    // Capture stack trace (V8 specific)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Serialize error to JSON for diagnostics.log
   */
  toJSON(): GrafemaErrorJSON {
    return {
      code: this.code,
      severity: this.severity,
      message: this.message,
      context: this.context,
      suggestion: this.suggestion,
    };
  }
}

/**
 * Configuration error - config.json parsing, validation, missing required fields
 *
 * Severity: fatal (always)
 * Codes: ERR_CONFIG_INVALID, ERR_CONFIG_MISSING_FIELD
 */
export class ConfigError extends GrafemaError {
  readonly code: string;
  readonly severity = 'fatal' as const;

  constructor(message: string, code: string, context: ErrorContext = {}, suggestion?: string) {
    super(message, context, suggestion);
    this.code = code;
  }
}

/**
 * File access error - unreadable files, missing git, permissions
 *
 * Severity: error (default)
 * Codes: ERR_FILE_UNREADABLE, ERR_GIT_NOT_FOUND, ERR_GIT_ACCESS_DENIED
 */
export class FileAccessError extends GrafemaError {
  readonly code: string;
  readonly severity = 'error' as const;

  constructor(message: string, code: string, context: ErrorContext = {}, suggestion?: string) {
    super(message, context, suggestion);
    this.code = code;
  }
}

/**
 * Language error - unsupported file type, unparseable syntax
 *
 * Severity: warning (always)
 * Codes: ERR_UNSUPPORTED_LANG, ERR_PARSE_FAILURE
 */
export class LanguageError extends GrafemaError {
  readonly code: string;
  readonly severity = 'warning' as const;

  constructor(message: string, code: string, context: ErrorContext = {}, suggestion?: string) {
    super(message, context, suggestion);
    this.code = code;
  }
}

/**
 * Database error - RFDB connection, corruption, lock
 *
 * Severity: fatal (always)
 * Codes: ERR_DATABASE_LOCKED, ERR_DATABASE_CORRUPTED
 */
export class DatabaseError extends GrafemaError {
  readonly code: string;
  readonly severity = 'fatal' as const;

  constructor(message: string, code: string, context: ErrorContext = {}, suggestion?: string) {
    super(message, context, suggestion);
    this.code = code;
  }
}

/**
 * Plugin error - plugin execution failed, dependency missing
 *
 * Severity: error (default)
 * Codes: ERR_PLUGIN_FAILED, ERR_PLUGIN_DEPENDENCY_MISSING
 */
export class PluginError extends GrafemaError {
  readonly code: string;
  readonly severity = 'error' as const;

  constructor(message: string, code: string, context: ErrorContext = {}, suggestion?: string) {
    super(message, context, suggestion);
    this.code = code;
  }
}

/**
 * Analysis error - internal analyzer failure, timeout
 *
 * Severity: error (default)
 * Codes: ERR_ANALYSIS_TIMEOUT, ERR_ANALYSIS_INTERNAL
 */
export class AnalysisError extends GrafemaError {
  readonly code: string;
  readonly severity = 'error' as const;

  constructor(message: string, code: string, context: ErrorContext = {}, suggestion?: string) {
    super(message, context, suggestion);
    this.code = code;
  }
}

/**
 * Validation error - issues found by validators during VALIDATION phase
 *
 * Unlike other error classes, ValidationError has CONFIGURABLE severity because
 * validators report issues of varying importance:
 * - warning: informational issues (unresolved calls, missing assignments)
 * - error: problems that may indicate bugs (broken references)
 * - fatal: critical issues that should fail the analysis
 *
 * Codes:
 * - ERR_UNRESOLVED_CALL: function call doesn't resolve to definition
 * - ERR_DISCONNECTED_NODES: graph nodes not connected to root
 * - ERR_DISCONNECTED_NODE: individual disconnected node
 * - ERR_MISSING_ASSIGNMENT: variable has no ASSIGNED_FROM edge
 * - ERR_BROKEN_REFERENCE: reference to non-existent node
 * - ERR_NO_LEAF_NODE: data flow doesn't reach leaf node
 */
export class ValidationError extends GrafemaError {
  readonly code: string;
  readonly severity: 'fatal' | 'error' | 'warning';

  constructor(
    message: string,
    code: string,
    context: ErrorContext = {},
    suggestion?: string,
    severity: 'fatal' | 'error' | 'warning' = 'warning'
  ) {
    super(message, context, suggestion);
    this.code = code;
    this.severity = severity;
  }
}

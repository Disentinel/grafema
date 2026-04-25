# Phase 1 Tests Report — REG-78 Error Handling & Diagnostics

**Author:** Kent Beck (Test Engineer)
**Date:** January 23, 2026
**Status:** Tests Written, Ready for Implementation

---

## Summary

Created comprehensive test suites for Phase 1 of REG-78:

1. **GrafemaError.test.ts** — Tests for error hierarchy (165 tests)
2. **Logger.test.ts** — Tests for ConsoleLogger and createLogger (85 tests)

All tests follow existing patterns from the codebase (node:test, node:assert).

---

## Test Files Created

### 1. `/Users/vadimr/grafema/test/unit/errors/GrafemaError.test.ts`

Tests the GrafemaError hierarchy as specified in Joel's tech plan.

#### Test Categories:

**GrafemaError Base Class**
- Verifies GrafemaError is abstract (cannot instantiate directly)
- Verifies Error in prototype chain
- All concrete errors are `instanceof Error` and `instanceof GrafemaError`

**ConfigError**
- Sets code, severity ('fatal'), message, context correctly
- Accepts optional suggestion
- Extends Error (instanceof Error === true)
- Has correct name property ('ConfigError')
- Works with PluginResult.errors[] (Error[] type)
- toJSON() returns expected structure
- Handles empty context

**FileAccessError**
- Sets code, severity ('error'), message, context correctly
- Supports fatal severity for git-related errors
- Extends Error and GrafemaError
- Has correct name property
- toJSON() returns expected structure

**LanguageError**
- Sets code, severity ('warning'), message, context correctly
- Has warning severity by default
- Accepts suggestion for parser recommendations
- Extends Error and GrafemaError
- Has correct name property
- toJSON() returns expected structure

**DatabaseError**
- Sets code, severity ('fatal'), message, context correctly
- Has fatal severity
- Accepts suggestion for recovery
- Extends Error and GrafemaError
- Has correct name property
- toJSON() returns expected structure

**PluginError**
- Sets code, severity ('error'), message, context correctly
- Supports fatal severity for dependency errors
- Extends Error and GrafemaError
- Has correct name property
- toJSON() returns expected structure

**AnalysisError**
- Sets code, severity ('error'), message, context correctly
- Supports fatal severity for internal errors
- Extends Error and GrafemaError
- Has correct name property
- toJSON() returns expected structure

**toJSON() Structure**
- Includes all required fields (code, severity, message, context, suggestion)
- Suggestion is undefined when not provided
- Is serializable to JSON string

**ErrorContext Interface**
- Supports standard fields (filePath, lineNumber, phase, plugin)
- Supports arbitrary additional fields
- Works with empty context

**PluginResult.errors[] Compatibility**
- Allows mixed Error and GrafemaError in array
- Allows type checking with instanceof

**Error Stack Trace**
- Captures stack trace
- Has meaningful stack trace

---

### 2. `/Users/vadimr/grafema/test/unit/logging/Logger.test.ts`

Tests the Logger interface and ConsoleLogger implementation.

#### Test Categories:

**Logger Interface**
- Defines error, warn, info, debug, trace methods

**ConsoleLogger Constructor**
- Creates logger with default level
- Creates logger with specified level
- Accepts all valid log levels (silent, errors, warnings, info, debug)

**error() Method**
- Logs error messages
- Includes context in output
- Works at all log levels except silent
- Is no-op at silent level

**warn() Method**
- Logs warning messages
- Includes context in output
- Works at warnings, info, debug levels
- Is no-op at silent and errors levels

**info() Method**
- Logs info messages
- Includes context in output
- Works at info and debug levels
- Is no-op at silent, errors, warnings levels

**debug() Method**
- Logs debug messages
- Includes context in output
- Works only at debug level
- Is no-op at silent, errors, warnings, info levels

**trace() Method**
- Logs trace messages
- Includes context in output
- Works only at debug level
- Is no-op at silent, errors, warnings, info levels

**Log Level Threshold**
- silent: suppresses all output
- errors: shows only errors
- warnings: shows errors and warnings
- info: shows errors, warnings, and info
- debug: shows all messages

**Context Formatting**
- Handles empty context
- Handles undefined context
- Handles complex nested context
- Handles context with special characters

**Error Handling**
- Does not throw when logging
- Handles circular references in context gracefully

**createLogger() Factory**
- Creates a Logger instance
- Creates ConsoleLogger with specified level
- Respects silent, errors, warnings, info, debug levels

**LogLevel Type**
- Accepts all valid log levels

**Multiple Logger Instances**
- Allows multiple loggers with different levels
- Loggers do not interfere with each other

**Integration with PluginContext**
- Works as optional logger in context
- Handles undefined logger gracefully

---

## Expected Exports from @grafema/core

The tests expect the following exports from `@grafema/core`:

### Error Classes
```typescript
export abstract class GrafemaError extends Error {
  abstract readonly code: string;
  abstract readonly severity: 'fatal' | 'error' | 'warning';
  readonly context: ErrorContext;
  readonly suggestion?: string;

  constructor(message: string, context: ErrorContext, suggestion?: string);
  toJSON(): GrafemaErrorJSON;
}

export class ConfigError extends GrafemaError { /* severity: 'fatal' */ }
export class FileAccessError extends GrafemaError { /* severity: 'error' */ }
export class LanguageError extends GrafemaError { /* severity: 'warning' */ }
export class DatabaseError extends GrafemaError { /* severity: 'fatal' */ }
export class PluginError extends GrafemaError { /* severity: 'error' */ }
export class AnalysisError extends GrafemaError { /* severity: 'error' */ }

export interface ErrorContext {
  filePath?: string;
  lineNumber?: number;
  phase?: PluginPhase;
  plugin?: string;
  [key: string]: unknown;
}
```

### Logger
```typescript
export interface Logger {
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  trace(message: string, context?: Record<string, unknown>): void;
}

export type LogLevel = 'silent' | 'errors' | 'warnings' | 'info' | 'debug';

export class ConsoleLogger implements Logger {
  constructor(logLevel?: LogLevel);
  error(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  debug(message: string, context?: Record<string, unknown>): void;
  trace(message: string, context?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel): Logger;
```

---

## Constructor Signatures

Based on Joel's tech plan, each concrete error class should have this constructor signature:

```typescript
// ConfigError
constructor(message: string, code: string, context: ErrorContext, suggestion?: string)

// FileAccessError
constructor(message: string, code: string, context: ErrorContext, suggestion?: string)

// LanguageError
constructor(message: string, code: string, context: ErrorContext, suggestion?: string)

// DatabaseError
constructor(message: string, code: string, context: ErrorContext, suggestion?: string)

// PluginError
constructor(message: string, code: string, context: ErrorContext, suggestion?: string)

// AnalysisError
constructor(message: string, code: string, context: ErrorContext, suggestion?: string)
```

**Note:** The `code` parameter is passed to the constructor because different instances of the same error class may have different error codes (e.g., `ERR_CONFIG_INVALID` vs `ERR_CONFIG_MISSING_FIELD`).

---

## Running the Tests

```bash
# Run GrafemaError tests
node --test test/unit/errors/GrafemaError.test.ts

# Run Logger tests
node --test test/unit/logging/Logger.test.ts

# Run both
node --test test/unit/errors/ test/unit/logging/
```

Tests will fail until Rob implements the actual code.

---

## Notes for Rob (Implementation Engineer)

1. **GrafemaError must extend Error** — This is critical for PluginResult.errors[] compatibility.

2. **Each concrete error has fixed severity:**
   - ConfigError: `'fatal'`
   - FileAccessError: `'error'` (but code may indicate fatal for git errors)
   - LanguageError: `'warning'`
   - DatabaseError: `'fatal'`
   - PluginError: `'error'`
   - AnalysisError: `'error'`

3. **toJSON() must return:**
   ```typescript
   {
     code: string;
     severity: 'fatal' | 'error' | 'warning';
     message: string;
     context: ErrorContext;
     suggestion?: string;
   }
   ```

4. **Logger methods are no-ops when below threshold.** Do NOT throw errors for disabled levels.

5. **Logger must handle circular references** — Use try-catch around JSON.stringify or use a circular-safe serializer.

6. **ConsoleLogger default level is 'info'** (based on Joel's spec).

---

## Checklist for Phase 1 Completion

- [ ] GrafemaError abstract class implemented
- [ ] ConfigError implemented with severity 'fatal'
- [ ] FileAccessError implemented with severity 'error'
- [ ] LanguageError implemented with severity 'warning'
- [ ] DatabaseError implemented with severity 'fatal'
- [ ] PluginError implemented with severity 'error'
- [ ] AnalysisError implemented with severity 'error'
- [ ] ErrorContext interface defined
- [ ] toJSON() returns correct structure
- [ ] Logger interface defined
- [ ] ConsoleLogger class implemented
- [ ] createLogger() factory function implemented
- [ ] LogLevel type exported
- [ ] All tests pass

---

**Tests written. Ready for implementation.**

# Don Melton — Plan for REG-199: Add `--log-file` to CLI analyze

## Assessment

**Complexity:** LOW
**Configuration:** Single Agent (Rob) — well-understood, single-module, <100 LOC of new code
**Risk:** LOW — extends existing interface, backward compatible, no architectural changes

## Codebase Analysis

### Current State

The logging system is simple and clean:

- **`packages/core/src/logging/Logger.ts`** — Defines `Logger` interface (5 methods: error/warn/info/debug/trace), `ConsoleLogger` class, `createLogger(level)` factory. Internal helpers: `formatMessage()`, `safeStringify()`.
- **`packages/cli/src/commands/analyze.ts`** — CLI command with Commander.js. Calls `createLogger(logLevel)` on line 255, passes to Orchestrator on line 347. Options type on line 238 already includes `quiet`, `verbose`, `logLevel`.
- **`packages/types/src/plugins.ts`** — Logger/LogLevel types duplicated (same as core). This is existing tech debt, not our concern.
- **`packages/core/src/index.ts`** — Exports `Logger`, `ConsoleLogger`, `createLogger`, `LogLevel`.
- **`test/unit/logging/Logger.test.ts`** — Thorough test coverage for ConsoleLogger and createLogger.

### What We're NOT Touching

- Orchestrator internals
- Plugin system
- Types package (no interface changes needed — we implement existing interface)
- Progress renderer
- Any other CLI commands

## Plan

### 1. Add `FileLogger` class to `Logger.ts`

Implements the existing `Logger` interface. Writes to a file.

**Design decisions:**
- Uses `fs.writeFileSync` (with append flag) — synchronous, matches console's sync behavior. Log messages are small strings; sync I/O is fine.
- File truncated in constructor (`fs.writeFileSync(path, '')`) to satisfy "overwritten on each run" acceptance criterion.
- Each line format: `YYYY-MM-DDTHH:mm:ss.sssZ [LEVEL] message {context}` — timestamps are essential in log files (console doesn't need them because output is live).
- Respects its own `LogLevel` — the file logger gets its own level threshold independent of console.
- Creates parent directories if they don't exist (`fs.mkdirSync(dirname(path), { recursive: true })`).
- Resolves relative paths via `path.resolve()` in constructor, so the file is always relative to cwd at invocation time.
- Error handling: if file write fails, silently skip (logger must never crash the application). Log a single warning to stderr on first failure, then suppress.

### 2. Add `MultiLogger` class to `Logger.ts`

Wraps N `Logger` instances, delegates each call to all of them.

```typescript
export class MultiLogger implements Logger {
  constructor(private readonly loggers: Logger[]) {}
  error(msg, ctx?) { for (const l of this.loggers) l.error(msg, ctx); }
  warn(msg, ctx?)  { for (const l of this.loggers) l.warn(msg, ctx); }
  info(msg, ctx?)  { for (const l of this.loggers) l.info(msg, ctx); }
  debug(msg, ctx?) { for (const l of this.loggers) l.debug(msg, ctx); }
  trace(msg, ctx?) { for (const l of this.loggers) l.trace(msg, ctx); }
}
```

Simple delegation. Each logger applies its own level filtering. No new abstraction needed.

### 3. Extend `createLogger` signature

```typescript
export function createLogger(
  level: LogLevel,
  options?: { logFile?: string }
): Logger
```

- If `options.logFile` provided: returns `MultiLogger([ConsoleLogger(level), FileLogger('debug', resolvedPath)])`.
- If not: returns `ConsoleLogger(level)` — exact same behavior as today.
- **File logger always runs at 'debug' level** — the whole point of a log file is to capture everything for debugging. Console logger respects the user's level.

### 4. Add `--log-file <path>` option to `analyze.ts`

- Add to Commander options (line ~222, near `--log-level`).
- Add `logFile?: string` to the options type on line 238.
- Pass to `createLogger(logLevel, { logFile: options.logFile })`.
- That's it. Three lines changed in the CLI.

### 5. Export new classes from `core/index.ts`

Update the logging export line to include `FileLogger` and `MultiLogger`. Users of the core library may want to use them directly (e.g., MCP server, tests).

### 6. Tests

Add to `test/unit/logging/Logger.test.ts`:

**FileLogger tests:**
- Creates file on construction (truncates existing)
- Writes messages with correct format (timestamp, level, message, context)
- Respects log level filtering
- Handles circular references in context
- Creates parent directories
- Resolves relative paths

**MultiLogger tests:**
- Delegates to all wrapped loggers
- Each logger applies its own level filtering independently
- Works with 0, 1, N loggers

**createLogger with logFile option:**
- Returns MultiLogger when logFile provided
- Returns ConsoleLogger when logFile not provided (backward compat)
- File contains all log levels when console is filtered

All tests use `os.tmpdir()` for file paths, clean up in `afterEach`.

## Files Modified

| File | Change |
|------|--------|
| `packages/core/src/logging/Logger.ts` | Add FileLogger, MultiLogger, extend createLogger |
| `packages/cli/src/commands/analyze.ts` | Add --log-file option (3 lines) |
| `packages/core/src/index.ts` | Export FileLogger, MultiLogger |
| `test/unit/logging/Logger.test.ts` | Add tests for new classes |

## What This Does NOT Do

- Does not add `--quiet` (already exists)
- Does not change progress renderer behavior
- Does not modify the Logger interface
- Does not touch the types package
- Does not add streaming/async file writes (unnecessary for log lines)
- Does not add log rotation (out of scope, future feature if needed)

## Acceptance Criteria Mapping

| Criterion | How It's Met |
|-----------|-------------|
| `--log-file` option accepts a file path | Commander option, passed to createLogger |
| All log output written to file | FileLogger at 'debug' level captures everything |
| File created/overwritten on each run | FileLogger constructor truncates file |
| stdout still shows progress | Console logger + progress renderer unchanged |
| Path can be relative or absolute | `path.resolve()` in FileLogger constructor |

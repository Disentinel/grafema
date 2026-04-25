# HIGH-LEVEL PLAN FOR REG-78: Error Handling & Diagnostics

**Author:** Don Melton (Tech Lead)

## Current State Analysis

### What's Good
- Plugin system already has `PluginResult.errors[]` and `PluginResult.warnings[]` fields designed for structured errors
- CLI uses Commander.js which has built-in option parsing
- Basic error detection exists (existsSync checks, try-catch blocks)
- Some commands already use meaningful error messages (init.ts)

### What's Broken
1. **Silent Failures** (CRITICAL)
   - 6+ catch blocks in GitPlugin silently return empty/null instead of logging
   - JSModuleIndexer silently ignores parse failures for non-.json files
   - SimpleProjectDiscovery is only plugin properly using createErrorResult()
   - Orchestrator doesn't capture/report plugin errors to user

2. **No Structured Error Handling**
   - 175+ console.log/error/warn calls with no standardization
   - No error classification (fatal vs warning vs info)
   - No context propagation through the analysis pipeline
   - PluginResult.errors[] populated by ~10% of plugins

3. **Poor User Experience**
   - Error messages don't suggest recovery ("missing git access" → no message; silent skip)
   - No debug mode to understand why analysis stopped/skipped
   - Database errors repeated 4+ times across commands
   - No distinction between retryable vs permanent failures

4. **Missing Diagnostics**
   - No verbose/debug flag in CLI (only `-q/--quiet` for analyze)
   - No analysis progress tracking for errors
   - No summary of skipped files/services at end
   - No error logs file written to .grafema/

---

## Proposed Architecture

### 1. Structured Error System

**Create `packages/core/src/errors/`:**

```
GrafemaError (abstract base)
├── ConfigError (config.json invalid, missing required fields)
├── FileAccessError (git access denied, file unreadable, permissions)
├── LanguageError (unsupported file type, unparseable syntax)
├── DatabaseError (rfdb connection, corruption, lock)
├── PluginError (plugin failed, dependency missing)
└── AnalysisError (internal analyzer failure, timeout)
```

Each error type:
- Has error code (e.g., `ERR_GIT_ACCESS`, `ERR_UNSUPPORTED_LANG`)
- Carries context: file path, line number, suggestion for recovery
- Distinguishes: fatal (stop) vs recoverable (continue) vs warning (log only)
- Implements standard message format

### 2. Diagnostic System

**Create `packages/core/src/diagnostics/`:**

- `DiagnosticCollector`: Accumulates errors/warnings during analysis
- `DiagnosticReporter`: Formats for CLI output (human vs JSON vs machine)
- `DiagnosticWriter`: Saves to `.grafema/diagnostics.log` (debug mode)

**Config additions to OrchestratorConfig:**
```typescript
verbose?: boolean;        // Enable all logging
debug?: boolean;          // Enable debug mode + file logging
logLevel?: 'silent' | 'errors' | 'warnings' | 'info' | 'debug'
```

### 3. Logging Infrastructure

**Create `packages/core/src/logging/`:**

- `Logger` interface with methods: `error()`, `warn()`, `info()`, `debug()`, `trace()`
- `ConsoleLogger` implementation (respects logLevel)
- `DiagnosticLogger` implementation (writes to file + console)
- Pass logger through PluginContext

**Replace all 175+ console calls with contextual logging:**
- Include phase, plugin name, file context
- Use logger.error() for failures, logger.warn() for non-fatal issues

### 4. Error Recovery Strategies

**Per error type:**

| Error | Recoverable? | Action |
|-------|:------------:|--------|
| Git access denied | No | Stop analysis; suggest `git config --global core.safecrlf false` |
| File unreadable | Yes | Skip file; warn user |
| Unsupported language | Yes | Skip file; log; continue |
| Database corrupted | No | Stop; suggest `grafema analyze --clear` |
| Plugin dependency missing | No | Stop; suggest npm install |
| Parse timeout (file too large) | Yes | Skip file; suggest increasing maxFileSize |

---

## Key Principles

1. **No Silent Failures**
   - Every catch block must either:
     - Throw a structured GrafemaError, OR
     - Log via diagnostic system with error code
   - Silent returns only if explicitly recoverable + logged

2. **Context-Aware Messages**
   - Error includes: WHAT failed, WHERE (file/line), WHY, WHAT TO DO
   - Example: `ERR_PARSE_FAILURE (unsupported-lang): /src/app.rs is Rust, not JavaScript. Run "grafema analyze --language=rust" or use RustAnalyzer plugin.`

3. **Progressive Disclosure**
   - Default: only errors + summaries
   - `--verbose`: add warnings, file counts, timing per plugin
   - `--debug`: everything + trace logs + write diagnostics.log

4. **User-Friendly Output**
   - Exit codes: 0 (success), 1 (error, stop), 2 (warning, incomplete results)
   - Color coding: red (error), yellow (warning), green (success), cyan (info)
   - Progress bars for long operations
   - Final summary: "Analyzed 450 files (25 skipped: 10 unsupported language, 8 parse errors, 7 timeout)"

---

## Implementation Phases

### Phase 1: Error Types & Diagnostics (Week 1)
- Define GrafemaError hierarchy
- Create DiagnosticCollector/Reporter/Writer
- Create Logger interface + implementations
- **Acceptance:** Error types exist, logger passed through PluginContext

### Phase 2: CLI & Core Updates (Week 2)
- Add `--verbose`, `--debug` flags to all commands
- Replace console.log/error with logger calls
- Catch all errors in Orchestrator, surface via diagnostics
- Add diagnostics.log file writing in debug mode
- **Acceptance:** analyze command logs with structured errors

### Phase 3: GitPlugin & Silent Failures (Week 2)
- Replace catch blocks in GitPlugin with structured errors
- JSModuleIndexer: log parse failures instead of silent return
- All plugins: populate PluginResult.errors[] and .warnings[]
- **Acceptance:** No silent failures; all errors logged

### Phase 4: Recovery & User Messages (Week 3)
- Implement recovery strategies per error type
- Add helpful suggestions to error messages
- Add summary statistics at end of analysis
- Distinguish fatal vs recoverable vs warning
- **Acceptance:** Error messages include recovery suggestions; summary shows impact

### Phase 5: Testing & Documentation (Week 3)
- Unit tests for error handling per plugin
- Integration tests for diagnostics collection/reporting
- Document error codes in README
- **Acceptance:** 80%+ error path coverage

---

## Risks & Considerations

1. **Breaking Changes**
   - PluginResult.errors[] currently ignored; changing to required may break plugins
   - Mitigation: Make it optional in Phase 1, mandatory in Phase 2

2. **Performance**
   - Logging overhead in hot paths (parse, indexing)
   - Mitigation: Use lazy evaluation for debug logs; batch diagnostics writes

3. **Backward Compatibility**
   - Existing scripts may depend on specific console output format
   - Mitigation: Keep plain text output as default; add `--json` for machine parsing

4. **Scope Creep**
   - "Error handling" could expand to retry logic, parallel error collection, etc.
   - Mitigation: Stay focused on visibility + recovery suggestions; defer advanced retry to REG-XX

---

## Success Criteria

- [ ] All catch blocks either throw or log with error code
- [ ] `grafema analyze --verbose` shows file-by-file progress
- [ ] `grafema analyze --debug` writes `.grafema/diagnostics.log`
- [ ] Missing git access produces message: `ERR_GIT_NOT_FOUND: No .git directory found at <path>`
- [ ] Unsupported language: `ERR_UNSUPPORTED_LANG: <file.rs> is Rust (not JavaScript). Use RustAnalyzer plugin.`
- [ ] Analysis end message includes: `Analyzed 450 files (25 skipped, 10 errors, 5 warnings)`
- [ ] Error messages are consistent across commands and plugins
- [ ] 80%+ of error paths covered by tests
- [ ] No console.log calls outside of Logger interface

---

## Next Steps (For Joel)

1. Review this plan for technical feasibility
2. Identify if GrafemaError hierarchy aligns with actual error categories
3. Estimate effort for Logger integration vs creating new logging lib
4. Decide: use Winston/Pino/custom Logger?
5. Finalize recovery strategies per error type
6. Create detailed tech spec for Phase 1

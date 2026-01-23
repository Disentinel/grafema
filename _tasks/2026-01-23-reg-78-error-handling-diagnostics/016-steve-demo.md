# Demo Report - REG-78: Error Handling & Diagnostics

**Author:** Steve Jobs (Product Design / Demo)
**Date:** January 23, 2026
**Status:** ITERATE

---

## Demo Summary

I demoed the error handling and diagnostics feature (REG-78). The core architecture is solid, but the **user experience is NOT ready for the stage**.

---

## What I Tested

### 1. `grafema analyze --help`

```
Options:
  -s, --service <name>  Analyze only a specific service
  -c, --clear           Clear existing database before analysis
  -q, --quiet           Suppress progress output
  -v, --verbose         Show verbose logging
  --debug               Enable debug mode (writes diagnostics.log)
  --log-level <level>   Set log level (debug, info, warn, error) (default: "info")
```

**Verdict:** Good. The new flags are present and documented.

---

### 2. `grafema analyze --debug test/fixtures/01-simple-script`

- Analysis completed successfully
- `diagnostics.log` was created in `.grafema/` directory
- File was empty (no errors occurred)
- Message shown: `Diagnostics written to /path/.grafema/diagnostics.log`

**Verdict:** Works, but...

**Problem:** When there are no errors, the diagnostics.log is empty. The message says "Diagnostics written" but there's nothing in the file. That's confusing.

---

### 3. Verbose Mode (`-v`)

Produces detailed per-plugin progress output:
```
[discovery] Discovering services...
[discovery] Running SimpleProjectDiscovery... (1/1)
[indexing] Running plugin 1/1: JSModuleIndexer
[analysis] Running plugin 1/6: JSASTAnalyzer
```

**Verdict:** Good. This is useful for debugging.

---

### 4. Quiet Mode (`-q`)

**BROKEN.** The `-q` flag is supposed to suppress progress output, but plugin logs still appear:

```bash
grafema analyze test/fixtures/01-simple-script --clear -q
```

Output still shows:
```
[RFDBServerBackend] RFDB server not running, starting...
[Orchestrator] Clearing entire graph...
[JSModuleIndexer] Building dependency tree...
[JSASTAnalyzer] Starting analysis...
[GraphConnectivityValidator] Starting connectivity validation...
...50+ more lines of output...
```

**Problem:** The `--quiet` flag only suppresses the `log()` function in the CLI, but ALL plugins write directly to `console.log`. This is not quiet at all.

---

### 5. Error Handling for Invalid Path

```bash
grafema analyze /nonexistent/path --debug
```

**Result:**
```
Error: ENOENT: no such file or directory, mkdir '/nonexistent/path/.grafema'
    at mkdirSync (node:fs:1372:26)
    ...raw stack trace...
```

**Verdict: UNACCEPTABLE.** This is a raw Node.js error with a stack trace. Where is the user-friendly error message? Where is the suggestion to check the path? This is exactly what REG-78 was supposed to fix.

---

## Success Criteria Evaluation

| Criterion | Status | Notes |
|-----------|--------|-------|
| Clear error for missing git access | NOT TESTED | No git-specific scenario demoed |
| Clear error for unsupported language | NOT TESTED | Architecture exists but not integrated |
| Clear error for repo skipped | NOT TESTED | No scenario to test |
| Debug mode for local diagnostics | PARTIAL | Works but empty file when no errors |

---

## Architecture Review

The **underlying architecture is good**:

1. **GrafemaError hierarchy** - Beautiful. ConfigError, FileAccessError, LanguageError, DatabaseError, PluginError, AnalysisError. Each has code, severity, suggestion.

2. **DiagnosticCollector** - Clean design. Collects errors, filters by phase/plugin/code, checks for fatal/error/warning.

3. **DiagnosticReporter** - Multi-format output (text, json, csv). Good summary generation.

4. **DiagnosticWriter** - Writes to `.grafema/diagnostics.log`.

**The problem:** None of this is actually being used! Plugins still print to console.log directly. The analyze command doesn't catch filesystem errors gracefully.

---

## What's Missing for "Stage-Ready"

### Critical Issues (Blockers)

1. **`--quiet` does nothing** - Plugin logs bypass the quiet flag. This is embarrassing.

2. **Raw stack traces shown to users** - Invalid path shows ENOENT with full stack trace instead of a friendly error message.

3. **No actual GrafemaError usage** - The beautiful error classes exist but I didn't see them being thrown by any plugin.

### Nice-to-Have

4. **Empty diagnostics.log** - Should either not create the file, or include a "No issues found" entry.

5. **No git access error demo** - Need a way to test this scenario.

---

## The Steve Jobs Question

> "Would I show this on stage?"

**NO.**

The architecture is there. The design documents are impressive. But when I actually USE the product:

- `-q` doesn't quiet anything
- Errors show raw stack traces
- The fancy error classes aren't being used

**This is prototype-quality, not product-quality.**

---

## Verdict: ITERATE

### What Needs to Happen

1. **Plugins must respect quiet mode** - Either pass a logger object that plugins use, or suppress stdout in quiet mode. Plugins should NOT call `console.log` directly.

2. **Wrap filesystem errors** - In analyze.ts, catch ENOENT/EACCES and throw FileAccessError with user-friendly message and suggestion.

3. **Show GrafemaError in action** - At least one real scenario where the structured error appears (e.g., try to analyze a directory without .git).

4. **Don't show "Diagnostics written" for empty file** - Either skip the file creation or say "No diagnostics to write".

---

## Files Reviewed

- `/Users/vadimr/grafema/packages/cli/src/commands/analyze.ts`
- `/Users/vadimr/grafema/packages/core/src/errors/GrafemaError.ts`
- `/Users/vadimr/grafema/packages/core/src/diagnostics/DiagnosticCollector.ts`
- `/Users/vadimr/grafema/packages/core/src/diagnostics/DiagnosticReporter.ts`

---

**Bottom line:** The foundation is solid, but the UX is not there yet. We built the engine but forgot to connect it to the steering wheel.

Back to implementation.

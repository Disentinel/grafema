# Don Melton: REG-350 Analysis

## Summary

I've analyzed the codebase architecture for REG-350 (CLI progress visibility during analysis).

## Current Architecture

**Orchestrator.ts** (packages/core/src/Orchestrator.ts):
- Already has a `ProgressCallback` interface defined
- Already calls `onProgress()` at 13+ strategic points during the 5 phases
- Progress data includes: `phase`, `currentPlugin`, `message`, `totalFiles`, `processedFiles`, `servicesAnalyzed`
- Already passes `onProgress` callback from Orchestrator → PluginContext

**analyze.ts** (packages/cli/src/commands/analyze.ts):
- Currently only uses `onProgress` when `--verbose` flag is set
- Only logs: `[${progress.phase}] ${progress.message}`
- No visual indicator or spinner, just raw console.log

**Logger.ts** (packages/core/src/logging/Logger.ts):
- Lightweight, zero-dependency implementation
- 5 log levels: silent, errors, warnings, info, debug
- Safe for structured logging but NOT designed for interactive progress

**CLI Dependencies**:
- Already has `ink` (React for CLI) v6.6.0 and `react` v19.2.3 in CLI package
- Has `commander` v13.0.0 for CLI parsing
- Does NOT have ora, listr2, or other progress libraries (intentionally lightweight)

## Prior Art Research

| Library | Purpose | Pros | Cons |
|---------|---------|------|------|
| **ora** | Single spinner | Lightweight, simple API | New dependency |
| **listr2** | Task orchestration | Professional UX, concurrent tasks | Heavy, overkill |
| **multispinner** | Multiple spinners | Simple, concurrent | Less maintained |
| **cli-progress** | Progress bars | Detailed bars | File-upload focused |

## Three Options

### OPTION 1: Use Existing onProgress + Console Spinner (Recommended)

**Pros:**
- Zero new dependencies (already has everything needed)
- Minimal code change (30-50 lines in analyze.ts)
- Works with existing Orchestrator architecture
- Can use ink (React) that's already in package.json or simple console approach

**Cons:**
- Manual spinner management
- Limited to what CLI natively supports

### OPTION 2: Add ora Dependency

**Pros:**
- Battle-tested, minimal dependency
- Clean API, handles TTY detection
- Cross-platform (Windows support)

**Cons:**
- New dependency
- Single spinner only

### OPTION 3: Use listr2

**Pros:**
- Professional task lists
- Built for multi-phase operations

**Cons:**
- Significant dependency
- Goes against lightweight philosophy

## Architecture Decision

**Critical insight:** Progress events should NOT be added to plugins or enrichers. They're already properly emitted at the Orchestrator level. The problem is CLI isn't showing them properly.

1. **Core** (Orchestrator.ts) ← Emits progress events (already done!)
2. **CLI** (analyze.ts) ← Consumes progress events (needs improvement)

## My Recommendation: OPTION 1 (No Dependencies)

**Why:**
1. Grafema's philosophy is lightweight and zero-dependency core
2. Orchestrator already has perfect progress events
3. Adding ora/listr2 sets precedent for more dependencies
4. Can implement with 30-50 lines of code

## High-level Implementation

```
1. Create ProgressRenderer class in packages/cli/src/utils/
   - Track phase transitions
   - Display formatted output: [phase#/5] phase_name... details
   - Handle spinner animation

2. Update analyze.ts:
   - Remove --verbose condition on onProgress
   - Always show progress (unless --quiet)

3. Output format:
   [1/5] Discovery... 12 services found
   [2/5] Indexing... 4047/4047 modules
   [3/5] Analysis... 4047/4047 modules
   [4/5] Enrichment... ImportExportLinker, MethodCallResolver...
   [5/5] Validation... 3 plugins
   Analysis complete in 234.56s
```

## Complexity & Architecture Checklist

- ✅ **Complexity:** O(1) per progress event (no iteration over all nodes)
- ✅ **Plugin Architecture:** Uses existing forward registration (onProgress callback)
- ✅ **Extensibility:** CLI concern only, core untouched
- ✅ **No Brute-Force:** Uses event-driven model

## Risk Assessment

**LOW:** All infrastructure exists, just needs UI layer. All tests pass with onProgress noop (backwards compatible).

## Sources

- [Ora - npm](https://www.npmjs.com/package/ora)
- [listr2 - npm](https://www.npmjs.com/package/listr2)
- [CLI Progress - npm](https://www.npmjs.com/package/cli-progress)

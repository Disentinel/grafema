# Joel Spolsky: REG-350 Technical Specification

## Overview

Implement a ProgressRenderer class to display real-time analysis progress during `grafema analyze` command. The renderer will consume the existing `onProgress` callback from Orchestrator and format progress events as a clean, human-readable display.

## Current State Analysis

### ProgressCallback Interface (Core)
**File:** `packages/core/src/Orchestrator.ts` (lines 25-37)

```typescript
export interface ProgressInfo {
  phase: string;                  // 'discovery', 'indexing', 'analysis', 'enrichment', 'validation'
  currentPlugin?: string;         // Plugin name currently executing
  message?: string;               // Current status message
  totalFiles?: number;            // For phases with file iteration
  processedFiles?: number;        // Files processed so far
  servicesAnalyzed?: number;      // Services analyzed
}

export type ProgressCallback = (info: ProgressInfo) => void;
```

### Progress Events Currently Emitted
Orchestrator emits 13+ progress events throughout 5 phases:
1. **DISCOVERY** (lines 219, 248, 608-640)
   - Start: "Starting discovery..."
   - Plugin updates: "Running {pluginName}..."
   - Complete: "Found X services, Y entrypoints"

2. **INDEXING** (lines 279-336)
   - Start: "Building dependency trees..."
   - Progress: "Batch indexing..." with `processedFiles` updates
   - Per-unit: "Indexed {unit} (Xs)"

3. **ANALYSIS** (lines 350-410)
   - Start: "Analyzing all units..."
   - Progress: "Batch analyzing..." with `processedFiles` updates
   - Per-unit: "Analyzed {unit} (Xs)"

4. **ENRICHMENT** (lines 418-421)
   - Start: "Starting enrichment..."
   - Per-plugin: "Running plugin X/Y: {pluginName}"
   - Complete: "✓ {pluginName} complete"

5. **VALIDATION** (lines 447-450)
   - Start: "Starting validation..."
   - Per-plugin: "Running plugin X/Y: {pluginName}"
   - Complete: "✓ {pluginName} complete"

### Current CLI Usage
**File:** `packages/cli/src/commands/analyze.ts` (lines 288-292)

```typescript
onProgress: (progress) => {
  if (options.verbose) {  // ← ONLY shown with --verbose!
    log(`[${progress.phase}] ${progress.message}`);
  }
},
```

**Problem:** Progress is hidden by default, only shown with `--verbose` flag.

### Existing Patterns

**errorFormatter.ts:** Simple, no-dependency CLI formatting utility
```typescript
export function exitWithError(title: string, nextSteps?: string[]): never {
  console.error(`✗ ${title}`);
  for (const step of nextSteps) {
    console.error(`→ ${step}`);
  }
  process.exit(1);
}
```

**codePreview.ts:** Utility module with clear separation of concerns
- Interface definitions
- Helper functions (no classes)
- Composable, testable

**TTY Detection (init.ts line 206):**
```typescript
return options.yes !== true && process.stdin.isTTY === true;
```

## Design Specification

### 1. ProgressRenderer Class

**Location:** `packages/cli/src/utils/progressRenderer.ts`

**Responsibility:**
- Track state across progress events
- Format output according to display mode (TTY vs non-TTY)
- Manage spinner animation (TTY only)
- Calculate and display phase numbers [X/5]

**Properties:**

```typescript
private phases: string[] = ['discovery', 'indexing', 'analysis', 'enrichment', 'validation'];
private currentPhaseIndex: number = -1;
private currentPhase: string = '';
private currentPlugin: string = '';
private message: string = '';
private totalFiles: number = 0;
private processedFiles: number = 0;
private servicesAnalyzed: number = 0;
private spinnerIndex: number = 0;
private isInteractive: boolean;  // TTY or not
private startTime: number;
private lastDisplayTime: number = 0;
private displayThrottle: number = 100;  // ms between updates
```

**Constructor:**

```typescript
constructor(options?: { isInteractive?: boolean; throttle?: number }) {
  // Detect TTY: prefer passed option, fall back to process.stdout.isTTY
  this.isInteractive = options?.isInteractive ?? process.stdout.isTTY ?? false;
  this.displayThrottle = options?.throttle ?? 100;
  this.startTime = Date.now();
}
```

**Complexity Analysis:**
- `update()`: O(1) - just state mutation and conditional console.log
- `format()`: O(n) where n = number of active plugins in enrichment/validation (typically 3-8)
- No iteration over file sets, graph nodes, or project data
- Throttled output prevents excessive console I/O

### 2. Display Format (Output Target)

**Interactive (TTY) Mode:**
```
[1/5] Discovery... 12 services found
[2/5] Indexing... 4047/4047 modules completed
[3/5] Analysis... 2150/4047 modules  ← Updates in real-time with spinner
[4/5] Enrichment... (ImportExportLinker, MethodCallResolver...)
[5/5] Validation... (CallResolverValidator, EvalBanValidator...)
Analysis complete in 234.56s
```

**Non-Interactive (CI/Logging) Mode:**
```
[discovery] Discovering services...
[discovery] Found 12 services, 0 entrypoints
[indexing] Building dependency trees...
[indexing] Batch indexing... [1-10/10] Batch indexing...
[indexing] Indexed service-a (2.34s)
...
[analysis] Analysis complete
[enrichment] Enrichment complete
[validation] Validation complete
Analysis complete in 234.56s
```

### 3. Spinner Animation (TTY Only)

**Frames:** 4-frame spinner to avoid excessive output
```typescript
private spinnerFrames = ['⠋', '⠙', '⠹', '⠸'];  // Braille pattern
```

Or simpler if braille not supported:
```typescript
private spinnerFrames = ['⠏', '⠛', '⠫', '⠾'];
// Fallback: ['|', '/', '-', '\\']
```

**Update Logic:**
- Increment spinner index on each `update()` call
- Only update display if throttle time passed and TTY mode

### 4. Method Signatures

```typescript
export class ProgressRenderer {
  /**
   * Process a progress event from Orchestrator
   * @param info - ProgressInfo from onProgress callback
   */
  update(info: ProgressInfo): void {
    // Update internal state
    // Check throttle timing
    // Call display() if due
  }

  /**
   * Format and display current state to console
   * @private
   */
  private display(): void {
    // Clear previous line in TTY mode (ANSI escape)
    // Render formatted progress
    // Update lastDisplayTime
  }

  /**
   * Get formatted phase name with number
   * @private
   */
  private getPhaseLabel(): string {
    // Returns "[3/5] Analysis" or similar
  }

  /**
   * Format progress for current phase
   * @private
   */
  private formatPhaseProgress(): string {
    // Format based on phase type
    // Return: "[3/5] Analysis... 2150/4047 modules"
  }

  /**
   * Format enrichment/validation phase plugins
   * @private
   */
  private formatPluginList(plugins: string[]): string {
    // Return: "(..., ...)" or plugin listing
  }

  /**
   * Get final summary after analysis complete
   * @param durationSeconds - Total duration
   */
  finish(durationSeconds: number): string {
    // Return: "Analysis complete in 234.56s"
  }

  /**
   * Helper: Update phase index
   * @private
   */
  private updatePhaseIndex(phase: string): void {
    // Find phase in ['discovery', 'indexing', 'analysis', 'enrichment', 'validation']
    // Update currentPhaseIndex if changed
  }
}
```

### 5. Integration Points

**analyze.ts Changes:**

1. Import ProgressRenderer:
```typescript
import { ProgressRenderer } from '../utils/progressRenderer.js';
```

2. Create instance before Orchestrator:
```typescript
const renderer = new ProgressRenderer({ isInteractive: !options.quiet });
```

3. Replace progress callback:
```typescript
const orchestrator = new Orchestrator({
  // ... other options
  onProgress: (progress) => {
    renderer.update(progress);
  },
});
```

4. Display final summary after analysis:
```typescript
const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
log(renderer.finish(parseFloat(elapsed)));
```

**No changes to:** Orchestrator.ts, Logger.ts, or any core modules

### 6. Test Cases

**File:** `packages/cli/test/progressRenderer.test.ts`

```typescript
// Test 1: Phase transitions
// Verify phase index updates correctly when switching phases

// Test 2: Progress accumulation
// Verify processedFiles increases and displays correctly

// Test 3: TTY detection
// Verify isInteractive determined by environment

// Test 4: Throttling
// Verify display not called more than once per throttle interval

// Test 5: Format accuracy
// Verify output format matches specification for each phase

// Test 6: Spinner animation
// Verify spinner index increments on each update

// Test 7: Plugin list formatting
// Verify comma-separated plugin names in parentheses

// Test 8: Finish message
// Verify final summary includes correct duration
```

**Test Approach:** No mocking needed
- Create ProgressRenderer instance
- Call `update()` with mock ProgressInfo
- Capture console.log output
- Verify format matches expected string

### 7. Special Considerations

**TTY Detection:**
- Primary: `process.stdout.isTTY`
- Override via constructor option for testing
- Default: `false` if no TTY (safe fallback)

**Output Clearing:**
- TTY: Use ANSI escape `\r` (carriage return) to overwrite line
- Non-TTY: Append newline (don't overwrite)
- Fallback: Just log, accept duplicate lines if ANSI not supported

**Throttling:**
- Default: 100ms between display updates
- Prevents excessive I/O
- Progress events come faster than user can read anyway

**Backwards Compatibility:**
- `--verbose` flag still works (enable debug logging)
- Progress always shown in non-quiet mode
- Old scripts with only `--quiet` not affected

### 8. Error Handling

**What should NOT happen:**
- No try-catch in ProgressRenderer (it's a UI layer)
- If console.log fails, let it bubble (not our problem)
- Invalid ProgressInfo → just ignore it, continue

**Edge cases to handle:**
- First update before phase determined: show "..."
- Missing phase in phases array: show raw phase string
- NaN in file counts: default to 0
- Very long plugin names: truncate gracefully

### 9. Performance Budget

- **Time:** ProgressRenderer.update() < 1ms (state mutation only)
- **Memory:** O(1) - fixed set of properties, no collections
- **I/O:** 1 console.log per throttle interval (non-blocking)

Total impact on `grafema analyze` runtime: < 0.1% overhead

## Implementation Steps

### Step 1: Create ProgressRenderer Class
- File: `packages/cli/src/utils/progressRenderer.ts`
- Define interface, class skeleton, property initialization
- Implement `update()` method with phase tracking
- Implement spinner animation logic

**Estimated effort:** 200-250 lines, 45-60 min

### Step 2: Implement Display Formatting
- Implement `display()` method with TTY vs non-TTY branches
- Implement `getPhaseLabel()` 
- Implement `formatPhaseProgress()` 
- Implement `formatPluginList()` for enrichment/validation
- Implement `finish()` for final summary

**Estimated effort:** 150-200 lines, 45-60 min

### Step 3: Write Test Suite
- File: `packages/cli/test/progressRenderer.test.ts`
- Test each method independently
- Test phase transitions
- Test output formatting
- Test TTY vs non-TTY modes

**Estimated effort:** 300-400 lines, 90-120 min

### Step 4: Integrate with analyze.ts
- Import ProgressRenderer
- Create instance before Orchestrator
- Replace onProgress callback
- Add renderer.finish() call
- Remove --verbose condition on progress display

**Estimated effort:** 20-30 lines, 15-20 min

### Step 5: Integration Testing
- Run `grafema analyze` on test project
- Verify output formatting in TTY and non-TTY
- Verify --quiet still works
- Verify --verbose still shows debug logs
- Verify timing accuracy

**Estimated effort:** 30-45 min

## Acceptance Criteria

1. ✓ Progress displayed by default (not just with --verbose)
2. ✓ Format matches specification: [X/5] PhaseName... details
3. ✓ TTY detection works (spinner animation in interactive, clean lines in CI)
4. ✓ No new dependencies added
5. ✓ No changes to Orchestrator.ts or core modules
6. ✓ All tests pass
7. ✓ `--quiet` flag still suppresses all progress
8. ✓ Final timing accurate (matches Profiler.printSummary())
9. ✓ 100% backwards compatible with existing scripts

## Risk Assessment

**LOW RISK** - All infrastructure exists
- ProgressCallback already working
- Orchestrator emits events correctly
- Logger system handles --quiet and --verbose
- No core changes needed
- UI-only concern (ProgressRenderer)

**Why low risk:**
- Isolated to CLI package only
- ProgressRenderer is pure state management
- Console I/O can be mocked or suppressed
- No graph traversal or complex logic
- Fallback: if broken, just don't show progress (graceful degradation)

## Open Questions for High-Level Review

1. **Spinner character choice:** Braille (⠋⠙⠹⠸) or ASCII (|/-\)?
2. **ANSI support:** Should we detect NO_COLOR env var?
3. **Enrichment/validation plugin listing:** Show all 10+ plugins or truncate?
4. **Duration format:** "234.56s" or "3m 54.56s" for readability?

(Answers will be determined during Uncle Bob's code quality review and Steve/Вадим's high-level approval)

# Don Melton Plan: REG-347 Loading Indicators

## Decision: Minimal Terminal Spinner (No Dependencies)

Implement a simple, zero-dependency spinner that displays when queries take longer than 100ms.

## Rationale

**Why not Ink (React TUI)?**
- Ink is already used in `explore.tsx` for interactive mode, but overkill for simple loading indicators
- Adds rendering overhead and complexity for a single-line spinner
- The affected commands are simple: connect → query → output → close
- Mixing Ink with regular console output creates complexity

**Why not add ora/cli-spinners/nanospinner?**
- Project prefers minimal dependencies (DRY/KISS principle)
- Spinner functionality is trivial: ~30 LOC for basic implementation
- We only need: TTY detection, frame animation, cleanup on exit
- References from web search show ora's core is simple: TTY check + setInterval + cursor manipulation

**Why manual implementation?**
- Full control over behavior
- No new dependencies to maintain
- Learning from ora's patterns (TTY detection, non-interactive handling)
- Matches project culture (prefer obvious code over clever libraries)

## Requirements

### 1. Non-Blocking Display
- Show spinner ONLY if operation takes >100ms
- Do not delay query execution to show spinner
- Use setTimeout to defer spinner display

### 2. TTY Detection (Critical)
From web search findings on CLI best practices:
- **Interactive (TTY)**: Show animated spinner with frames
- **Non-interactive (CI/piped)**: No spinner, no extra output
- **Detect**: `process.stdout.isTTY && process.stderr.isTTY`
- **Fallback**: Silent operation in non-TTY (no clutter in logs)

Pattern from ora research:
```
if (process.stdout.isTTY) {
  // Show spinner frames
} else {
  // Silent or single-line status
}
```

### 3. Consistent Behavior
All three commands must work identically:
- `grafema query <pattern>`
- `grafema ls --type <type>`
- `grafema get <semantic-id>`

### 4. Visual Design
**In TTY:**
```
⠋ Querying graph...
```

**Non-TTY:**
- No spinner
- No extra output
- Query runs silently

**Animation frames:** Use simple braille spinner (ora default)
```
['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
```
Interval: 80ms (smooth but not distracting)

### 5. Cleanup
- Clear spinner line on completion (success or error)
- Use `process.stdout.clearLine()` + `process.stdout.cursorTo(0)`
- Handle Ctrl+C gracefully (cleanup before exit)

## Implementation Outline

### Phase 1: Create Shared Spinner Utility
**File:** `packages/cli/src/utils/spinner.ts`

```typescript
/**
 * Simple terminal spinner for slow operations
 *
 * Usage:
 *   const spinner = new Spinner('Loading...');
 *   spinner.start();
 *   await slowOperation();
 *   spinner.stop();
 */
export class Spinner {
  private message: string;
  private frames: string[];
  private interval: NodeJS.Timeout | null;
  private frameIndex: number;
  private startTime: number;
  private displayDelay: number;
  private displayTimer: NodeJS.Timeout | null;
  private isSpinning: boolean;

  constructor(message: string, displayDelay = 100) {
    this.message = message;
    this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.interval = null;
    this.displayTimer = null;
    this.frameIndex = 0;
    this.startTime = 0;
    this.displayDelay = displayDelay;
    this.isSpinning = false;
  }

  start(): void {
    // TTY check - ora pattern
    if (!process.stdout.isTTY) {
      return; // Silent in non-TTY
    }

    this.startTime = Date.now();

    // Defer display by displayDelay ms
    this.displayTimer = setTimeout(() => {
      this.isSpinning = true;
      this.render();

      // Animate frames
      this.interval = setInterval(() => {
        this.frameIndex = (this.frameIndex + 1) % this.frames.length;
        this.render();
      }, 80);
    }, this.displayDelay);
  }

  private render(): void {
    if (!this.isSpinning) return;

    const frame = this.frames[this.frameIndex];
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const timeStr = elapsed > 0 ? ` (${elapsed}s)` : '';

    process.stdout.clearLine(0);
    process.stdout.cursorTo(0);
    process.stdout.write(`${frame} ${this.message}${timeStr}`);
  }

  stop(): void {
    // Clear deferred display timer
    if (this.displayTimer) {
      clearTimeout(this.displayTimer);
      this.displayTimer = null;
    }

    // Stop animation
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    // Clear line if we were displaying
    if (this.isSpinning && process.stdout.isTTY) {
      process.stdout.clearLine(0);
      process.stdout.cursorTo(0);
    }

    this.isSpinning = false;
  }
}
```

**Key features:**
- TTY detection (ora pattern from web search)
- 100ms delay before showing spinner (avoids flicker on fast queries)
- Elapsed time display for long operations
- Graceful cleanup
- Zero dependencies

### Phase 2: Integrate into Commands

**Pattern for all three commands:**
```typescript
const spinner = new Spinner('Querying graph...');
spinner.start();

try {
  // ... existing query logic ...

  spinner.stop();

  // ... existing output logic ...
} catch (error) {
  spinner.stop();
  throw error;
}
```

**Specific integration points:**

1. **query.ts** (line ~130-160)
   - Start after `backend.connect()`
   - Stop before first `console.log` output

2. **ls.ts** (line ~65-85)
   - Start after `backend.connect()`
   - Stop before first output

3. **get.ts** (line ~65-85)
   - Start after `backend.connect()`
   - Stop before first output

### Phase 3: Handle Edge Cases

**Ctrl+C handling:**
Add cleanup handler in each command:
```typescript
process.on('SIGINT', () => {
  spinner.stop();
  process.exit(130); // Standard Ctrl+C exit code
});
```

**Error paths:**
Wrap all query sections in try/finally:
```typescript
try {
  spinner.start();
  await backend.connect();
  // ... query logic ...
} finally {
  spinner.stop();
}
```

## Concerns / Risks

### 1. Non-TTY Environments
**Risk:** Spinner breaks in CI, piped output, or non-interactive shells

**Mitigation:**
- Follow ora pattern: check `process.stdout.isTTY` before ANY output
- Web search shows this is standard practice across CLI tools
- Test in non-TTY: `grafema query "test" | cat`
- Test in CI-like env: `CI=true grafema query "test"`

### 2. Output Interference
**Risk:** Spinner leaves artifacts or interferes with command output

**Mitigation:**
- Always call `spinner.stop()` BEFORE any `console.log`
- Clear line + move cursor to column 0 on stop
- Test with `--json` output mode (must be clean JSON)

### 3. Fast Queries
**Risk:** Spinner flickers for queries <100ms (common on small graphs)

**Mitigation:**
- 100ms delay before display (avoids flicker)
- If query completes in <100ms, spinner never appears
- This matches ora behavior (web search reference)

### 4. Performance Overhead
**Risk:** Spinner adds measurable overhead on very fast queries

**Analysis:**
- Spinner uses setTimeout (non-blocking)
- setInterval runs only if displayed (after 100ms)
- Zero overhead if query completes <100ms
- Negligible overhead for displayed spinner (~1ms per frame)
- Acceptable tradeoff for UX improvement on slow queries

### 5. Multiline Output
**Risk:** Spinner doesn't clear properly if command outputs before stopping

**Mitigation:**
- ALWAYS call `spinner.stop()` before ANY output
- Make this pattern mandatory in implementation
- Add comment in spinner.ts: "MUST stop before console.log"

## Testing Strategy

### Manual Tests
1. **TTY mode:**
   ```bash
   grafema query "test"          # Spinner appears if >100ms
   grafema ls --type FUNCTION    # Spinner appears
   grafema get "some-node-id"    # Spinner appears
   ```

2. **Non-TTY mode:**
   ```bash
   grafema query "test" | cat          # No spinner, clean output
   grafema ls --type FUNCTION | jq .   # No spinner, valid JSON
   CI=true grafema query "test"        # No spinner
   ```

3. **Fast queries (<100ms):**
   - On small graph: spinner should NOT flicker

4. **Slow queries (>5s):**
   - Elapsed time counter should appear
   - Spinner animation should be smooth

5. **Ctrl+C:**
   - Press Ctrl+C during spinner
   - Terminal should be clean (no leftover spinner)

6. **Error cases:**
   - Trigger error during query
   - Spinner should clear before error message

### Edge Cases
- Empty result set (spinner clears properly)
- Very large result set (spinner doesn't interfere with streaming)
- JSON output mode (spinner doesn't corrupt JSON)
- Multiple rapid queries (no interference between spinners)

## Success Criteria

✅ All three commands show spinner when query >100ms
✅ No spinner in non-TTY environments
✅ No flicker on fast queries (<100ms)
✅ Clean terminal state on Ctrl+C
✅ Zero new dependencies added
✅ JSON output mode produces valid JSON (no spinner artifacts)
✅ Elapsed time displayed for queries >1s
✅ Code follows project patterns (DRY, KISS, obvious over clever)

## Alignment with Project Vision

**Does this move toward "AI should query the graph"?**
- ✅ Removes friction from slow queries (better UX = more usage)
- ✅ Loading feedback encourages waiting vs. Ctrl+C
- ✅ Elapsed time helps users understand graph complexity
- ⚠️ Doesn't fix root cause (query performance on large graphs)

**Future work (NOT this task):**
- Query optimization for large graphs
- Streaming results instead of batch fetch
- Progress indicators showing actual query progress (not just spinner)

**This task scope:**
- Improve UX for current slow query behavior
- Foundation for future progress indicators
- No architectural changes

---

## Appendix: Research References

From WebSearch findings:

**Ora TTY handling pattern:**
- Check `process.stdout.isTTY` before rendering
- Silent mode in non-TTY environments
- Standard across CLI ecosystem

**CLI UX best practices:**
- Non-interactive mode: avoid clutter in logs
- Progress updates: slower interval in non-dynamic terminals
- Detect TTY: `cli::is_dynamic_tty()` or equivalent

**Common mistakes to avoid:**
- Don't write spinner to stderr when stdout is piped
- Don't skip cleanup on error paths
- Don't assume TTY availability

**Braille spinner frames (ora default):**
```
⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏
```
Widely used, accessible, works in most terminals.

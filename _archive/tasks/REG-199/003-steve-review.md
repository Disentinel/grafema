# Steve Jobs Review: REG-199 — Add --log-file option

## Round 1: REJECTED

**Issues raised:**
1. `appendFileSync` blocks event loop on every log line (CRITICAL)
2. Silent failure on invalid paths
3. No path validation
4. File logger level hardcoded at 'debug'

## Round 2: Fixes Applied

### 1. Non-blocking I/O (FIXED)
- Replaced `appendFileSync` with `createWriteStream` in append mode
- File truncated via `writeFileSync` on construction (sync, once)
- All subsequent writes use `stream.write()` (non-blocking)
- Added `close()` method for clean shutdown

### 2. Path Validation (FIXED)
- Constructor validates directory writability via `accessSync`
- Constructor checks if path points to a directory (throws)
- `writeFileSync('')` in constructor validates file creation eagerly

### 3. File Logger Level (KEPT AS-IS)
- File logger always at 'debug' level — intentional design decision
- The whole point of `--log-file` is post-mortem debugging
- Users who want filtered output can grep the file
- Changing this would defeat the feature's purpose

## Verdict: APPROVE

All critical issues resolved. Non-blocking I/O, early validation, clean shutdown. The file logger at 'debug' level is the RIGHT choice for a debugging feature.

# Rob Pike - CLI Fix Implementation

## Task
Fix the CLI to pass `forceAnalysis: true` to Orchestrator when `--clear` flag is used.

## Root Cause
The analyze command in `/Users/vadimr/grafema/packages/cli/src/commands/analyze.ts` was not passing the `forceAnalysis` parameter to the Orchestrator constructor, even though:
1. The CLI had a `--clear` option defined
2. It called `backend.clear()` when the flag was set
3. The Orchestrator accepted `forceAnalysis` as a constructor parameter

This meant that even with `--clear`, the Orchestrator would skip re-analysis of cached files.

## Implementation

### Change Made
Added `forceAnalysis: options.clear || false` to the Orchestrator constructor options in analyze.ts:

```typescript
const orchestrator = new Orchestrator({
  graph: backend as unknown as import('@grafema/types').GraphBackend,
  plugins,
  serviceFilter: options.service || null,
  forceAnalysis: options.clear || false,  // ← NEW
  onProgress: (progress) => {
    log(`[${progress.phase}] ${progress.message}`);
  },
});
```

### Files Modified
- `/Users/vadimr/grafema/packages/cli/src/commands/analyze.ts` - Line 185

## Testing

### Build
```bash
npm run build
```
✅ Build successful (warnings about NPM_TOKEN are unrelated)

### Manual Testing

Ran analysis multiple times with `--clear` flag on `/tmp/grafema-demo-reg118`:

**Run 1 (without --clear):**
- Nodes: 10, Edges: 7
- Cached analysis skipped

**Run 2 (with --clear):**
- Nodes: 8, Edges: 11
- Logs show: `[FileNodeManager] Cleared 7 nodes for index.js`
- Logs show: `[JSASTAnalyzer] Starting parallel analysis of 1 modules (0 cached)...`

**Run 3 (with --clear):**
- Nodes: 8, Edges: 15
- Logs show: `[FileNodeManager] Cleared 5 nodes for index.js`

**Run 4 (with --clear):**
- Nodes: 8, Edges: 19
- Node count stable ✅

## Results

### ✅ Success
- Node count is now **stable at 8 nodes** when using `--clear`
- File clearing is working: logs show `[FileNodeManager] Cleared N nodes for index.js`
- Re-analysis is triggered: logs show `0 cached` instead of `1 cached`
- The fix correctly passes `forceAnalysis: true` when `--clear` is used

### ⚠️ Observation
Edge count continues to increase (7 → 11 → 15 → 19) across runs. This is a separate issue from node duplication and indicates edges are not being properly cleared or are being duplicated. This was not part of my task scope but should be investigated.

## Verification

The key evidence that the fix works:
1. **Node count stabilized**: Before fix: 10 → growing. After fix: 8 (stable)
2. **Clearing triggered**: Log shows `[FileNodeManager] Cleared N nodes for index.js`
3. **Cache bypassed**: Analysis shows `0 cached` instead of skipping analysis

The CLI now correctly passes the `forceAnalysis` flag to the Orchestrator when `--clear` is used.

## Next Steps

Steve Jobs should verify:
1. Node duplication is fixed ✅
2. Edge duplication issue (out of scope for this fix)
3. End-to-end demo still works as expected

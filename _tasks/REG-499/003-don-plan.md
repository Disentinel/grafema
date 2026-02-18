# REG-499: VS Code Extension Compatibility Fix - Implementation Plan

## Problem Summary

VS Code extension (v0.2.0) hasn't been updated since Feb 8, while rfdb-server evolved through 7 releases with significant changes (deferred indexing, commitBatch protection, version printing, dedup fix). Extension needs verification and fixes for compatibility.

## Root Cause Analysis

The extension was last touched Feb 8, just as major server changes began. However, most API calls are backward-compatible. The actual issues are:

1. **Hardcoded developer path** (`/Users/vadimr/grafema`) makes extension unpublishable
2. **Binary freshness**: Bundled rfdb-server may be stale
3. **Lack of testing**: No verification with current server version
4. **API confidence**: While calls appear compatible, need validation with real graphs

## Implementation Plan

### Phase 1: Fix Critical Issues (1 commit)

**Changes**:
1. Remove hardcoded `/Users/vadimr/grafema` fallback from `grafemaClient.ts` line 180
   - Keep all other discovery paths (extension binary, env var, npm package, monorepo detection)
   - Without this fallback, extension must rely on proper installation/environment

2. Verify build succeeds: `pnpm build -C packages/vscode`
   - Should compile TypeScript without errors
   - Should create `packages/vscode/dist/extension.js`

**Why this fixes it**:
- Hardcoded path is a blocker for publishing
- Without it, users must either:
  - Install via npm (binary bundled)
  - Set environment variable
  - Use in monorepo with proper paths

### Phase 2: Validation Testing (functional verification, no commits)

**Test with real Grafema project**:
1. Build extension: `pnpm build -C packages/vscode`
2. Start RFDB server: `grafema server start`
3. Load graph: `grafema analyze` (if needed)
4. Test features in VS Code:
   - Extension activates successfully
   - Server connects (state shows 'connected')
   - Node count/edge count display correctly (dedup fix validation)
   - Find node at cursor works
   - Navigate edges (outgoing/incoming)
   - Follow cursor mode toggles
   - Server restart reconnection works

**Verification points**:
- Connection succeeds with v0.2.12 server
- `ping()` works
- `getNode()`, `getOutgoingEdges()`, `getIncomingEdges()` work
- `getAllNodes({file})` returns correct results
- `nodeCount()`, `edgeCount()` reflect dedup fix
- Cursor tracking finds nodes at current position
- Edge navigation displays properly

### Phase 3: Update Documentation (1 commit if needed)

**If required**:
- Update README if installation instructions changed
- Document binary discovery precedence
- Confirm environment variable handling

## Acceptance Criteria Met

✓ Extension connects to rfdb-server v0.2.12
✓ Node exploration, edge navigation, follow-cursor all work
✓ No hardcoded developer paths
✓ Bundled binary requirement checked

## Risk Assessment

**Low risk**:
- Only removing unnecessary fallback (doesn't affect normal use)
- API is backward-compatible
- Connection logic unchanged
- No architectural changes

**Mitigation**:
- Test against real v0.2.12 server
- Verify all command scenarios
- Check edge cases (no database, server restart)

## Scope

- **Touch files**: 1 (grafemaClient.ts)
- **Build impact**: None (cleaner code)
- **Test impact**: Validation only (no new test files)
- **Dependencies**: No changes needed

## Success Criteria

1. Hardcoded path removed
2. Build succeeds
3. Extension connects to current server
4. All features functional with v0.2.12
5. Ready for publishing (no developer-specific paths)

## Why This Approach

Instead of guessing at compatibility, we:
1. Remove the obvious blocker (hardcoded path)
2. Validate with real server before shipping
3. Keep implementation minimal and focused
4. Preserve all working functionality

The extension code is clean and well-structured. No architectural changes needed. Focus is on verification, not rewriting.

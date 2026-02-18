# Don Melton — Plan: RFD-42

## Analysis

**Current state:**
- `RFDBClient.ping()` returns `string | false` — the server version from `CARGO_PKG_VERSION`, or `false`
- `RFDBServerBackend.connect()` calls `ping()` but discards the return value (lines 163, 188)
- `_negotiateProtocol()` calls `hello()` which also returns `serverVersion` — also discarded
- `GRAFEMA_VERSION` in `packages/core/src/version.ts` reads from `@grafema/core/package.json` — currently `0.2.11`
- Rust `Cargo.toml` still at `0.1.0` in dev (RFD-41 syncs it during release, but hasn't merged yet)

**Design decision: expected version source**
- Use `GRAFEMA_VERSION` from `packages/core/src/version.ts` — all packages are at the same version in release
- Compare using `getSchemaVersion()` to strip pre-release tags (e.g., `0.2.11-beta` vs `0.2.11` shouldn't warn)

**Design decision: where to validate**
- Best place: in `_negotiateProtocol()`, using `hello()` response's `serverVersion`
- This is cleaner than using `ping()` because:
  1. Only one validation point (no duplication between two connect paths)
  2. `hello()` is already called there
  3. `serverVersion` in `hello` is the canonical version field
- Fallback (hello fails = old server): always warn — if server is too old for `hello`, it's definitely outdated

**Design decision: warn vs fail**
- Task explicitly says "warn (not fail)" — use `this.log()` with clear message
- Don't throw, don't prevent connection

## Plan

### Files to modify

1. **`packages/core/src/storage/backends/RFDBServerBackend.ts`**
   - Import `GRAFEMA_VERSION` and `getSchemaVersion` from `../../version.js`
   - In `_negotiateProtocol()`: after getting hello response, compare `getSchemaVersion(hello.serverVersion)` with `getSchemaVersion(GRAFEMA_VERSION)`
   - If mismatch: `this.log()` warning
   - If hello fails (catch branch): warn about unknown server version

2. **Test file** — to verify the warning logic

### Implementation detail

```typescript
// In _negotiateProtocol():
private async _negotiateProtocol(): Promise<void> {
    if (!this.client) return;
    try {
      const hello = await this.client.hello(3);
      this.protocolVersion = hello.protocolVersion;
      this._checkServerVersion(hello.serverVersion);
    } catch {
      this.protocolVersion = 2;
      this.log('[RFDBServerBackend] WARNING: Server does not support version negotiation. Consider updating rfdb-server.');
    }
  }

private _checkServerVersion(serverVersion: string): void {
    const expected = getSchemaVersion(GRAFEMA_VERSION);
    const actual = getSchemaVersion(serverVersion);
    if (actual !== expected) {
      this.log(
        `[RFDBServerBackend] WARNING: rfdb-server version mismatch — ` +
        `server v${serverVersion}, expected v${GRAFEMA_VERSION}. ` +
        `Update with: grafema server restart`
      );
    }
  }
```

### Scope

- ~15 LOC in production code
- ~30-50 LOC in tests
- 1 file modified, 1 test file added/extended
- No architectural changes, no API changes

### Edge cases

1. Server version has pre-release tag → `getSchemaVersion()` strips it → correct comparison
2. Client version has pre-release tag → same stripping → correct
3. Server predates `hello` command → catch branch warns generically
4. `hello()` succeeds but `serverVersion` is undefined → needs null check
5. Both versions match → no warning, silent success
6. Dev environment (Cargo.toml 0.1.0 vs npm 0.2.11) → warning fires, correct behavior

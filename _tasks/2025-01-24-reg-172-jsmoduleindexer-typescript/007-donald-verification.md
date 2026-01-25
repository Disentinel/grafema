# Donald Knuth - Verification Report

## REG-172: JSModuleIndexer uses dist/ instead of src/ for TypeScript projects

---

## Executive Summary

**VERIFIED: Implementation is correct and complete.**

All acceptance criteria have been met. The implementation correctly detects TypeScript projects and prefers source files over compiled output.

---

## Test Environment

- **Build status:** Success (all 5 packages compiled)
- **Unit tests:** 17/17 pass
- **Integration tests:** 7/7 pass (manual verification)

---

## Acceptance Criteria Verification

### 1. Detect TypeScript projects (tsconfig.json exists)

**STATUS: PASS**

Test: TypeScript project with tsconfig.json
```bash
# Setup
mkdir -p /tmp/ts-test-project/src /tmp/ts-test-project/dist
echo '{"name": "test", "main": "dist/index.js"}' > /tmp/ts-test-project/package.json
echo '{"compilerOptions": {}}' > /tmp/ts-test-project/tsconfig.json
echo 'export const hello = "world";' > /tmp/ts-test-project/src/index.ts
echo 'module.exports = {};' > /tmp/ts-test-project/dist/index.js

# Result
grafema analyze /tmp/ts-test-project --verbose
[DEBUG] Processing file {"file":"/src/index.ts","depth":0}  # CORRECT!
```

Test: JavaScript project (no tsconfig.json) uses main field
```bash
# Setup (no tsconfig.json)
mkdir -p /tmp/js-test-project/src /tmp/js-test-project/dist
echo '{"name": "js-test", "main": "dist/index.js"}' > /tmp/js-test-project/package.json
echo 'export const hello = "world";' > /tmp/js-test-project/src/index.js
echo 'module.exports = {};' > /tmp/js-test-project/dist/index.js

# Result
grafema analyze /tmp/js-test-project --verbose
[DEBUG] Processing file {"file":"/dist/index.js","depth":0}  # CORRECT - falls back to main
```

### 2. Prefer src/ over dist/ for TypeScript

**STATUS: PASS**

This is the core fix. When `tsconfig.json` exists AND `src/index.ts` is found, it is used instead of `dist/index.js` from the `main` field.

The primary test above demonstrates this directly.

### 3. Support .ts, .tsx, .mts extensions

**STATUS: PASS**

Test: TSX support
```bash
# Setup
mkdir -p /tmp/tsx-test-project/src /tmp/tsx-test-project/dist
echo '{"name": "tsx-test", "main": "dist/index.js"}' > /tmp/tsx-test-project/package.json
echo '{"compilerOptions": {}}' > /tmp/tsx-test-project/tsconfig.json
echo 'export const App = () => <div>Hello</div>;' > /tmp/tsx-test-project/src/index.tsx
echo 'module.exports = {};' > /tmp/tsx-test-project/dist/index.js

# Result
grafema analyze /tmp/tsx-test-project --verbose
[DEBUG] Processing file {"file":"/src/index.tsx","depth":0}  # CORRECT!
```

Test: MTS support
```bash
# Setup
mkdir -p /tmp/mts-test-project/src /tmp/mts-test-project/dist
echo '{"name": "mts-test", "main": "dist/index.js", "type": "module"}' > /tmp/mts-test-project/package.json
echo '{"compilerOptions": {}}' > /tmp/mts-test-project/tsconfig.json
echo 'export const hello = "world";' > /tmp/mts-test-project/src/index.mts
echo 'export {};' > /tmp/mts-test-project/dist/index.js

# Result
grafema analyze /tmp/mts-test-project --verbose
[DEBUG] Processing file {"file":"/src/index.mts","depth":0}  # CORRECT!
```

Test: .ts preferred over .tsx when both exist
```bash
# Setup
mkdir -p /tmp/ts-tsx-test/src /tmp/ts-tsx-test/dist
echo '{"name": "ts-tsx-test", "main": "dist/index.js"}' > /tmp/ts-tsx-test/package.json
echo '{"compilerOptions": {}}' > /tmp/ts-tsx-test/tsconfig.json
echo 'export const hello = "world";' > /tmp/ts-tsx-test/src/index.ts
echo 'export const App = () => <div>Hello</div>;' > /tmp/ts-tsx-test/src/index.tsx
echo 'module.exports = {};' > /tmp/ts-tsx-test/dist/index.js

# Result
grafema analyze /tmp/ts-tsx-test --verbose
[DEBUG] Processing file {"file":"/src/index.ts","depth":0}  # CORRECT - .ts preferred
```

### 4. Fallback gracefully if source not found

**STATUS: PASS**

Test: TypeScript project with only compiled output
```bash
# Setup
mkdir -p /tmp/fallback-test-project/dist
echo '{"name": "fallback-test", "main": "dist/index.js"}' > /tmp/fallback-test-project/package.json
echo '{"compilerOptions": {}}' > /tmp/fallback-test-project/tsconfig.json
# No src folder at all!
echo 'module.exports = {};' > /tmp/fallback-test-project/dist/index.js

# Result
grafema analyze /tmp/fallback-test-project --verbose
[DEBUG] Processing file {"file":"/dist/index.js","depth":0}  # CORRECT - graceful fallback
```

---

## Additional Verification

### package.json "source" field support

**STATUS: PASS**

The `source` field in package.json is respected and takes priority over standard candidates.

```bash
# Setup
mkdir -p /tmp/source-field-test/src /tmp/source-field-test/lib /tmp/source-field-test/dist
echo '{"name": "source-field-test", "main": "dist/index.js", "source": "lib/custom-entry.ts"}' > /tmp/source-field-test/package.json
echo '{"compilerOptions": {}}' > /tmp/source-field-test/tsconfig.json
echo 'export const hello = "world";' > /tmp/source-field-test/src/index.ts
echo 'export const custom = "entry";' > /tmp/source-field-test/lib/custom-entry.ts
echo 'module.exports = {};' > /tmp/source-field-test/dist/index.js

# Result
grafema analyze /tmp/source-field-test --verbose
[DEBUG] Processing file {"file":"/lib/custom-entry.ts","depth":0}  # CORRECT - source field used
```

### Unit Tests

All 17 unit tests pass:

```
# tests 17
# suites 9
# pass 17
# fail 0
# cancelled 0
# skipped 0
```

Test coverage includes:
- TypeScript project detection (with/without tsconfig.json)
- package.json source field preference
- TSX file support
- .ts vs .tsx priority
- Alternative source locations (lib/, root-level)
- Fallback scenarios
- Monorepo package support
- Edge cases (.mts extension, empty package.json)

---

## Implementation Quality

### Correct
- Logic is sound and matches requirements exactly
- Priority order is well-defined: `source` field > standard candidates > `main` field > `index.js`
- File existence is checked before returning candidates

### Minimal
- Single utility function `resolveSourceEntrypoint()` handles all logic
- ~94 lines of new code
- Changes to existing files are minimal (import + one-line integration)

### Safe
- Graceful fallback preserves backward compatibility
- No breaking changes for JavaScript projects
- Empty/malformed package.json handled correctly

---

## Conclusion

The implementation of REG-172 is **verified and complete**.

| Criterion | Status |
|-----------|--------|
| Detect TypeScript projects | PASS |
| Prefer src/ over dist/ | PASS |
| Support .ts, .tsx, .mts | PASS |
| Fallback gracefully | PASS |
| Unit tests pass | PASS |
| No regressions | PASS |

**Ready for review by Kevlin Henney and Linus Torvalds.**

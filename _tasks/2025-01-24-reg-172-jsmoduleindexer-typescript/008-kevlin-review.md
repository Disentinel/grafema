# Kevlin Henney - Code Quality Review

## REG-172: JSModuleIndexer uses dist/ instead of src/ for TypeScript projects

---

## Verdict: APPROVED

The implementation is clean, focused, and well-tested. The code demonstrates good separation of concerns, clear naming, and appropriate documentation. Minor suggestions below for polish, but none are blocking.

---

## Code Quality Assessment

### Readability and Clarity

**resolveSourceEntrypoint.ts** - Excellent

The module-level documentation clearly explains the resolution order (lines 1-14). This is exactly what I want to see: documentation that explains the "why" and the algorithm, not just the "what."

The function itself is straightforward:
```typescript
// Step 1: Check for TypeScript project indicator
// Step 2: Check package.json "source" field
// Step 3: Try standard TypeScript source candidates
// Step 4: Not found - caller should fallback to main
```

The numbered comments match the documentation. A reader can understand the algorithm at a glance.

**SimpleProjectDiscovery.ts** - Good

The integration is minimal and readable:
```typescript
const entrypoint = resolveSourceEntrypoint(projectPath, packageJson)
  ?? packageJson.main
  ?? 'index.js';
```

Nullish coalescing chain reads naturally: "try source entrypoint, else main, else default."

**ServiceDetector.ts** - Good

The `findEntryPoint()` method now has clear priority documentation (lines 205-212) and uses the utility appropriately.

### Test Quality

**Excellent test organization.** The test file uses descriptive `describe` blocks that map to real scenarios:

- `TypeScript project detection` - core happy/sad paths
- `package.json source field` - explicit configuration
- `TSX file support` - React projects
- `alternative source locations` - lib/, root-level
- `monorepo package support` - enterprise use case
- `main.ts variants` - Angular/Vue convention
- `edge cases` - empty objects, .mts extension

**Tests communicate intent clearly.** Each test has:
1. Setup comment explaining what is being created
2. Clear assertion with implicit documentation

Example:
```typescript
it('should prefer src/ over lib/ when both exist', () => {
  // Setup: Both src/ and lib/ have index.ts
  ...
  // src/ comes before lib/ in candidates list
  assert.strictEqual(result, 'src/index.ts');
});
```

**Coverage is comprehensive.** The 17 tests cover:
- TypeScript detection (tsconfig.json presence)
- JavaScript projects (no tsconfig.json)
- Explicit source field (priority over candidates)
- Non-existent source field (fallback)
- TSX support
- Priority between .ts/.tsx
- Alternative directories (lib/, root)
- Priority between src/lib
- Only compiled output (null result)
- Non-standard entry names (null result)
- Monorepo packages
- Inherited tsconfig (null result)
- main.ts variants
- Empty package.json
- .mts extension

### Naming

**Function name:** `resolveSourceEntrypoint` - Clear and descriptive. The word "resolve" implies a search/lookup operation. "Source" distinguishes from compiled output. "Entrypoint" is domain terminology.

**Constant name:** `TS_SOURCE_CANDIDATES` - Good. SCREAMING_SNAKE_CASE for constants. "Candidates" implies an ordered list of possibilities.

**Interface name:** `PackageJsonForResolution` - Precise. It's not a full package.json interface; it's the subset needed for this resolution.

**Variable names:** `projectPath`, `packageJson`, `tsconfigPath`, `candidatePath`, `sourcePath` - All clear and consistent.

### Structure

**Single Responsibility:** The utility function has one job. It doesn't modify anything, doesn't have side effects, doesn't create nodes. This makes it easy to test and reuse.

**Appropriate abstraction level:** The function returns `string | null`, leaving the fallback decision to callers. This is correct - callers have different default behaviors:
- `SimpleProjectDiscovery`: falls back to `main ?? 'index.js'`
- `ServiceDetector`: falls back to `main`, then tries more candidates

**File location:** `plugins/discovery/resolveSourceEntrypoint.ts` - Makes sense as it's primarily a discovery concern.

### Duplication

**Candidates list:** There is some overlap between `TS_SOURCE_CANDIDATES` (line 37-50) and the fallback candidates in `ServiceDetector.findEntryPoint()` (lines 228-241). However:

1. The lists have different purposes: one is TypeScript-specific, one is a general fallback
2. `ServiceDetector` fallbacks include `.js` files which are deliberately excluded from TypeScript candidates
3. The overlap is minimal and maintaining two small lists is acceptable

**PackageJson interfaces:** Both `SimpleProjectDiscovery` and `ServiceDetector` have their own `PackageJson` interfaces that include `source?: string`. The utility has `PackageJsonForResolution`. This is acceptable because:

1. The utility's interface is minimal (only `main?`, `source?`) - good for type narrowing
2. The other interfaces have additional fields specific to their needs
3. Sharing a single interface would create unnecessary coupling

### Error Handling

**Appropriate for a utility function.** The function:
- Returns `null` for JavaScript projects (not an error)
- Returns `null` when source not found (not an error)
- Uses `existsSync` which doesn't throw

Callers handle the `null` case with fallback logic. This is the correct pattern.

---

## Issues

None. The implementation is clean and ready for merge.

---

## Suggestions (Non-blocking)

### 1. Consider `tsconfig.build.json` as TypeScript indicator

Some projects use `tsconfig.build.json` or similar variants. Current implementation only checks for `tsconfig.json`. This is acceptable for now but could be a future enhancement.

### 2. JSDoc examples could show the return type inline

Current:
```typescript
* @example
* resolveSourceEntrypoint('/path/to/project', { main: 'dist/index.js' })
* // Returns: 'src/index.ts'
```

Could be:
```typescript
* @example
* resolveSourceEntrypoint('/path/to/project', { main: 'dist/index.js' })
* //=> 'src/index.ts'
```

This is a minor stylistic preference. The current format is clear.

### 3. Test file header comment

The test file has a good header comment but includes a slightly outdated reference:
```typescript
// Import will fail until implementation exists - this is expected in TDD
```

This comment is no longer relevant since implementation exists. Consider removing it.

---

## Summary

This is a well-crafted piece of work. The code is:
- **Focused:** Does one thing well
- **Readable:** Clear algorithm, good naming
- **Testable:** Pure function, no side effects
- **Documented:** Module-level docs explain the "why"
- **Well-tested:** Comprehensive coverage, clear test names

The integration into existing code is minimal and non-disruptive. The nullish coalescing pattern is idiomatic TypeScript.

**APPROVED for merge.**

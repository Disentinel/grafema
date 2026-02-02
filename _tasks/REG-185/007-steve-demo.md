# REG-185: Steve Jobs Demo Report - Include/Exclude Pattern Filtering

## Demo Setup

Created a test project in `/tmp/grafema-demo-reg185` with:

```
/tmp/grafema-demo-reg185/
├── package.json
├── src/
│   ├── index.ts
│   ├── services/
│   │   └── user.ts
│   └── utils/
│       └── helpers.ts
├── test/
│   ├── user.test.ts
│   └── helpers.test.ts
└── node_modules/
    └── lodash/
        └── index.ts
```

Total: 6 TypeScript files. Goal: only analyze `src/**/*.ts`, exclude test files and node_modules.

---

## Demo 1: `grafema init` - Config Template

```bash
$ grafema init

✓ Found package.json
✓ Detected JavaScript project
✓ Created .grafema/config.yaml
```

**Generated config.yaml:**

```yaml
# Grafema Configuration
# Documentation: https://github.com/grafema/grafema#configuration

plugins:
  discovery: []
  indexing:
    - JSModuleIndexer
  # ...

# Future: File discovery patterns (not yet implemented)
# Grafema currently uses entrypoint-based discovery (follows imports from package.json main field)
# Glob-based include/exclude patterns will be added in a future release
#
# include:
#   - "src/**/*.{ts,js,tsx,jsx}"
# exclude:
#   - "**/*.test.ts"
#   - "node_modules/**"
```

### UX Issue #1: Config says "not yet implemented"

The init command generates a template that says the feature is "not yet implemented" and keeps patterns **commented out**. This is **stale documentation** - the feature IS implemented now.

**Impact:** Users won't discover the feature unless they read other docs.

---

## Demo 2: Manual Pattern Configuration

Manually configured patterns:

```yaml
include:
  - "src/**/*.ts"
exclude:
  - "**/*.test.ts"
```

**Analysis result:**

```bash
$ grafema analyze

Analyzing project: /private/tmp/grafema-demo-reg185
[INFO] Indexing complete {"service":"grafema-demo-reg185","modulesCreated":3,"totalInTree":3}
Analysis complete in 0.15s
  Nodes: 33
  Edges: 46
```

**Verification:**

```bash
$ grafema ls -t MODULE

[MODULE] (3):
  src/index.ts  (src/index.ts)
  src/services/user.ts  (src/services/user.ts)
  src/utils/helpers.ts  (src/utils/helpers.ts)
```

**PASS:** Only files matching `src/**/*.ts` were indexed. Test files and node_modules excluded.

---

## Demo 3: Error Handling

### Test 3a: `include` is not an array

```yaml
include: "not an array"
```

**Result:**

```
Error: Config error: include must be an array, got string
    at validatePatterns (file:///...)
    at loadConfig (file:///...)
    ...
```

**Message is clear**, but shows raw stack trace. Could be cleaner.

### Test 3b: Empty string in array

```yaml
include:
  - "src/**/*.ts"
  - ""
```

**Result:**

```
Error: Config error: include[1] cannot be empty or whitespace-only
```

**PASS:** Array index included in error message. Helpful for debugging.

### Test 3c: Empty include array (edge case)

```yaml
include: []
```

**Result:**

```
[WARN] Warning: include is an empty array - no files will be processed
```

**PASS:** Warning instead of error. Continues but alerts user.

---

## UX Summary

### What Works Well

| Aspect | Rating | Notes |
|--------|--------|-------|
| Pattern matching | Works | `src/**/*.ts` correctly matches |
| Exclude priority | Works | Exclude patterns override include |
| Error messages | Good | Clear text, includes array index |
| Warning for edge cases | Good | Empty array warns, doesn't crash |

### Issues Found

| Issue | Severity | Impact |
|-------|----------|--------|
| Config template says "not yet implemented" | **High** | Users won't discover feature |
| Patterns commented out in template | **High** | Users need to uncomment and guess syntax |
| Stack traces in errors | Low | Looks unpolished but message is clear |
| No logging when patterns filter files | Low | Can't see what was skipped |

---

## The "On Stage" Test

Would I demo this on stage? **Not yet.**

The core functionality works. But when a user runs `grafema init` for the first time, they see:

> "Future: File discovery patterns (not yet implemented)"

That's confusing. The feature IS implemented. The init command should:

1. **Generate uncommented patterns** with sensible defaults
2. **Not say "not yet implemented"**
3. Show examples in comments (but the main patterns should be active)

**Proposed config template:**

```yaml
# Grafema Configuration

plugins:
  # ...

# File filtering (glob patterns)
# Include: which files to analyze (default: all files followed from entrypoint)
include:
  - "src/**/*.ts"
  - "src/**/*.js"

# Exclude: files to skip even if included (exclude wins over include)
exclude:
  - "**/*.test.ts"
  - "**/*.spec.ts"
  - "node_modules/**"
```

---

## Verdict: **NEEDS WORK**

### Must Fix Before Shipping

1. **Update `init` command** to generate working config template with patterns uncommented and documented correctly

### Nice to Have

2. Add `[INFO] Pattern filtering enabled: include=[...], exclude=[...]` log message during analysis
3. Catch validation errors in CLI and format without stack trace

---

## Artifacts

- Demo project: `/tmp/grafema-demo-reg185`
- Implementation report: `_tasks/REG-185/006-rob-implementation.md`
- Init command source: `packages/cli/src/commands/init.ts` (needs update)

# User Request: REG-172

## Linear Issue

**REG-172: JSModuleIndexer uses dist/ instead of src/ for TypeScript projects**

- **Priority:** Urgent
- **Status:** Backlog
- **Labels:** Bug

## Problem

JSModuleIndexer uses `main` field from package.json as entrypoint. For TypeScript projects, `main` typically points to compiled output (`dist/index.js`), not source code (`src/index.ts`).

## Steps to Reproduce

```json
// package.json
{
  "name": "@jammers/backend",
  "main": "dist/index.js",
  "scripts": {
    "dev": "nodemon src/index.ts",
    "build": "tsc"
  }
}
```

```bash
grafema analyze /path/to/backend
# Log: Processing file {"file":"/dist/index.js","depth":0}
# Expected: Processing file {"file":"/src/index.ts","depth":0}
```

Result: Grafema analyzes compiled JS (or nothing if not built), ignores TypeScript source.

## Expected Behavior

JSModuleIndexer should detect TypeScript projects and use source entrypoint:

1. Check for `tsconfig.json` → it's TypeScript
2. Look for entrypoint in this order:
   * `src/index.ts`
   * `src/index.tsx`
   * `index.ts`
   * `index.tsx`
   * Only then fallback to `main` field

## Technical Notes

* Also check `"source"` or `"module"` fields in package.json (some projects use these)
* tsconfig.json may have `"rootDir"` that hints at source location
* Consider `"types"` field which often points to source structure

## Acceptance Criteria

1. Detect TypeScript projects (tsconfig.json exists)
2. Prefer src/ over dist/ for TypeScript
3. Support .ts, .tsx, .mts extensions
4. Fallback gracefully if source not found

## Context

Critical blocker for onboarding. Most modern JS projects use TypeScript.

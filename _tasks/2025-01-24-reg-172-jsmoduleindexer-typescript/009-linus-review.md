# Linus Torvalds - High-Level Review

## REG-172: JSModuleIndexer uses dist/ instead of src/ for TypeScript projects

---

## Verdict: APPROVED

---

## Assessment

This is a clean, pragmatic solution that does exactly what it should without overengineering.

### What we got right

**1. Single-purpose utility with clear contract**

The `resolveSourceEntrypoint` function has a precise job: return the TypeScript source path if it exists, or `null` if the caller should fall back to other methods. The nullish coalescing chain in the callers is elegant:

```typescript
const entrypoint = resolveSourceEntrypoint(projectPath, packageJson)
  ?? packageJson.main
  ?? 'index.js';
```

This is exactly the right level of abstraction. The utility handles TypeScript detection and source resolution. The caller handles the fallback policy. Clean separation.

**2. Conservative heuristics that don't break edge cases**

Using `tsconfig.json` presence as the TypeScript indicator is simple and correct. Not trying to parse tsconfig for `rootDir`, not trying to inspect file contents, not trying to be clever. Projects with non-standard layouts can use the `source` field in package.json.

The decision to return `null` for monorepo packages without local `tsconfig.json` is the right call. We don't know enough about the project structure to make assumptions. Conservative is correct here.

**3. Standard candidate list covers 95% of projects**

```
src/index.ts, src/index.tsx, src/index.mts
src/main.ts, src/main.tsx
lib/index.ts, lib/index.tsx
index.ts, index.tsx, index.mts
main.ts, main.tsx
```

This covers the common conventions without trying to handle every exotic setup. The `source` field escape hatch handles the rest.

**4. Integration is minimal and non-invasive**

Two existing files changed with minimal diff: import + one-line integration in each. No architectural changes required. No changes to plugin interfaces. This is how you introduce a cross-cutting fix.

**5. Tests actually test what they claim**

I reviewed the 17 unit tests. They cover:
- TypeScript detection (positive and negative)
- `source` field priority
- Extension priority (.ts > .tsx)
- Alternative locations (src/ > lib/ > root)
- Graceful fallback when source doesn't exist
- Monorepo edge cases

The tests communicate intent clearly and match the stated acceptance criteria.

### Does it align with project vision?

Yes. Grafema's thesis is "AI should query the graph, not read code." If Grafema indexes compiled `dist/` output instead of source, the graph is useless for understanding the actual code structure. This fix directly serves the core product purpose.

### Did we cut corners?

No. The implementation is complete for the stated problem. We're not trying to solve every possible entrypoint resolution scenario. We're solving the common case that was blocking onboarding.

---

## Issues

None.

---

## Recommendations (non-blocking)

**1. Consider adding `module` field support later**

The original request mentioned `module` field in package.json. Some projects use this to point to ES module source. Not critical for this fix, but could be a follow-up enhancement if real-world projects need it.

**2. Document the `source` field escape hatch**

Projects with non-standard source locations (like `src/cli.ts` instead of `src/index.ts`) will fall back to `main` field, which might be `dist/`. These projects can add `"source": "src/cli.ts"` to their package.json. Consider mentioning this in user-facing docs when they exist.

---

## Summary

This is how you fix a bug: understand the problem, implement a focused solution, test thoroughly, integrate minimally. No hacks, no overengineering, no scope creep.

Ship it.

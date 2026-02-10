# REG-403: Steve Jobs Review - Config Version Compatibility Check

## Verdict

**REJECT**

---

## What's Good

1. **Clean pattern matching.** The implementation follows the existing validation pattern (`validateServices`, `validatePatterns`, `validateWorkspace`) exactly. Same signature style, same error prefix, same placement outside try-catch. This is disciplined work.

2. **Backward compatibility handled correctly.** `undefined`/`null` version passes silently. Old configs keep working. No breaking change.

3. **Single source of truth for version.** `GRAFEMA_VERSION` from `package.json` is the right approach. Already the pattern used in CLI. No hardcoded strings.

4. **Config writers updated.** Both `init` command and MCP `write_config` emit `version` in generated configs.

5. **Test coverage is solid.** 18 new tests covering: `getSchemaVersion`, `validateVersion` edge cases (undefined, null, matching, mismatching, non-string, empty, whitespace), and integration with `loadConfig` for both YAML and JSON paths.

6. **Error message with remediation.** `Run: grafema init --force` tells the user exactly what to do.

---

## Critical Issue: Version Comparison Strategy Deviates from Don's Plan

Don's analysis (002-don-analysis.md) explicitly recommended **major.minor comparison** with clear rationale:

> "Patch versions (0.2.4 -> 0.2.5) should never break config schema. Exact match would force users to update config on every patch release -- terrible UX."

The implementation uses **full major.minor.patch comparison** instead:

```typescript
export function getSchemaVersion(version: string): string {
  const base = version.split('-')[0];  // strips pre-release only
  return base;                          // returns "0.2.5", NOT "0.2"
}
```

This means:
- Grafema `0.2.5-beta` generates config with `version: "0.2.5"`
- User upgrades to Grafema `0.2.6-beta` (a patch release)
- Config now fails with: `config version "0.2.5" is not compatible with Grafema 0.2.6-beta`
- User is forced to run `grafema init --force` on every patch upgrade

**This defeats the feature's purpose.** The feature exists to protect against breaking config schema changes. Patch releases don't break config schemas. Requiring config regeneration on every patch is hostile UX that will train users to hate the version check.

Don's plan explicitly said `"0.2"` not `"0.2.5"`. The config in Don's analysis example shows `version: "0.2"`. The implementation diverged without documented reasoning.

### Required Fix

Change `getSchemaVersion()` to return `major.minor` only:

```typescript
export function getSchemaVersion(version: string): string {
  const base = version.split('-')[0];
  const parts = base.split('.');
  return `${parts[0]}.${parts[1]}`;
}
```

Config should store `"0.2"`, not `"0.2.5"`.

Tests need updating accordingly (assert `"0.2"` not `"0.2.5"`).

---

## Secondary Issues

### 1. No validation of version format

`validateVersion` accepts any non-empty string. `version: "banana"` passes comparison (against `"0.2.5"`) and throws an error saying "banana is not compatible" -- which is correct behavior. But `version: "banana"` should arguably fail earlier with a format error. This is minor, not blocking.

### 2. `version.ts` path resolution assumes build structure

```typescript
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
```

At runtime, `version.js` is in `dist/`, so `..` resolves to `packages/core/` which contains `package.json`. This works. But it's fragile if the build output structure ever changes. This is an accepted risk since CLI already uses the same pattern.

### 3. `mergeConfig` fills in version from defaults when config omits it

```typescript
version: user.version ?? defaults.version,
```

When a config has no `version` field, the merged config gets `DEFAULT_CONFIG.version` (e.g., `"0.2.5"`). This is correct behavior for the merged result, but slightly misleading -- it looks like the config specified a version when it didn't. Not blocking, but worth noting.

---

## Summary

The implementation is well-structured and follows existing patterns. The test coverage is thorough. But the core design decision -- patch-level version matching instead of minor-level -- is wrong and will cause real-world pain for users on every patch upgrade. This directly contradicts the plan's recommendation and the feature's stated purpose of "protection against breaking changes."

Fix the version comparison to use major.minor, update tests accordingly, and this is ready to ship.

**REJECT** -- Fix the version granularity from `major.minor.patch` to `major.minor`.

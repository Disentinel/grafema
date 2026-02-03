# REG-330: Add strict mode flag for fail-fast debugging of product gaps

## Problem

When Grafema can't resolve something (variable, scope, etc.), it currently:

1. Logs a WARN
2. Creates a stub/placeholder node
3. Continues

This makes product gaps hard to find — they silently fail and only surface when users report "tracing doesn't work".

## Solution

Add a system-wide strict mode flag:

```yaml
# grafema.yaml
strict: true  # or via CLI: --strict
```

**Default mode (strict: false):**

* WARN + create stub (current behavior)
* Graceful degradation

**Strict mode (strict: true):**

* FAIL immediately when can't resolve
* Clear error message about what couldn't be resolved
* Exit with non-zero code

## Use Cases

1. **Dogfooding:** Run Grafema on Grafema codebase with strict mode to find gaps
2. **CI/CD:** Ensure no unresolved references in critical code paths
3. **Development:** Quick feedback when analyzer can't handle a pattern

## Acceptance Criteria

- [ ] Config option `strict: boolean` in grafema.yaml
- [ ] CLI flag `--strict` to override
- [ ] When strict mode enabled:
  - [ ] Unresolved variable → FAIL with clear error
  - [ ] Missing ASSIGNED_FROM source → FAIL with clear error
  - [ ] Can't determine response type → FAIL with clear error
- [ ] Error messages include: file, line, what was attempted, why it failed
- [ ] Exit code non-zero on strict mode failures

## Technical Notes

Implement as a global context flag accessible to all analyzers/enrichers.

Could use:

```typescript
if (context.strictMode && !resolved) {
  throw new StrictModeError(`Cannot resolve variable '${name}' at ${file}:${line}`);}
```

Related: REG-326 (helps find remaining gaps)

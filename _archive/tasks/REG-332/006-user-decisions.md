# User Decisions - REG-332

**Date:** 2026-02-05
**Decided by:** Vadim Reshentnikov

## Decisions

### 1. grafema-ignore naming
**Decision:** Keep `grafema-ignore` as-is.

The name is clear and follows ESLint convention (`eslint-disable`).

### 2. Suppression summary
**Decision:** YES - report suppression count at end of analysis.

Example output:
```
✓ Analysis completed

Suppressions:
  2 errors suppressed by grafema-ignore comments
```

### 3. Progressive disclosure (resolution chain)
**Decision:** Option C (Hybrid)

- Show chain when ≤3 errors (focused debugging gets full context)
- Hide chain when >3 errors (show "Run with --verbose for resolution chain")
- `--verbose` always shows chain regardless of error count

This balances helpfulness for focused debugging vs preventing wall-of-text for many errors.

---

## Implementation Notes

These decisions affect:
- **Phase 2:** DiagnosticReporter.formatStrict() needs error count check
- **Phase 4:** CLI output needs suppression summary section
- **analyze.ts:** needs to pass `--verbose` flag to reporter

---

**Status:** Ready for implementation

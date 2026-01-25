# Linus Torvalds - High-Level Plan Review

## REG-204: Explore Command Raw Mode Error

---

## VERDICT: APPROVED ✓

This is the **RIGHT solution**. No hacks, no corners cut.

---

## Why This Plan is Correct

### 1. Aligns with Grafema's Vision

The dual-mode approach (TUI when human + TTY, batch when AI or non-interactive) solves the problem **without removing human UX**. That's the right balance.

### 2. Follows Existing Patterns

The plan uses patterns that already work in the codebase:
- From `query.ts`: Accept arguments, output JSON/text
- From `impact.ts`: Support `--depth`, recursive traversal
- Error handling: `exitWithError()` with suggestions

### 3. Right-Sized Scope

- Phase 1 (TTY detection) can ship alone as quick win
- Phase 2 (batch mode) adds new functionality
- Phase 3 (refactoring) cleans up for maintainability

### 4. Backward Compatible

- Interactive TUI unchanged for humans with terminals
- New flags are optional
- Zero breaking changes

---

## Minor Suggestions for Implementation

### 1. JSON Output Metadata
Consider adding execution context:
```json
{
  "mode": "callers",
  "depth": 2,
  "count": 5,
  "results": [...]
}
```

### 2. Test Coverage for Depth Edge Cases
- `--depth 0`
- `--depth 999` (should work, might be slow)
- Invalid depth like `--depth abc` (should default to 3)

### 3. Help Text Examples
```
grafema explore [start]        # Interactive TUI (requires terminal)
grafema explore --query <name> # Batch: search
grafema explore --callers <fn> # Batch: callers
grafema explore --callees <fn> # Batch: callees
```

---

## Conclusion

**This is production-quality planning.**

- Problem correctly identified (root cause: ink requires TTY)
- Solution correctly designed (dual-mode: TUI + batch)
- Existing patterns correctly leveraged (copy from query/impact)

**Proceed to implementation.**

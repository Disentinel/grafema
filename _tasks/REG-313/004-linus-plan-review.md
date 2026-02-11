# Linus Torvalds - High-Level Plan Review (REG-313)

## TL;DR

**APPROVED.** This is the right approach. Ship it.

---

## 1. Is the approach RIGHT?

**YES.** "Try exact match first, then nested path" is not a hack - it's the correct precedence for backward compatibility.

Why this works:
- Existing behavior preserved by default (exact match first)
- Nested paths are opt-in (only if exact match fails AND contains '.')
- Performance cost is negligible (one `contains('.')` check)
- No breaking changes possible - if exact match exists, we use it

This is clean, correct, and maintainable.

---

## 2. Is "exact match first" the correct precedence?

**YES.** This is the only sane choice.

Consider the alternatives:
1. **Nested first** - WRONG. Breaks existing code if someone has both `{"foo.bar": "x"}` and `{"foo": {"bar": "y"}}`. Which one wins? Ambiguous.
2. **Exact only** - WRONG. Defeats the entire purpose of the feature.
3. **Exact first, then nested** - CORRECT. Unambiguous, predictable, backward compatible.

Edge case Don mentioned (`{"cardinality.scale": "value"}`) is handled correctly. If someone has a literal key with dots, they expect exact match. We give them exact match. If they want nested, they don't create conflicting literal keys. No problem.

---

## 3. Is the scope appropriate?

**YES.** MVP scope is perfect.

What's IN (correct):
- Dot notation for nested objects: `config.database.port`
- Exact match precedence for backward compatibility
- Primitive value extraction (String, Number, Bool)

What's OUT (correct):
- Array indexing: `items[0].name` - separate issue, separate complexity
- Escaping: `key\.with\.dots` - not needed, exact match handles this
- Wildcards: `items[*].id` - way out of scope

This is exactly the right scope for MVP. Don't over-engineer. Ship the 80% use case, see if anyone needs the other 20%.

---

## 4. Is the code organization correct?

**YES, with one note.**

Joel's plan puts helper in `datalog/utils.rs`. This is fine. The function is:
- Used by multiple modules in `datalog/` (eval.rs, eval_explain.rs)
- Not used outside `datalog/`
- Domain-specific to Datalog evaluation

So `datalog/utils.rs` is the right place. Not `storage/`, not top-level `utils/`.

**One note:** Make `get_metadata_value()` public within the crate (`pub(crate)`), not just `pub`. This function is internal to rfdb-server, not part of any external API.

---

## 5. Test strategy concerns?

**ONE CONCERN: Missing malformed path tests.**

Joel's test table is comprehensive BUT I don't see tests for malformed paths:
- Trailing dot: `"foo.bar."`
- Leading dot: `".foo.bar"`
- Double dots: `"foo..bar"`
- Empty string: `""`
- Just a dot: `"."`

Current implementation (`path.split('.')`) will produce empty strings for these cases, and `metadata.get("")` might behave weirdly.

**REQUIRED:** Add test cases for malformed paths. Expected behavior: silently return `None` (consistent with "missing path").

**Optional but recommended:** Add explicit guard in `resolve_nested_path()`:
```rust
for part in parts {
    if part.is_empty() {
        return None;  // Malformed path
    }
    // ...
}
```

This makes behavior explicit instead of relying on serde_json's behavior for empty keys.

---

## 6. Anything else?

**Two minor points:**

1. **Commit strategy is backwards.** Joel has:
   - Commit 1: Add utils
   - Commit 2: Use in eval.rs
   - Commit 3: Use in eval_explain.rs
   - Commit 4: Add integration tests

   This is WRONG. Tests should come FIRST (TDD). Correct order:
   - Commit 1: Add utils module with tests
   - Commit 2: Apply to eval.rs (unit tests already passing)
   - Commit 3: Apply to eval_explain.rs
   - Commit 4: Add integration tests to tests.rs

2. **Documentation clarity.** Joel's rustdoc for `get_metadata_value()` is good but should explicitly state:
   - What happens with malformed paths (returns None)
   - What happens with Objects/Arrays at final path step (returns None)
   - Performance characteristics (O(path_depth) for nested, O(1) for exact)

---

## Final Verdict

**SHIP IT.**

This is the right thing done the right way. No hacks, no shortcuts, no architectural debt.

Fix the malformed path testing gap, adjust commit order for TDD compliance, and we're good.

---

## Action Items for Implementation

1. Add malformed path test cases
2. Consider adding `part.is_empty()` guard in `resolve_nested_path()`
3. Use `pub(crate)` instead of `pub` for helper functions
4. Follow TDD commit order (tests first)
5. Expand rustdoc to cover edge cases and performance


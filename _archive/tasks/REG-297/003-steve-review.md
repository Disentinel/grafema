# Steve Jobs Review: REG-297 — REJECT

## Key Concerns

1. **Data model justification** — Why `Array<{ line, column, expressionType }>` vs just boolean?
2. **Use case clarity** — "Track which top-level expressions await" is ambiguous
3. **Test coverage** — Needs explicit tests for conditional/try-catch/template literal awaits
4. **Verify `getFunctionParent() === null`** works for all top-level contexts (if/try/for blocks)

## Recommendation

Clarify use case before implementing. Every metadata field must serve a query.

See full review in conversation.

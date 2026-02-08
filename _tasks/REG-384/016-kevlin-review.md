# Kevlin Henney Review — REG-384 (Build Fix)

## Code Quality
- The guard around `StaticBlock` vs `Function` is minimal and clear.
- No behavior change for normal functions; reduces type ambiguity without extra complexity.

## Risk
- Low. Purely defensive type narrowing.

## Verdict
Good to proceed.

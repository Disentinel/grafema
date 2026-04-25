# REG-231: Improve pre-commit hook

## Problem

Pre-commit hook runs `pnpm test` which executes the full test suite. This takes too long and blocks development flow.

Currently disabled in `.husky/pre-commit`.

## Solution

Pre-commit should only run fast checks:

1. `pnpm lint` - ESLint (fast)
2. `pnpm typecheck` - TypeScript (fast)

Full test suite should run in CI only.

## Acceptance Criteria

- [ ] Pre-commit runs in < 10 seconds
- [ ] Catches lint errors before commit
- [ ] Catches type errors before commit
- [ ] Full test suite runs in CI only

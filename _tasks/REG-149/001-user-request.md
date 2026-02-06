# REG-149: Fix ESLint type safety warnings and enable error-level enforcement

## Goal

Fix all 700 ESLint warnings for type safety rules and switch them from `warn` to `error` level.

## Current State

`eslint.config.js` has two rules set to `warn` with TODO comments:

```javascript
// TODO: fix all violations and change to 'error'
'@typescript-eslint/no-explicit-any': 'warn',
// TODO: fix all violations and change to 'error'
'@typescript-eslint/no-unsafe-type-assertion': 'warn',
```

Current violation count: **700 warnings** across packages:

* `packages/cli/` - commands (analyze, check, impact, query)
* `packages/core/` - various modules
* `packages/mcp/` - handlers, server, state, utils

## Acceptance Criteria

1. All `any` types replaced with proper types or justified `unknown`
2. All unsafe type assertions (`as unknown as X`) replaced with proper type guards or validated assertions
3. Both rules changed from `'warn'` to `'error'` in eslint.config.js
4. `npm run lint` passes with 0 errors and 0 warnings for these rules
5. All tests pass

## Approach

Consider using the `typescript-type-safety-refactoring` skill which covers:

* ESM/CJS interop patterns
* Babel AST types
* catch block typing
* worker thread data
* Root cause fixes (interfaces with `unknown[]`)
* Union types instead of generics with `unknown`

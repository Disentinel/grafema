# REG-355: Fix TypeScript type errors in CLI package

## Problem

TypeScript type errors in `packages/cli/src/commands/analyze.ts`:

1. Line 41: `Module '"@grafema/core"' has no exported member 'ExpressHandlerLinker'`
2. Line 242: `Object literal may only specify known properties, and 'silent' does not exist in type 'RFDBServerBackendOptions'`

These block the typecheck command from passing.

## Context

Discovered during REG-231 (pre-commit hook improvement). The `ExpressHandlerLinker` export may have been removed or renamed in core package. The `silent` property may have been removed from `RFDBServerBackendOptions`.

## Acceptance Criteria

- [ ] `pnpm typecheck` passes for @grafema/cli package
- [ ] No runtime errors from these code paths

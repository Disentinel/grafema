# REG-356: Fix TypeScript type errors in VSCode extension

## Problem

TypeScript type error in `packages/vscode/src/extension.ts`:

Line 173: `Argument of type '(event: vscode.TextEditorSelectionChangeEvent) => Promise<void>' is not assignable to parameter of type '(...args: unknown[]) => unknown'`

The `debounce` utility function has incompatible types with VSCode's event handlers.

## Context

Discovered during REG-231 (pre-commit hook improvement). The debounce function returns a generic type that doesn't match what VSCode's `onDidChangeTextEditorSelection` expects.

## Acceptance Criteria

- [ ] `pnpm typecheck` passes for grafema-explore package
- [ ] Selection change handler still works correctly

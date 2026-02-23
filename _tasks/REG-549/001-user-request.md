# REG-549: Fix EXPORT named specifiers storing column=0 instead of per-name column

**Source:** Linear REG-549
**Date:** 2026-02-22
**Priority:** Urgent
**Labels:** Bug, v0.2

## Goal

Fix EXPORT node positions: currently all named export specifiers get `column=0` (position of the `export` keyword). Each specifier should get its own column position, matching how IMPORT nodes work.

## Symptoms

`export type { ProgressInfo, ProgressCallback } from './PhaseRunner.js';` — both EXPORT nodes show `L23:0`. Should be `L23:14` and `L23:27` respectively (position of each name in the braces).

## Root Cause

In `ImportExportVisitor.ts`, `ExportSpecifierInfo` interface has no `column`/`endColumn` fields. The export handlers don't call `getColumn(spec)` per specifier. In `ModuleRuntimeBuilder.bufferExportNodes()`, column is hardcoded to `0`.

**Contrast with IMPORT:** `ImportSpecifierInfo` captures `column: getColumn(importSpec)` and `endColumn`, and `bufferImportNodes` uses `spec.column ?? column ?? 0`.

## Fix Plan

1. Add `column?`, `endColumn?` to `ExportSpecifierInfo` in `ImportExportVisitor.ts`
2. Capture `column: getColumn(spec)`, `endColumn: getEndLocation(spec).column` in export handlers
3. Add `column?` to `ExportInfo` in `types.ts`
4. Use `spec.column ?? 0` in `ModuleRuntimeBuilder.bufferExportNodes()`

## Acceptance Criteria

- Each named export specifier node has column = position of its name
- `export type { A, B }` → two EXPORT nodes with distinct correct columns
- Unit test comparing IMPORT vs EXPORT column behavior

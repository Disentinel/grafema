## User Request: REG-530

**Source:** Linear issue REG-530
**Date:** 2026-02-20

### Problem

`import { join, resolve, basename } from 'path'` — cursor on `resolve` or `basename` returns `IMPORT "join"`. `findNodeAtCursor` matches by line only, ignoring column for IMPORT nodes.

### Repro

* File: `packages/core/src/Orchestrator.ts` lines 6, 21
* Hover over second/third specifier in multi-specifier import

### Expected

Each specifier should resolve to its own IMPORT node.

### Root Cause (from issue)

`findNodeAtCursor` matches IMPORT nodes by line number only, not by column range. When multiple specifiers share the same line, the first one wins.

### Labels

Bug, v0.2

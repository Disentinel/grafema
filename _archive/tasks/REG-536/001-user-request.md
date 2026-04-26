# REG-536: Disconnected nodes in switch/case blocks (connectivity gap)

**Source:** Linear issue REG-536
**Date:** 2026-02-21
**Priority:** Medium
**Labels:** Bug, v0.2

## Problem

314 disconnected nodes (47.4% unreachable) in `ExpressionEvaluator.ts`. SCOPE, EXPRESSION, LITERAL nodes created inside switch/case blocks are not connected to the main graph via CONTAINS chain.

## Repro

```
grafema check connectivity
```

Shows 51 connectivity warnings, all for ExpressionEvaluator.ts.

## Root Cause (as described in issue)

Analyzer creates nodes inside case blocks but doesn't establish CONTAINS edges from parent function/scope. BFS from MODULE/SERVICE roots doesn't reach them. Likely systemic for all files with heavy switch/case.

## Where to Fix

ScopeTracker + CONTAINS edge creation — switch/case blocks need proper scope chain.

## Acceptance Criteria

- `grafema check connectivity` shows 0 connectivity warnings for ExpressionEvaluator.ts
- SCOPE, EXPRESSION, LITERAL nodes inside switch/case are connected via CONTAINS chain
- Fix is not limited to ExpressionEvaluator.ts — all files with switch/case should be fixed

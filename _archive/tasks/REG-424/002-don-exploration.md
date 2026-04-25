# REG-424: CallExpressionVisitor.ts Exploration Report

**Don Melton (Tech Lead) — 2026-02-15**

## Executive Summary

CallExpressionVisitor.ts is **1,526 lines** — far exceeding the 500-line target. The file has clear logical groupings that can be extracted following the **REG-422 handler class pattern** used for analyzeFunctionBody decomposition.

**Target:** Main file < 500 lines (currently 1,526 lines = 67% reduction needed)

## File Structure Analysis

### Method Inventory

| Method | Lines | Line Range | Size | Category |
|--------|-------|------------|------|----------|
| `constructor` | 4 | 259-262 | Trivial | Core |
| `extractArguments` | 226 | 267-493 | **LARGE** | Argument Extraction |
| `extractIdentifiers` | 41 | 499-540 | Medium | Argument Extraction |
| `extractObjectProperties` | 186 | 545-731 | **LARGE** | Object/Array Literals |
| `extractArrayElements` | 141 | 736-877 | **LARGE** | Object/Array Literals |
| `detectArrayMutation` | 98 | 885-983 | Medium | Mutation Detection |
| `detectObjectAssign` | 81 | 992-1073 | Medium | Mutation Detection |
| `extractMemberExpressionName` | 24 | 1081-1105 | Small | Helper |
| `getFunctionScopeId` | 51 | 1116-1166 | Medium | Helper |
| `getHandlers` | 358 | 1168-1526 | **HUGE** | Core |

### Overhead

| Component | Lines | Percentage |
|-----------|-------|------------|
| Imports | 22 | 1.4% |
| Helper functions (top-level) | 78 | 5.1% |
| Type interfaces (8 interfaces) | 166 | 10.9% |
| Class methods | ~1,210 | 79.3% |
| Class wrapper | 50 | 3.3% |

## Logical Groupings

### 1. Argument Processing (267 lines)
- `extractArguments` (226 lines) — PASSES_ARGUMENT edge creation
- `extractIdentifiers` (41 lines) — recursive variable reference extraction

### 2. Object/Array Literal Extraction (327 lines)
- `extractObjectProperties` (186 lines) — recursive property extraction
- `extractArrayElements` (141 lines) — recursive element extraction

### 3. Mutation Detection (179 lines)
- `detectArrayMutation` (98 lines) — push/unshift/splice tracking
- `detectObjectAssign` (81 lines) — Object.assign tracking

### 4. Handler Logic (358 lines) — `getHandlers()`
- CallExpression handler (~250 lines)
- NewExpression handler (~100 lines)

### 5. Helper Utilities (75 lines)
- `extractMemberExpressionName` (24 lines)
- `getFunctionScopeId` (51 lines)

## Dependencies

**Uses:** ASTVisitor (base), ExpressionEvaluator, ScopeTracker, NodeFactory, computeSemanticId, IdGenerator
**Used by:** JSASTAnalyzer.ts (single instantiation point)

## REG-422 Pattern

Handler class pattern with:
- Base class `FunctionBodyHandler` + `AnalyzerDelegate` interface
- Context object for shared state
- Handlers combined via `Object.assign()`
- 8 handlers extracted, main file reduced to ~200 lines

## Recommendation

**Option A: Handler Class Pattern** (REG-422 style) — proven, minimal disruption, same public API.

### Estimated Sizes After Refactor

| File | Lines |
|------|-------|
| CallExpressionVisitor.ts (main) | ~250 |
| ArgumentExtractionHandler.ts | ~280 |
| ObjectLiteralHandler.ts | ~200 |
| ArrayLiteralHandler.ts | ~160 |
| MutationDetectionHandler.ts | ~200 |
| CallHandler / NewExpressionHandler | ~200-300 |

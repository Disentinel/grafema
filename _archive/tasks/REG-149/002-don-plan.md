# Don Melton Plan: REG-149 - Fix ESLint Type Safety Warnings

## Executive Summary

This task addresses 824 ESLint type safety violations (51 `no-explicit-any` + 773 `no-unsafe-type-assertion`) across the Grafema codebase. The challenge is to fix these violations properly (per Root Cause Policy) while also addressing the pre-commit hook performance concern that led to these rules being removed in the first place.

**Key insight:** This is fundamentally a type architecture problem, not a lint suppression problem. The violations cluster around specific patterns that can be addressed systematically through root-cause fixes.

## Research Summary

Per industry best practices ([Dylan Vann](https://dylanvann.com/incrementally-migrating-to-typescript), [Stripe](https://stripe.com/blog/migrating-to-typescript), [@ts-migrating](https://dev.to/ycmjason/introducing-ts-migrating-the-best-way-to-upgrade-your-tsconfig-2jmn)):

1. **Incremental migration** is preferred - file by file, pattern by pattern
2. **Snapshot testing for errors** - track violations as a baseline, fail on regression
3. **Type debt as tech debt** - don't leave `as any` or `eslint-disable` everywhere
4. **Root cause > suppression** - fix types at their source, not at usage sites

## Codebase Analysis

### Violation Distribution

| Category | Count | Root Cause |
|----------|-------|------------|
| `as unknown as Record<string, unknown>` in Node validation | ~25 | Missing validation helper in types |
| `as unknown as NodeRecord` in analyzers | ~30+ | GraphNode vs NodeRecord type mismatch |
| `as XxxNode` type assertions | ~96 | Missing type guards on node retrieval |
| `catch (e)` without typing | ~120 | TypeScript 4.4+ pattern not adopted |
| `: any` in function signatures | ~51 | External library types, lazy typing |
| Worker thread message typing | ~10 | Untyped MessagePort communication |

### Concentration by Package

Based on pattern analysis:
- **packages/core/** - ~600 violations (highest concentration in analyzers and enrichers)
- **packages/mcp/** - ~80 violations (handlers, state management)
- **packages/cli/** - ~70 violations (commands)
- **packages/api/** - ~20 violations (resolvers)
- **packages/types/** - ~5 violations (branded types)
- **packages/rfdb/** - ~15 violations (client)

### Root Cause Patterns

#### Pattern 1: Node Validation (25+ occurrences)

```typescript
// Current pattern in every Node class:
const nodeRecord = node as unknown as Record<string, unknown>;
for (const field of this.REQUIRED) {
  if (nodeRecord[field] === undefined) ...
}
```

**Root fix:** Create a typed validation helper in `@grafema/types`:

```typescript
export function validateNodeFields<T extends BaseNodeRecord>(
  node: T,
  required: readonly (keyof T)[]
): string[] { ... }
```

#### Pattern 2: GraphNode vs NodeRecord (30+ occurrences)

```typescript
// Current pattern in analyzers:
await graph.addNode(nodeData as unknown as NodeRecord);
```

**Root fix:** The `GraphNode` type in ast/types.ts is more permissive than `NodeRecord`. Either:
- Make `GraphNode` extend `NodeRecord`
- Add a type conversion function
- Audit and fix the type definitions to be compatible

#### Pattern 3: Node Type Narrowing (96+ occurrences)

```typescript
// Current pattern:
const fn = node as FunctionNode;
```

**Root fix:** Type guards per node type:

```typescript
// In @grafema/types:
export function isFunctionNode(node: NodeRecord): node is FunctionNodeRecord {
  return node.type === 'FUNCTION';
}
```

#### Pattern 4: Catch Block Typing (120 occurrences)

```typescript
// Current:
} catch (error) {
  console.error(error.message); // error is unknown in TS 4.4+
}

// Fix:
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
}
```

**Root fix:** Create error handling utility:

```typescript
export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
```

#### Pattern 5: Worker Thread Communication (10+ occurrences)

```typescript
// Current:
parentPort.on('message', (msg: WorkerMessage) => { ... });
```

**Root fix:** Define typed message protocols in `@grafema/types`.

## Proposed Approach

### Phase 1: Type Infrastructure (1-2 days)

Create root-cause fixes in `@grafema/types`:

1. **Node validation helper** - eliminates 25+ `as unknown as Record` patterns
2. **Type guards for all node types** - eliminates 96+ unsafe assertions
3. **Error handling utility** - eliminates 120 catch block issues
4. **Worker message protocol types** - eliminates 10+ message typing issues

### Phase 2: GraphNode/NodeRecord Unification (1 day)

Audit and fix the type mismatch between:
- `ast/types.ts` GraphNode type
- `@grafema/types` NodeRecord type

This should eliminate 30+ violations in analyzers.

### Phase 3: Package-by-Package Migration (3-4 days)

Fix remaining violations package by package:

1. **types** (5 violations) - easiest, foundational
2. **rfdb** (15 violations) - isolated, simple
3. **api** (20 violations) - small scope
4. **cli** (70 violations) - user-facing, medium scope
5. **mcp** (80 violations) - medium scope
6. **core** (600 violations) - largest, but many solved by Phase 1-2

### Phase 4: Enable Rules as Errors (0.5 day)

1. Add rules back to `eslint.config.js` as `error`
2. Verify `npm run lint` passes with 0 errors
3. Run full test suite

## Pre-commit Hook Performance

The rules were removed in commit 9c1a4a0 because type-aware rules are slow (they require full TypeScript type checking).

**Solution:** Separate lint configurations:

```javascript
// eslint.config.js (used in CI, full checks)
'@typescript-eslint/no-explicit-any': 'error',
'@typescript-eslint/no-unsafe-type-assertion': 'error',

// eslint.config.fast.js (used in pre-commit)
// Only syntax-level rules, no type-aware rules
```

Then in `.husky/pre-commit`:

```bash
npx eslint --config eslint.config.fast.js packages/
```

This gives:
- **Fast pre-commit hooks** (syntax rules only)
- **Full type safety** in CI pipeline
- **No degradation** of type safety over time

## Effort Estimate

| Phase | Effort | Violations Fixed |
|-------|--------|------------------|
| Phase 1: Type Infrastructure | 1-2 days | ~250 |
| Phase 2: GraphNode/NodeRecord | 1 day | ~30 |
| Phase 3: Package Migration | 3-4 days | ~544 |
| Phase 4: Enable Rules | 0.5 day | - |
| **Total** | **5-7.5 days** | **824** |

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Breaking existing tests | Run tests after each phase; TDD approach |
| Hidden runtime issues | Type guards add runtime checks, improving safety |
| Scope creep into type refactoring | Strict scope limits per phase |
| Missing edge cases | Comprehensive pattern analysis before coding |

## Decision Points for Review

1. **Split ESLint config (fast vs full)?** - Recommended yes
2. **Add runtime type guards or compile-time only?** - Runtime guards preferred for safety
3. **Fix GraphNode/NodeRecord at type level or add conversion?** - Type level preferred (cleaner)
4. **Use eslint-disable for unfixable cases?** - Only for external library types with justification comments

## Next Steps

1. Joel to expand into detailed technical spec with specific file changes
2. Kent to write tests locking current behavior before any changes
3. Rob to implement Phase 1 (type infrastructure)

---

**Conclusion:** This task is achievable in 5-7.5 days by addressing root causes rather than suppressing symptoms. The key is creating proper type infrastructure first, which will eliminate the majority of violations automatically.

Sources:
- [Dylan Vann - Incrementally Migrating to TypeScript](https://dylanvann.com/incrementally-migrating-to-typescript)
- [Stripe - Migrating to TypeScript](https://stripe.com/blog/migrating-to-typescript)
- [@ts-migrating](https://dev.to/ycmjason/introducing-ts-migrating-the-best-way-to-upgrade-your-tsconfig-2jmn)

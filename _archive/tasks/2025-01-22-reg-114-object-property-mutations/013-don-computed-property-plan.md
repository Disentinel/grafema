# Computed Property Value Resolution: Technical Lead Summary

**Author:** Don Melton (Tech Lead)
**Date:** 2025-01-22
**Related:** REG-114 Object Property Mutations
**Linear Issue:** REG-135 (https://linear.app/reginaflow/issue/REG-135/computed-property-value-resolution-resolve-objkey-when-key-is)
**Source Analyses:** Knuth (010), Altshuller (011), Jobs (012)

---

## Executive Summary

Three experts have independently analyzed the computed property resolution problem. Their conclusions converge on a clear path forward. This document synthesizes their analyses and incorporates the critical user feedback about unknown value classification.

**The core insight:** We're not building "value resolution" — we're building "value classification with progressive resolution."

---

## 1. Synthesis of Expert Analyses

### Knuth's Analysis: The Foundation

Knuth established that this is a classical constant propagation problem with well-understood theory:
- Existing infrastructure covers 80% of needs (`ValueDomainAnalyzer`, `ASSIGNED_FROM` edges, `LITERAL` nodes)
- Single-file analysis is sufficient for initial implementation
- Expected coverage: ~90% of computed properties with varying confidence

**Key insight:** The lattice model (TOP/values/BOTTOM) maps directly to our resolution status categories.

### Altshuller's TRIZ Analysis: The Architecture

Altshuller identified the physical contradiction and resolution:
- **Contradiction:** Value MUST be computed (for precision) AND MUST NOT be computed (for speed)
- **Resolution:** Separation in TIME — collect variable names during analysis, resolve during enrichment
- **IFR (Ideal Final Result):** System resolves property names using data it already has

**Key insight:** We already have `computedPropertyVar` pattern in `MethodCallInfo` for `obj[x]()`. Extend to `ObjectMutationInfo`.

### Jobs' Product Vision: The Why

Jobs framed the user impact:
- Every `'<computed>'` is a broken promise — user has to read code
- Critical for target audience: legacy codebases with constants, configuration objects, event handlers
- The demo that wins: query by actual property names, not structure

**Key insight:** This isn't a nice-to-have feature. It's table stakes for the product vision.

---

## 2. User's Critical Feedback: Unknown Classification

The user correctly identified that we need to distinguish between different types of "unknown":

### Proposed Resolution Status Enum

```typescript
enum ResolutionStatus {
  // Successfully resolved
  RESOLVED = 'RESOLVED',                    // Single known value
  RESOLVED_CONDITIONAL = 'RESOLVED_CONDITIONAL',  // Multiple known values (ternary, switch)

  // Unknown but potentially resolvable in future
  DEFERRED_CROSS_FILE = 'DEFERRED_CROSS_FILE',      // Requires cross-file analysis
  DEFERRED_INTERPROCEDURAL = 'DEFERRED_INTERPROCEDURAL',  // Requires function return analysis
  DEFERRED_LOOP_ITERATION = 'DEFERRED_LOOP_ITERATION',    // Loop variable with known bounds
  DEFERRED_TEMPLATE_COMPLEX = 'DEFERRED_TEMPLATE_COMPLEX', // Complex template literal

  // Fundamentally unknowable at static analysis time
  UNKNOWN_RUNTIME = 'UNKNOWN_RUNTIME',      // User input, external API, runtime-dependent
  UNKNOWN_PARAMETER = 'UNKNOWN_PARAMETER',  // Function parameter (caller-dependent)
}
```

### Why This Matters

1. **Incremental Development:** We can track what's left to implement (DEFERRED_* categories)
2. **User Clarity:** Users know WHY something is unknown (can they expect resolution in future?)
3. **Metrics:** We can measure progress — "90% resolved, 5% deferred, 5% unknowable"
4. **Prioritization:** DEFERRED categories become the roadmap for future phases

### Interface Update

```typescript
interface ComputedPropertyResolution {
  // Original computed expression
  computedPropertyVar: string;

  // Resolution result
  status: ResolutionStatus;
  propertyNames: string[];  // Empty if not resolved

  // Metadata
  isConditional: boolean;   // True if multiple possible values
  reason?: string;          // Human-readable explanation for DEFERRED/UNKNOWN
  confidence: 'high' | 'medium' | 'low';
}
```

---

## 3. Implementation Phases

### Phase 1: Foundation (Current Scope)

**Goal:** Resolve the common cases that represent 80%+ of real-world usage.

**Deliverables:**
1. Add `computedPropertyVar` field to `ObjectMutationInfo`
2. Store computed variable name during AST analysis
3. Create enrichment step to resolve single-hop literal assignments
4. Update `FLOWS_INTO` edge metadata with resolved `propertyName`
5. Implement `ResolutionStatus` enum with initial values:
   - `RESOLVED`
   - `RESOLVED_CONDITIONAL`
   - `UNKNOWN_RUNTIME`
   - `UNKNOWN_PARAMETER`
   - `DEFERRED_CROSS_FILE` (placeholder for unimplemented)

**Coverage:**
| Pattern | Example | Resolution |
|---------|---------|------------|
| Direct literal | `const k = 'x'; obj[k]` | RESOLVED |
| Literal chain | `const a = 'x'; const b = a; obj[b]` | RESOLVED |
| Ternary | `const k = c ? 'a' : 'b'; obj[k]` | RESOLVED_CONDITIONAL |
| Parameter | `function f(k) { obj[k] }` | UNKNOWN_PARAMETER |
| External call | `const k = getKey(); obj[k]` | UNKNOWN_RUNTIME |
| Cross-file | `const k = imported.KEY; obj[k]` | DEFERRED_CROSS_FILE |

**Acceptance Criteria:**
- [ ] `obj[key] = value` where `const key = 'handler'` resolves to `propertyName: 'handler'`
- [ ] Conditional assignments (`const k = c ? 'a' : 'b'`) resolve with `isConditional: true`
- [ ] Resolution status is stored in edge metadata
- [ ] Tests cover all Phase 1 patterns
- [ ] Performance impact < 5% on analysis time

### Phase 2: Enhanced Resolution (Future)

**Goal:** Handle more complex cases, improve coverage.

**Deliverables:**
1. Template literal evaluation: `` `on${event}` `` with known parts
2. Object property access: `CONFIG.KEY` where CONFIG is known object literal
3. Multi-hop resolution through variable chains
4. Add status values:
   - `DEFERRED_TEMPLATE_COMPLEX`
   - `RESOLVED_PARTIAL` (some values known, some unknown)

### Phase 3: Cross-File Analysis (Future)

**Goal:** Handle imported constants and cross-file value propagation.

**Deliverables:**
1. Cross-file constant resolution via `IMPORTS_FROM` edges
2. Module export/import value tracking
3. Update `DEFERRED_CROSS_FILE` to `RESOLVED` when implemented

### Phase 4: Advanced Analysis (Future)

**Goal:** Handle inter-procedural and complex cases.

**Deliverables:**
1. Function return value analysis (when exhaustively analyzable)
2. Loop iteration analysis (when bounds are known)
3. Switch/case exhaustiveness analysis

---

## 4. Integration Points

### Existing Infrastructure to Leverage

1. **`ValueDomainAnalyzer`** (packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts)
   - Already has `getValueSet()` and `traceValueSet()` methods
   - Handles `ASSIGNED_FROM` edge traversal
   - Returns `{ values: [], hasUnknown: boolean }`
   - Need to extend return type to include `status: ResolutionStatus`

2. **`ObjectMutationInfo`** (packages/core/src/plugins/analysis/ast/types.ts)
   - Currently has `propertyName: string` (with `'<computed>'` for computed)
   - Add `computedPropertyVar?: string`

3. **`GraphBuilder.bufferObjectMutationEdges()`**
   - Currently creates `FLOWS_INTO` edges with `propertyName` metadata
   - Need to call resolution logic here or in enrichment

### Architecture Decision: Analysis vs Enrichment

**Recommendation:** Two-phase approach (as Altshuller suggested)

**Phase 1 (Analysis):**
- Store `computedPropertyVar` in `ObjectMutationInfo`
- Create edge with `propertyName: '<computed>'`
- Fast, no additional computation

**Phase 2 (Enrichment):**
- `ComputedPropertyResolver` plugin (new, or extend `ValueDomainAnalyzer`)
- Query for edges with `propertyName: '<computed>'`
- Resolve using `getValueSet()` approach
- Update edge metadata with resolved values and status

**Rationale:**
- Matches existing plugin architecture
- Enrichment phase has access to full graph
- Can be run selectively (skip for speed, run for accuracy)
- `ValueDomainAnalyzer` already runs in enrichment (priority 65)

---

## 5. Test Strategy

### Unit Tests

1. Direct literal assignment resolution
2. Literal chain resolution (multi-hop)
3. Conditional expression resolution (ternary)
4. Parameter detection (UNKNOWN_PARAMETER)
5. External call detection (UNKNOWN_RUNTIME)
6. Cross-file detection (DEFERRED_CROSS_FILE)
7. Edge metadata verification

### Integration Tests

1. Full analysis pipeline with resolution
2. Query by resolved property name
3. Query by resolution status (find all DEFERRED)

### Performance Tests

1. Benchmark on large fixture
2. Verify < 5% overhead

---

## 6. Risk Assessment

### Low Risk
- Adding `computedPropertyVar` field (additive change)
- Single-hop literal resolution (proven pattern in `ValueDomainAnalyzer`)
- Edge metadata updates (existing pattern)

### Medium Risk
- Performance impact on large codebases (mitigated by depth limits)
- False positives in conditional resolution (mitigated by `isConditional` flag)

### Low Priority / Future Risk
- Cross-file resolution complexity
- Inter-procedural analysis scalability

---

## 7. Conclusion

This feature is architecturally sound and implementable with existing infrastructure. The key additions from the synthesis:

1. **Resolution Status Enum** — Distinguishes knowable from unknowable, deferred from resolved
2. **Two-Phase Architecture** — Analysis collects, enrichment resolves
3. **Phased Rollout** — Start with high-impact cases, iterate

The user's feedback about unknown classification is not just a nice-to-have — it's the right way to build this feature. It enables:
- Progressive implementation (we can ship partial and improve)
- Clear user expectations (they know what's resolvable)
- Measurable progress (percentage of RESOLVED vs DEFERRED vs UNKNOWN)

**Recommendation:** Proceed with Phase 1 implementation. Create Linear issue with clear scope and acceptance criteria.

---

## References

1. Knuth analysis: `010-knuth-computed-property-analysis.md`
2. Altshuller TRIZ analysis: `011-altshuller-triz-analysis.md`
3. Jobs product vision: `012-jobs-product-vision.md`
4. ValueDomainAnalyzer: `/packages/core/src/plugins/enrichment/ValueDomainAnalyzer.ts`
5. ObjectMutationInfo: `/packages/core/src/plugins/analysis/ast/types.ts`

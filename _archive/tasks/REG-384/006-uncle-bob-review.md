# Uncle Bob Review — REG-384

## Uncle Bob Review: /Users/vadim/grafema-worker-2/packages/core/src/plugins/analysis/FetchAnalyzer.ts:analyzeModule

**Current state:** Large method with multiple responsibilities (AST parse, detection, graph writes). We will touch only the method-extraction path.
**Recommendation:** SKIP

**Risk:** HIGH (wide surface area, easy to regress behavior)
**Estimated scope:** 300+ LOC

## Uncle Bob Review: /Users/vadim/grafema-worker-2/packages/core/src/plugins/analysis/FetchAnalyzer.ts:extractMethod (and helpers)

**Current state:** Small, focused helper; will be replaced/extended to return method source.
**Recommendation:** SKIP

**Risk:** LOW (localized change is straightforward)
**Estimated scope:** 20–40 LOC

## Uncle Bob Review: /Users/vadim/grafema-worker-2/packages/core/src/plugins/enrichment/HTTPConnectionEnricher.ts:execute + pathsMatch

**Current state:** Matching logic is already clear and compact; changes are localized to method policy and regex handling.
**Recommendation:** SKIP

**Risk:** LOW–MEDIUM (matching changes can affect links)
**Estimated scope:** 30–60 LOC

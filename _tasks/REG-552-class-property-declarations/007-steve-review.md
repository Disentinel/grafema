## Steve Jobs — Vision Review (Round 2)

**Verdict:** APPROVE

**Vision alignment:** OK
**Architecture:** OK — duplication resolved, one remaining asymmetry is correctly documented

---

### Does the Refactoring Change the Verdict?

No. The verdict remains APPROVE. The refactoring tightens the implementation without changing what the graph captures or how it is queryable. The product intent is unchanged and correct.

---

### What Changed

**`handleNonFunctionClassProperty` as a private method (lines 165–213)**

The duplicated `else` branch that existed in both `ClassDeclaration` and `ClassExpression` handlers is now extracted into a single private method. This is the right structural call. The logic — compute semantic ID, push to `currentClass.properties`, extract modifier and declared type, push to `variableDeclarations` — was identical in both sites. One copy is better than two. The graph output is identical.

The method signature takes everything it needs as explicit parameters. That is clean: no hidden state captured from closure, the behavior is transparent from the call site.

**`metadata?: Record<string, unknown>` on `VariableDeclarationInfo`**

The `metadata` field uses the same escape hatch pattern that exists throughout the codebase for carrying enrichment data that does not fit a fixed schema. `modifier` and `declaredType` now travel as `metadata.modifier` and `metadata.declaredType` rather than top-level fields. This is the right tradeoff — it avoids polluting the core interface with fields that only apply to one narrow subtype of VARIABLE nodes (class properties).

The `Record<string, unknown>` type is wide, which means there is no compile-time enforcement of what keys are valid. That is a known cost. For an enrichment bag used in a single code path, it is acceptable. It is the same pattern REG-271 used before.

**Decorator asymmetry comment (line 844–845)**

```typescript
// Note: decorator extraction is intentionally omitted for ClassExpression properties.
// The ClassExpression handler has no decorator infrastructure — handle separately if needed.
```

This comment is correct and appropriate. It makes the asymmetry explicit rather than leaving it as a silent gap. A future developer or AI agent reading this code will not wonder why the behavior differs — it is stated. The asymmetry itself is pre-existing and out of scope for this PR. Documenting it is better than patching it with half-baked scope creep.

---

### Vision Alignment

Unchanged from Round 1. The graph now captures data fields on classes — their modifiers, declared types, static/instance distinction, and structural membership via HAS_PROPERTY edges. An AI agent can answer "what data does class X hold?" and "which classes reference type Y as a field?" without reading source files. That is the product thesis executed correctly.

The `metadata` bag makes `modifier` and `declaredType` queryable via graph traversal. Nothing is silently discarded.

---

### What Would Embarrass Us

Nothing. The refactoring made the code better and the result is cleaner than Round 1. Ship it.

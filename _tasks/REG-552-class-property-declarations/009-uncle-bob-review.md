## Uncle Bob — Code Quality Review

**Verdict:** REJECT

**File sizes:** Issue — file is 917 lines. Was 839 before this change; the new else branches added ~78 lines. The file was already beyond the 500-line threshold and is getting larger. Not a blocker by itself (the file was pre-existing), but worth noting.

**Method quality:** Issue — see duplication finding below.

**Patterns & naming:** OK — naming is clear, comments are purposeful, no TODOs/FIXMEs/commented-out code. The `as any` usage is constrained to Babel AST node access, which is acceptable and consistent with existing code.

---

### Issue 1: Significant duplication between ClassDeclaration and ClassExpression (REJECT reason)

The new `else` branch for non-function `ClassProperty` was copy-pasted verbatim into both handlers. The two blocks (lines 334-372 and 820-858) are nearly identical:

```typescript
// ClassDeclaration handler (lines 334-372):
const fieldId = computeSemanticIdV2('VARIABLE', propName, module.file, scopeTracker.getNamedParent());
if (!currentClass.properties) { currentClass.properties = []; }
currentClass.properties.push(fieldId);
const parts: string[] = [];
const acc = (propNode as any).accessibility as string | null | undefined;
if (acc && acc !== 'public') parts.push(acc);
if ((propNode as any).readonly) parts.push('readonly');
const modifier = parts.length > 0 ? parts.join(' ') : 'public';
const ann = (propNode as any).typeAnnotation;
let declaredType: string | undefined;
if (ann?.type === 'TSTypeAnnotation') { declaredType = typeNodeToString(ann.typeAnnotation); }
(collections.variableDeclarations as VariableDeclarationInfo[]).push({ ... } as any);

// ClassExpression handler (lines 820-858): identical logic, zero differences
```

The existing function-valued `ClassProperty` branches are also duplicated between the two handlers (this is pre-existing), but it already establishes a pattern the team should be moving away from, not reinforcing. Adding a second round of identical duplication compounds the problem.

**Required fix:** Extract a private method (e.g. `handleNonFunctionClassProperty`) that takes `propNode`, `propName`, `propLine`, `propColumn`, `currentClass`, and `className` as parameters, and call it from both handlers. This is the straightforward DRY fix and keeps each handler readable.

---

### Issue 2: `as any` on the pushed variableDeclarations record

Both else branches end with:

```typescript
(collections.variableDeclarations as VariableDeclarationInfo[]).push({
  ...
} as any);
```

The `as any` on the object literal is broader than necessary and hides a type mismatch. The implementation notes acknowledge that `isClassProperty`, `isStatic`, and `metadata` are not present on `VariableDeclarationInfo`. The correct fix is to extend `VariableDeclarationInfo` with these fields rather than suppressing the type check. This is a minor point and not a blocker on its own, but it documents a gap that should be addressed.

**Severity:** Minor — does not require re-review, should be tracked as follow-up.

---

### Issue 3: Asymmetry in decorator extraction noted but not addressed

Rob's implementation notes correctly identify that the `ClassExpression > ClassProperty` handler has no decorator extraction while `ClassDeclaration > ClassProperty` does. The note says "out of scope," and that decision is reasonable for this ticket. However, the absence of a comment in the ClassExpression handler (unlike the `ClassDeclaration` handler which has an explicit decorator block) means the asymmetry is invisible to the next reader.

**Severity:** Minor — a single comment in the ClassExpression else branch would suffice.

---

### Summary

The logic is correct, tests are well-structured and communicate intent clearly, and the naming is good. The sole blocker is the verbatim duplication of ~35 lines between the two `ClassProperty` else branches. Extract it to a private method and resubmit.

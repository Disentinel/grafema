## Uncle Bob — Code Quality Review

**Verdict:** REJECT

**File sizes:** WARN — `types.ts` is 1293 lines, `ClassVisitor.ts` is 903 lines. Both are above the 500-line flag threshold and were pre-existing issues. The new additions are small, but these files remain candidates for future extraction.

**Method quality:** REJECT — see duplication issue below.

**Patterns & naming:** OK — naming is clear and consistent with existing conventions. `fieldId`, `accessibility`, `isReadonly`, `tsType` are all honest names. The metadata-stripping pattern in `GraphBuilder.ts` mirrors the established REG-401 pattern correctly.

---

### Issues

**[REJECT] Identical 32-line else-block duplicated verbatim across ClassDeclaration and ClassExpression handlers**

The entire field-indexing logic (lines 334-366 in the `ClassDeclaration` handler and lines 813-845 in the `ClassExpression` handler) is a byte-for-byte copy:

```typescript
} else {
  // Non-function class property (field declaration) — REG-552
  if (propNode.computed) return;
  if ((propNode as any).declare) return;

  const fieldId = computeSemanticIdV2('VARIABLE', propName, module.file, scopeTracker.getNamedParent());

  if (!currentClass.properties) currentClass.properties = [];
  currentClass.properties.push(fieldId);

  const accessibility = propNode.accessibility ?? 'public';
  const isReadonly = propNode.readonly || false;
  const typeAnnotationNode = (propNode as any).typeAnnotation?.typeAnnotation;
  const tsType = typeAnnotationNode ? typeNodeToString(typeAnnotationNode) : undefined;

  (collections.variableDeclarations as VariableDeclarationInfo[]).push({
    id: fieldId,
    semanticId: fieldId,
    type: 'VARIABLE',
    name: propName,
    file: module.file,
    line: propLine,
    column: propColumn,
    isStatic: propNode.static || false,
    isClassProperty: true,
    parentScopeId: currentClass.id,
    accessibility,
    isReadonly: isReadonly || undefined,
    tsType,
  });
}
```

This is a DRY violation. The two handlers (`ClassDeclaration` and `ClassExpression`) share the entire `ClassProperty` traversal structure — both already share the surrounding function-property code. This logic should be extracted into a private method on `ClassVisitor`, e.g.:

```typescript
private indexClassFieldDeclaration(
  propNode: ClassProperty,
  propName: string,
  propLine: number,
  propColumn: number,
  currentClass: ClassInfo,
  module: VisitorModule,
  collections: VisitorCollections
): void {
  if (propNode.computed) return;
  if ((propNode as any).declare) return;
  // ... rest of logic
}
```

Both handlers call this method. A future bug fix or change to field indexing logic will then require changing one place, not two. Right now there are two copies waiting to diverge.

**[NOTE] Minor: `(propNode as any).declare` and `(propNode as any).typeAnnotation` — two untyped casts on the same propNode**

Both are necessary because Babel's `ClassProperty` type doesn't expose `declare` and the `typeAnnotation` shape is only loosely typed. This is acceptable, but they should be accessed via a single cast to a typed local variable to reduce noise:

```typescript
const tsNode = propNode as ClassProperty & { declare?: boolean; typeAnnotation?: { typeAnnotation: unknown } };
if (tsNode.declare) return;
const typeAnnotationNode = tsNode.typeAnnotation?.typeAnnotation;
```

This is a suggestion, not a blocking issue. The blocking issue is the duplication.

---

**Test quality:** OK — the test file is well-structured. Intent is clear per describe/it names. Each test is focused on one concern. The helpers (`getClassPropertyNodes`, `setupTest`) remove setup noise from the assertions. No unnecessary duplication.

One observation: the test header comments (lines 1-19) correctly document what is being verified including the metadata path (`metadata.accessibility`). The tests themselves read `node.accessibility` directly on the returned record — this works because `_parseNode` in `RFDBServerBackend` spreads metadata fields onto the top-level record. The tests are technically correct and match runtime behavior; the comment and the access path are consistent.

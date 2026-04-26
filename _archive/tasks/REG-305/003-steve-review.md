# Steve Jobs Review: REG-305 AST Track Mapped Types

**Reviewer:** Steve Jobs (High-level Review)
**Date:** 2026-02-14
**Verdict:** APPROVE

---

## 1. Vision Alignment

**Does this align with "AI should query the graph, not read code"?**

Yes. Before this change, mapped types like `Readonly<T>`, `Partial<T>`, `Required<T>`, and `Record<K, V>` appeared in the graph as TYPE nodes with `aliasOf: "unknown"`. An AI agent querying the graph would get zero useful information about these types. It would have to fall back to reading the source code -- the exact anti-pattern Grafema exists to eliminate.

After this change, the graph contains structured metadata: `mappedType: true`, `keyName`, `keyConstraint`, `valueType`, `mappedReadonly`, `mappedOptional`, `nameType`. An agent can now query:
- "Which types are mapped types?" -- filter on `mappedType: true`
- "Which types add readonly?" -- check `mappedReadonly: true`
- "Which types remove optionality?" -- check `mappedOptional: '-'`
- "What does this type iterate over?" -- read `keyConstraint`

The `typeNodeToString()` improvements also mean `aliasOf` now produces `{ readonly [K in keyof T]: T[K] }` instead of `"unknown"` -- so even text-based queries work.

This is a clear step forward for the graph's ability to represent TypeScript's type system.

## 2. Hacks and Shortcuts Check

**None found.** The implementation is clean and follows existing patterns exactly.

Specific observations:
- TypeNode.create() conditionally includes mapped fields only when `mappedType: true` -- avoids polluting simple type aliases with undefined fields. This is thoughtful.
- The `MappedModifier` type (`boolean | '+' | '-'`) correctly models TypeScript's three-state modifier system. This is not a simplification -- it's the actual representation.
- No TODO, FIXME, HACK comments. No commented-out code. No empty implementations.

## 3. Pattern Consistency

**Excellent consistency with EnumNode and InterfaceNode.**

| Aspect | InterfaceNode | EnumNode | TypeNode (new) |
|--------|--------------|----------|----------------|
| Record interface | `InterfaceNodeRecord` | `EnumNodeRecord` | `TypeNodeRecord` |
| Options interface | `InterfaceNodeOptions` | `EnumNodeOptions` | `TypeNodeOptions` |
| REQUIRED fields | name, file, line, column | name, file, line, column | name, file, line, column |
| OPTIONAL list | extends, properties, isExternal | isConst, members | aliasOf, mappedType, keyName, ... |
| ID format | `{file}:INTERFACE:{name}:{line}` | `{file}:ENUM:{name}:{line}` | `{file}:TYPE:{name}:{line}` |
| Validation | Same pattern | Same pattern | Same pattern |
| GraphBuilder | `bufferInterfaceNodes()` | `bufferEnumNodes()` | `bufferTypeAliasNodes()` |
| Factory method | `NodeFactory.createInterface()` | `NodeFactory.createEnum()` | `NodeFactory.createType()` |

The data flow pipeline is identical: TypeScriptVisitor collects info -> TypeAliasInfo -> GraphBuilder reads it -> NodeFactory.createType() -> TypeNode.create() -> buffered node. This is the same pattern used for interfaces and enums. No deviation.

## 4. Architectural Gaps -- Real-World Coverage

**Does this work for >50% of real-world mapped types?**

Covered:
- `Readonly<T>` -- `mappedReadonly: true` -- YES
- `Partial<T>` -- `mappedOptional: true` -- YES
- `Required<T>` -- `mappedOptional: '-'` -- YES
- `Mutable<T>` -- `mappedReadonly: '-'` -- YES
- `Record<K, V>` -- `keyConstraint`, `valueType` -- YES
- Key remapping (`as` clause) -- `nameType` -- YES
- Combined modifiers (`+readonly`, `-?`) -- YES

Not explicitly tested but structurally supported:
- `Pick<T, K>` / `Omit<T, K>` -- these are usually defined via conditional + mapped types. The mapped type part is captured. The conditional type is now handled by `typeNodeToString()`.
- Nested mapped types -- `typeNodeToString()` is recursive, so nested structures produce readable `aliasOf` strings.

The TypeScript standard library utility types are all mapped types. This implementation covers them. I see no gap that would make this feature useless for common cases.

## 5. typeNodeToString() Improvements

**Significant value beyond mapped types.** The new cases cover:

| AST Node | Example | Previous Output | New Output |
|----------|---------|-----------------|------------|
| `TSTypeOperator` | `keyof T` | `unknown` | `keyof T` |
| `TSIndexedAccessType` | `T[K]` | `unknown` | `T[K]` |
| `TSMappedType` | `{ [K in keyof T]: T[K] }` | `unknown` | Full representation |
| `TSConditionalType` | `T extends string ? A : B` | `unknown` | Full representation |
| `TSInferType` | `infer R` | `unknown` | `infer R` |
| `TSTypeQuery` | `typeof x` | `unknown` | `typeof x` |
| `TSParenthesizedType` | `(A \| B)` | `unknown` | `(A \| B)` |
| `TSTemplateLiteralType` | `` `get${K}` `` | `unknown` | `` `get${K}` `` |
| `TSRestType` | `...T[]` | `unknown` | `...T[]` |
| `TSOptionalType` | `T?` | `unknown` | `T?` |
| `TSNamedTupleMember` | `name: string` | `unknown` | `name: string` |

This is a systemic improvement. Every TYPE node in the graph that uses any of these constructs now gets a meaningful `aliasOf` string instead of `"unknown"`. This benefits ALL type aliases, not just mapped types.

## 6. Test Quality

**24 tests, well-structured across three layers:**

1. **Unit: TypeNode.create()** (8 tests) -- Verify the node contract directly. Test all modifier variants (`true`, `'-'`, `'+'`), nameType, validation, and the NodeFactory passthrough. Good boundary coverage.

2. **Unit: typeNodeToString()** (9 tests) -- Test each new AST node type with synthetic AST objects. Covers keyof, indexed access, mapped type with modifiers, conditional types, infer types. Direct and focused.

3. **Integration: TypeScriptVisitor** (7 tests) -- Parse real TypeScript source code, run the visitor, verify the extracted `TypeAliasInfo`. Tests: Readonly, Partial, Mutable (-readonly), Required (-?), key remapping (as clause), negative case (simple aliases not flagged), and aliasOf quality check.

The integration tests use `@babel/parser` to parse real TS code, which is the actual parser used in production. This is not mocking -- it is testing the real pipeline.

One minor note: the integration tests call `handlers.TSTypeAliasDeclaration({ node: stmt })` directly instead of running the full Babel traverse. This is acceptable because the handler itself is the unit under test, and Babel traverse's ability to find `TSTypeAliasDeclaration` nodes is not in question.

## 7. Mandatory Checklist

### Complexity Check
**PASS.** No O(n) scan over all nodes. The implementation adds metadata during the existing per-file visitor pass (TypeScriptVisitor processes each TSTypeAliasDeclaration node as it encounters it during AST traversal). This is O(k) where k = number of type aliases in the current file. No additional graph-wide iteration.

### Plugin Architecture
**PASS.** This is forward registration. The analyzer (TypeScriptVisitor) marks data during AST traversal and stores it in TypeAliasInfo metadata. The builder (GraphBuilder.bufferTypeAliasNodes) reads it and creates the node. No backward scanning. No searching for patterns.

### Extensibility
**PASS.** Adding new mapped type variants (new TypeScript syntax) requires only:
1. A new case in `typeNodeToString()` (if the string representation is needed)
2. Possibly new metadata fields on TypeAliasInfo/TypeNode (if structured data is needed)

No enricher changes. No graph-wide re-processing. The pattern is: add a case to the visitor, the rest of the pipeline carries it through automatically.

## Summary

This is a well-executed, pattern-consistent enhancement that materially improves Grafema's ability to represent TypeScript's type system in the graph. The implementation follows every existing convention. The `typeNodeToString()` improvements have broad systemic value beyond the specific mapped type feature. Tests are thorough and test at the right abstraction levels.

No hacks. No shortcuts. No architectural gaps. Aligned with vision.

**APPROVE** -- escalate to Vadim for final confirmation.

# Don Melton — REG-300: Track import.meta

## Analysis

`import.meta` is an ESM-only construct. In Babel AST, `import.meta` is a `MetaProperty` node:

```
// import.meta.url
MemberExpression {
  object: MetaProperty { meta: Identifier("import"), property: Identifier("meta") },
  property: Identifier("url")
}
```

Currently, `PropertyAccessVisitor.extractChain()` (line 275) only recognizes `Identifier` and `ThisExpression` as base objects. `MetaProperty` hits the fallback `return []` — silently skipped.

## Approach: Extend PropertyAccessVisitor (Single-point change)

**No new visitor, no new node type.** Just teach the existing chain extractor to recognize `MetaProperty` as a valid base with `baseName = "import.meta"`.

### What changes

1. **PropertyAccessVisitor.extractChain()** — add `MetaProperty` as valid base object type
   - `import.meta.url` → `PROPERTY_ACCESS { objectName: "import.meta", propertyName: "url" }`
   - `import.meta.env.MODE` → two nodes: `{ objectName: "import.meta", propertyName: "env" }` + `{ objectName: "import.meta.env", propertyName: "MODE" }`

2. **GraphBuilder.bufferPropertyAccessNodes()** — collect `import.meta.*` properties, store as MODULE metadata
   - Scan property accesses for `objectName === "import.meta"`
   - Collect unique `propertyName` values → `{ importMeta: ["url", "env"] }`
   - Update MODULE node metadata

### Why this is right

- **Reuses existing infrastructure.** PROPERTY_ACCESS nodes, CONTAINS edges, semantic IDs — all work as-is.
- **Consistent model.** `import.meta.url` is queried the same way as `process.env.NODE_ENV` — by objectName.
- **Zero new types.** No node type proliferation.
- **Forward-compatible.** When we track other well-known globals (process, globalThis), same pattern works.

### Acceptance criteria mapping

| Criteria | How |
|----------|-----|
| Track import.meta.url, import.meta.env | PROPERTY_ACCESS nodes with objectName="import.meta" |
| MODULE metadata for which meta properties used | importMeta array on MODULE node metadata |

### Files to modify

| File | Change |
|------|--------|
| `PropertyAccessVisitor.ts` | Add `MetaProperty` to base object check in `extractChain()` |
| `GraphBuilder.ts` | Collect import.meta properties, update MODULE metadata |
| `property-access.test.ts` | New test cases for import.meta tracking |

### Complexity

O(n) over property accesses already collected — no additional traversal.

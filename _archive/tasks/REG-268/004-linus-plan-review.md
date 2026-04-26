# Linus Torvalds - Plan Review for REG-268

## Verdict: APPROVED (with clarifications)

The plan is solid. Don and Joel did their homework. This is a straightforward feature extension that follows existing patterns. No clever bullshit, no over-engineering.

## What They Got Right

1. **Babel AST handling is correct.** Verified: dynamic `import()` is represented as `CallExpression` with `callee.type === 'Import'`. The plan correctly handles this.

2. **No architectural changes needed.** This extends existing functionality without changing the 3-phase flow. Good. Resist the temptation to "improve" things while you're in there.

3. **ImportExportLinker will work as-is.** I checked the code. It already handles relative path resolution and creates IMPORTS_FROM edges based on `imp.source`. For resolvable dynamic imports, it will just work. For unresolvable ones (`isResolvable: false`), we skip the edge - which is correct.

4. **Semantic ID design is sensible.** Using `{file}:IMPORT:{source}:{local}` matches existing pattern. The `*` for unnamed imports is consistent with namespace imports.

## Clarifications Required

### 1. What about `require()`?

The user request mentions `import()` but what about CommonJS `require()`? Is this out of scope? If so, state it explicitly. Don't leave ambiguity - someone will ask "why doesn't require() work?" later.

**Decision needed:** Is `require()` in scope? If not, add to Linear backlog.

### 2. Template literal path extraction is incomplete

Joel's plan shows:
```javascript
source = quasis[0].value.raw;  // e.g., "./config/"
```

This only gets the prefix. But what if the template literal is:
```javascript
import(`${baseDir}/config.js`)  // No static prefix!
```

The plan says `source = quasis[0].value.raw` but that would be empty string.

**Fix:** When prefix is empty, use `<dynamic>` as source, same as variable path.

### 3. The `dynamicPath` reconstruction is fragile

```javascript
dynamicPath = `\`${arg.quasis.map(q => q.value.raw).join('${...}')}\``;
```

This assumes quasis have a `value.raw` that's meaningful. Fine for simple cases, but for complex nested templates this might produce garbage.

**Acceptable for v1:** Just document the limitation. Don't over-engineer it.

### 4. AwaitExpression traversal needs care

Joel's plan:
```javascript
if (parent?.type === 'AwaitExpression') {
  const grandparent = path.parentPath?.parent;
  if (grandparent?.type === 'VariableDeclarator') {
```

This handles `const mod = await import('./x')`. But what about:
```javascript
const mod = import('./x');  // No await - still valid, returns Promise
const mod = (await import('./x'));  // Extra parens
```

**Risk:** Low. These edge cases are rare. If they don't work in v1, fix later. Don't add complexity now.

### 5. Missing from plan: Test fixture files

Joel's plan lists test cases but doesn't specify the fixture file(s). Kent needs to know:
- Create new fixture directory? (Recommended: `test/fixtures/dynamic-imports/`)
- What files should be in it?
- Should there be files that ARE imported dynamically to test edge resolution?

**Action:** Kent should create fixture files that match the test cases.

## What NOT to Do

1. **Don't try to "partially resolve" template literals.** The plan mentions "base path known" for templates. NO. Either the path is fully resolvable (string literal) or it's not. Don't create half-baked edges that point to directories.

2. **Don't create EXTERNAL_MODULE nodes for unresolvable dynamic imports.** The plan doesn't mention this, but someone might think "oh, we should create an external node for `<dynamic>`". Don't. If we can't resolve it, we can't resolve it.

3. **Don't add special handling for `.then()` chains.** Someone might want to handle `import('./x').then(mod => ...)`. That's data flow, not import tracking. Out of scope.

## Summary

The plan is correct. Implement it. Ship it.

Minor adjustments:
- Handle empty template prefix as `<dynamic>`
- Clarify `require()` is out of scope (or add to backlog)
- Kent: create proper fixtures

**APPROVED.**

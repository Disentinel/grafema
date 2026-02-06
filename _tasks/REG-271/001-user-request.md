# REG-271: Track class static blocks and private fields

**Labels:** v0.3, Feature
**Priority:** Low

## Problem

Modern JavaScript class features are not tracked:

```javascript
class Foo {
  static {
    // Static initialization block - NOT tracked
    console.log('Class loaded');
  }

  #privateField = 1;  // Private field - NOT tracked

  #privateMethod() { }  // Private method - NOT tracked
}
```

## Why It Matters

* **Static blocks** contain initialization logic that may have side effects
* **Private fields** are increasingly common in modern codebases
* **Encapsulation analysis** - Understanding what's truly private vs public

## Proposed Solution

### Static Blocks

Create SCOPE node for static block:

```
CLASS -[CONTAINS]→ SCOPE#static-block
```

### Private Fields

Track as VARIABLE/METHOD with `isPrivate: true`:

```typescript
interface ClassMember {
  isPrivate: boolean;  // true for #field, #method
  name: string;        // includes # prefix
}
```

Create edges:

```
CLASS -[HAS_PROPERTY]→ VARIABLE(#privateField)
CLASS -[CONTAINS]→ METHOD(#privateMethod)
```

## Acceptance Criteria

- [ ] Static blocks create SCOPE nodes with CONTAINS edge from CLASS
- [ ] Private fields create VARIABLE nodes with isPrivate: true
- [ ] Private methods create METHOD nodes with isPrivate: true
- [ ] Tests cover static blocks, private fields, private methods

## Linear

https://linear.app/reginaflow/issue/REG-271/track-class-static-blocks-and-private-fields

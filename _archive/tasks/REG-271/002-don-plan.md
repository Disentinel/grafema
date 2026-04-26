# Don Melton (Tech Lead) - High-Level Plan for REG-271

## Task: Track Class Static Blocks and Private Fields

Modern JavaScript class features are not tracked by Grafema's analyzer:
- Static blocks (`static { ... }`)
- Private fields (`#privateField`)
- Private methods (`#privateMethod()`)

---

## 1. Research Summary

### Babel AST Node Types

Based on [Babel's AST specification](https://github.com/babel/babel/blob/main/packages/babel-parser/ast/spec.md):

**StaticBlock:**
```typescript
interface StaticBlock extends Node {
  type: "StaticBlock";
  body: Statement[];
}
```

**ClassPrivateProperty:**
```typescript
interface ClassPrivateProperty extends Node {
  type: "ClassPrivateProperty";
  key: PrivateName;
  value: Expression | null;
  static: boolean;
}
```

**ClassPrivateMethod:**
```typescript
interface ClassPrivateMethod extends Node {
  type: "ClassPrivateMethod";
  key: PrivateName;
  value: FunctionExpression;
  kind: "get" | "set" | "method";
  static: boolean;
}
```

**PrivateName:**
```typescript
interface PrivateName extends Node {
  type: "PrivateName";
  id: Identifier;  // The identifier WITHOUT the # prefix
}
```

### Key Insight

The `#` prefix is NOT stored in the identifier name. For `#privateField`, the `PrivateName.id.name` is `"privateField"`. We must prepend `#` for display/storage.

---

## 2. Current Architecture Analysis

### Where Changes Are Needed

| File | Purpose | Changes Needed |
|------|---------|----------------|
| `ClassVisitor.ts` | Handles ClassDeclaration/Method/Property | Add handlers for StaticBlock, ClassPrivateProperty, ClassPrivateMethod |
| `types.ts` | AST collection types | No new types needed - reuse existing |
| `GraphBuilder.ts` | Creates graph nodes/edges | Minimal - SCOPE/FUNCTION already handled |

### Existing Patterns to Follow

**ClassVisitor already handles:**
1. `ClassDeclaration` - creates CLASS node
2. `ClassMethod` - creates FUNCTION node, adds to `class.methods[]`
3. `ClassProperty` (with function value) - creates FUNCTION node

**Key patterns from ClassVisitor.ts:**
- Uses `scopeTracker.enterScope()` / `exitScope()` for semantic IDs
- Adds method IDs to `currentClass.methods` array for CONTAINS edges
- Creates SCOPE nodes for method bodies with `analyzeFunctionBody()` callback
- Extracts decorators from class members

---

## 3. Proposed Solution

### 3.1 Static Blocks

**Input:**
```javascript
class Foo {
  static {
    console.log('Class loaded');
    Foo.registry = new Map();
  }
}
```

**Graph representation:**
```
CLASS(Foo) -[CONTAINS]-> SCOPE(static-block)
                           |
                           +--[CONTAINS]-> CALL(console.log)
                           +--[CONTAINS]-> ...
```

**Implementation:**
1. Add `StaticBlock` handler in ClassVisitor's traverse
2. Create SCOPE node with `scopeType: 'static_block'`
3. Use `analyzeFunctionBody()` to process static block's body
4. Add scope ID to class for CONTAINS edge

**Important:** Static blocks don't create FUNCTION nodes - they're initialization code, not callable methods.

### 3.2 Private Fields (Properties)

**Input:**
```javascript
class Foo {
  #count = 0;
  static #instances = [];
}
```

**Graph representation:**
```
CLASS(Foo) -[HAS_PROPERTY]-> VARIABLE(#count, isPrivate: true)
CLASS(Foo) -[HAS_PROPERTY]-> VARIABLE(#instances, isPrivate: true, isStatic: true)
```

**Implementation:**
1. Add `ClassPrivateProperty` handler in ClassVisitor
2. Create VARIABLE node with:
   - `name: '#' + node.key.id.name` (prepend # for clarity)
   - `isPrivate: true`
   - `isStatic: node.static`
3. Create HAS_PROPERTY edge from CLASS to VARIABLE

**Design decision:** Use VARIABLE (not a new node type) because private fields ARE class variables. The `isPrivate` flag distinguishes them.

### 3.3 Private Methods

**Input:**
```javascript
class Foo {
  #validate() { return true; }
  static #configure(opts) { }
}
```

**Graph representation:**
```
CLASS(Foo) -[CONTAINS]-> FUNCTION(#validate, isPrivate: true)
CLASS(Foo) -[CONTAINS]-> FUNCTION(#configure, isPrivate: true, isStatic: true)
```

**Implementation:**
1. Add `ClassPrivateMethod` handler in ClassVisitor
2. Create FUNCTION node with:
   - `name: '#' + node.key.id.name`
   - `isPrivate: true`
   - `isStatic: node.static`
   - `methodKind: node.kind` (method/get/set)
3. Add function ID to `currentClass.methods[]` for CONTAINS edge
4. Use `analyzeFunctionBody()` to process method body

**Key insight:** Private methods are nearly identical to regular ClassMethod handling - just with the `isPrivate` flag and `#` prefix.

---

## 4. Type Extensions

### 4.1 VariableDeclarationInfo (types.ts)

```typescript
export interface VariableDeclarationInfo {
  // ... existing fields ...
  isPrivate?: boolean;   // NEW: true for #privateField
  isStatic?: boolean;    // NEW: true for static #field (class-level)
}
```

### 4.2 FunctionInfo (types.ts)

```typescript
export interface FunctionInfo {
  // ... existing fields ...
  isPrivate?: boolean;   // NEW: true for #privateMethod
  isStatic?: boolean;    // NEW: true for static #method() (already exists for static methods?)
}
```

**Note:** Check if `isStatic` already exists for ClassMethod - if so, just add `isPrivate`.

### 4.3 ClassDeclarationInfo (types.ts)

```typescript
export interface ClassDeclarationInfo {
  // ... existing fields ...
  properties?: string[];  // NEW: IDs of class properties (including private)
  staticBlocks?: string[];  // NEW: IDs of static block scopes
}
```

---

## 5. Files to Modify

### Primary Changes

| File | Estimated LOC | Description |
|------|--------------|-------------|
| `ClassVisitor.ts` | +80-100 | Add StaticBlock, ClassPrivateProperty, ClassPrivateMethod handlers |
| `types.ts` | +10 | Add isPrivate, isStatic to interfaces |
| `GraphBuilder.ts` | +15-20 | Buffer HAS_PROPERTY edges for class properties |

### Secondary Changes (if needed)

| File | Description |
|------|-------------|
| `ClassNode.ts` | Add `properties` array if we want to track non-method members |
| `VariableDeclarationNode.ts` | Ensure isPrivate/isStatic are supported in node creation |

---

## 6. Test Cases

### Static Blocks
1. Single static block with initialization code
2. Multiple static blocks (rare but valid)
3. Static block with calls to class methods
4. Static block accessing `this` (should be undefined) - edge case

### Private Fields
1. Private instance field: `#field = value`
2. Private static field: `static #field = value`
3. Private field without initializer: `#field;`
4. Private field with function value: `#handler = () => {}`

### Private Methods
1. Private instance method: `#method() {}`
2. Private static method: `static #method() {}`
3. Private getter: `get #prop() {}`
4. Private setter: `set #prop(v) {}`
5. Private async method: `async #fetchData() {}`

### Edge Cases
1. Class with only private members
2. Private method calling other private methods
3. Private field used in constructor
4. Nested class with private members (rare)

---

## 7. Alignment with Grafema Architecture

### Principles Verified

1. **Plugin-based, modular:** Changes confined to ClassVisitor - no new visitors needed
2. **Reuse before build:** Using existing VARIABLE/FUNCTION/SCOPE node types
3. **Forward registration:** Analyzer marks data (isPrivate), no backward scanning
4. **No O(n) over all nodes:** Only processes class members during traversal

### Edge Types Used

| Edge | From | To | Note |
|------|------|----|------|
| CONTAINS | CLASS | FUNCTION (private method) | Existing edge type |
| CONTAINS | CLASS | SCOPE (static block) | Existing edge type |
| HAS_PROPERTY | CLASS | VARIABLE (private field) | **New edge direction** - verify this exists |

**Action needed:** Verify HAS_PROPERTY can connect CLASS -> VARIABLE. Currently used for OBJECT_LITERAL -> values. May need to generalize or use different edge type.

---

## 8. Risk Assessment

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| HAS_PROPERTY edge semantics conflict | Medium | Could use new edge type HAS_FIELD if needed |
| PrivateName handling across visitors | Low | Centralize # prefix logic |
| Static block body analysis completeness | Low | Reuse analyzeFunctionBody infrastructure |

---

## 9. Recommendation

**Proceed with implementation.** This is a well-scoped enhancement that:
- Fills a documented gap in AST coverage
- Follows existing patterns in ClassVisitor
- Requires no new node types (just flags)
- Has clear acceptance criteria

**Complexity estimate:** Medium (2-3 days including tests)

**Next step:** Joel to expand into detailed technical spec with exact code locations and test file structure.

---

## Sources

- [Babel AST Specification](https://github.com/babel/babel/blob/main/packages/babel-parser/ast/spec.md)
- [Babel Types Documentation](https://babeljs.io/docs/babel-types)

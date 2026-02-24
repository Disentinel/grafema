# AST Node Coverage

This document tracks which JavaScript/TypeScript AST nodes are handled by Navi's static analyzer.

## Legend

- **Handled** - Creates graph nodes/edges, fully tracked
- **Partial** - Recognized but limited handling
- **Not Handled** - No processing, could be added
- **N/A** - Not relevant for code graph analysis

---

## Declarations

| AST Node | Status | Creates | Notes |
|----------|--------|---------|-------|
| `FunctionDeclaration` | Handled | FUNCTION node | Full support with body analysis |
| `ClassDeclaration` | Handled | CLASS node | Methods tracked, CONTAINS edges |
| `ClassMethod` | Handled | FUNCTION node | Nested in ClassDeclaration |
| `ClassProperty` | Handled | FUNCTION (if arrow) | Arrow function properties |
| `VariableDeclaration` | Handled | VARIABLE/CONSTANT | Tracks assignments, aliases |
| `ImportDeclaration` | Handled | IMPORT node | IMPORTS_FROM edges |
| `ExportNamedDeclaration` | Handled | EXPORT node | EXPORTS edges (via ExportEntityLinker) |
| `ExportDefaultDeclaration` | Handled | EXPORT node | Default exports |

## Expressions

| AST Node | Status | Creates | Notes |
|----------|--------|---------|-------|
| `CallExpression` | Handled | CALL node | Direct and method calls |
| `NewExpression` | Handled | CALL node (isNew=true) | Constructor calls |
| `MemberExpression` | Partial | Used in CALL | Object.method patterns |
| `ArrowFunctionExpression` | Handled | FUNCTION node | Anonymous and named |
| `FunctionExpression` | Handled | FUNCTION node | Callbacks |
| `AssignmentExpression` | Handled | ASSIGNED_FROM edge | Variable tracking |
| `UpdateExpression` | Handled | MODIFIES edge | i++, --count |
| `AwaitExpression` | Partial | Marks async | Parent function async |
| `YieldExpression` | Partial | Marks generator | Parent function generator |
| `BinaryExpression` | Not Handled | - | Could track operations |
| `UnaryExpression` | Not Handled | - | typeof, !, - |
| `LogicalExpression` | Not Handled | - | &&, \|\|, ?? |
| `ConditionalExpression` | Not Handled | - | ternary |
| `SequenceExpression` | Not Handled | - | comma operator |
| `OptionalMemberExpression` | Not Handled | - | obj?.prop |
| `OptionalCallExpression` | Not Handled | - | fn?.() |

## Statements

| AST Node | Status | Creates | Notes |
|----------|--------|---------|-------|
| `IfStatement` | Handled | SCOPE node | Conditional scope tracking |
| `ForStatement` | Handled | SCOPE node | Loop scope |
| `WhileStatement` | Handled | SCOPE node | Loop scope |
| `DoWhileStatement` | Handled | SCOPE node | Loop scope |
| `TryStatement` | Handled | SCOPE node | Error handling scope |
| `ThrowStatement` | Not Handled | - | Could create THROWS edge |
| `ReturnStatement` | Handled | RETURNS | Tracks return values for data flow |
| `SwitchStatement` | Not Handled | - | Case analysis |
| `BreakStatement` | N/A | - | Control flow |
| `ContinueStatement` | N/A | - | Control flow |
| `LabeledStatement` | N/A | - | Rare in modern code |
| `WithStatement` | N/A | - | Deprecated |

## Patterns

| AST Node | Status | Creates | Notes |
|----------|--------|---------|-------|
| `ObjectPattern` | Not Handled | - | const { a, b } = obj |
| `ArrayPattern` | Not Handled | - | const [a, b] = arr |
| `RestElement` | Not Handled | - | ...rest |
| `SpreadElement` | Not Handled | - | [...arr] |
| `AssignmentPattern` | Not Handled | - | Default params |

## Literals

| AST Node | Status | Creates | Notes |
|----------|--------|---------|-------|
| `StringLiteral` | Handled | LITERAL node | In method call args |
| `NumericLiteral` | Handled | LITERAL node | In method call args |
| `BooleanLiteral` | Handled | LITERAL node | In method call args |
| `NullLiteral` | Partial | - | Tracked as null value |
| `RegExpLiteral` | Not Handled | - | Regex patterns |
| `TemplateLiteral` | Partial | - | URL extraction in fetch |
| `TaggedTemplateExpression` | Not Handled | - | sql\`query\` |
| `ObjectExpression` | Partial | - | Object literal analysis |
| `ArrayExpression` | Not Handled | - | Array literals |

## Special

| AST Node | Status | Creates | Notes |
|----------|--------|---------|-------|
| `ThisExpression` | Handled | - | Used in method calls |
| `Super` | Not Handled | - | super.method() |
| `MetaProperty` | Not Handled | - | import.meta |
| `Decorator` | Not Handled | - | @decorator |
| `PrivateName` | Not Handled | - | #privateProp |

## TypeScript-Specific

| AST Node | Status | Creates | Notes |
|----------|--------|---------|-------|
| `TSTypeAnnotation` | Not Handled | - | Type annotations |
| `TSInterfaceDeclaration` | Not Handled | - | interface Foo {} |
| `TSTypeAliasDeclaration` | Not Handled | - | type Foo = ... |
| `TSEnumDeclaration` | Not Handled | - | enum Direction {} |
| `TSModuleDeclaration` | Not Handled | - | namespace/module |
| `TSAsExpression` | Not Handled | - | value as Type |

---

## Priority Recommendations

### High Priority (Security/Data Flow)

1. **ThrowStatement** - Track error throwing for security analysis
2. **ObjectPattern/ArrayPattern** - Destructuring is common, affects data flow
3. **OptionalCallExpression** - ?. is common in modern code
4. **TaggedTemplateExpression** - SQL injection detection (sql\`...\`)

### Medium Priority (Better Analysis)

5. **ReturnStatement** - Function return type tracking
6. **SwitchStatement** - Conditional logic analysis
7. **Super** - Class inheritance tracking
8. **SpreadElement/RestElement** - Data propagation

### Low Priority (Nice to Have)

9. **BinaryExpression/LogicalExpression** - Expression analysis
10. **TypeScript nodes** - Type-aware analysis
11. **Decorators** - Framework detection

---

## Currently Handled Node Types

```
FunctionDeclaration      ArrowFunctionExpression   FunctionExpression
ClassDeclaration         ClassMethod               ClassProperty
VariableDeclaration      ImportDeclaration         ExportDeclaration
CallExpression           NewExpression             MemberExpression
AssignmentExpression     UpdateExpression
IfStatement              ForStatement              WhileStatement
DoWhileStatement         TryStatement
StringLiteral            NumericLiteral            BooleanLiteral
ThisExpression           TemplateLiteral (partial)
```

## Graph Nodes Created

| Node Type | From AST |
|-----------|----------|
| FUNCTION | FunctionDeclaration, ArrowFunctionExpression, ClassMethod |
| CLASS | ClassDeclaration |
| VARIABLE | VariableDeclaration |
| CONSTANT | VariableDeclaration (const with literal) |
| CALL | CallExpression, NewExpression |
| IMPORT | ImportDeclaration |
| EXPORT | ExportDeclaration |
| SCOPE | IfStatement, ForStatement, WhileStatement, TryStatement |
| LITERAL | StringLiteral, NumericLiteral, BooleanLiteral |
| MODULE | File-level |

## Graph Edges Created

| Edge Type | From Pattern |
|-----------|--------------|
| CALLS | CallExpression resolved to FUNCTION |
| CONTAINS | CLASS -> METHOD, FUNCTION -> SCOPE |
| IMPORTS_FROM | ImportDeclaration |
| EXPORTS | ExportDeclaration (via ExportEntityLinker) |
| ASSIGNED_FROM | AssignmentExpression |
| MODIFIES | UpdateExpression (i++, --j) |
| INSTANCE_OF | NewExpression -> CLASS |
| HAS_CALLBACK | CallExpression with function arg |
| HANDLED_BY | Event listener pattern |
| RETURNS | ReturnStatement (return value -> FUNCTION) |

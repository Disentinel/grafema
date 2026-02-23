# Babel AST Node Types → Grafema Semantic Mapping

This document maps ALL @babel/parser AST node types to their attributes and the semantic relations they should create in Grafema's graph.

## Legend

**Grafema Node Types**: `FUNCTION`, `CLASS`, `METHOD`, `VARIABLE`, `PARAMETER`, `MODULE`, `IMPORT`, `EXPORT`, `CALL`, `SCOPE`, `EXPRESSION`, `LITERAL`, `CONSTANT`, `INTERFACE`, `TYPE`, `ENUM`, `DECORATOR`

**Grafema Edge Types**: `CONTAINS`, `DEPENDS_ON`, `CALLS`, `HAS_CALLBACK`, `PASSES_ARGUMENT`, `RECEIVES_ARGUMENT`, `RETURNS`, `EXTENDS`, `IMPLEMENTS`, `IMPORTS_FROM`, `EXPORTS`, `DEFINES`, `USES`, `DECLARES`, `MODIFIES`, `CAPTURES`, `ASSIGNED_FROM`, `READS_FROM`, `WRITES_TO`, `DERIVES_FROM`, `FLOWS_INTO`, `HAS_PROPERTY`, `HAS_ELEMENT`, `THROWS`

---

## 1. Program Structure

### File
| Attribute | Type | Description |
|-----------|------|-------------|
| `program` | Program | The root program node |
| `comments` | Comment[] | All comments in the file |
| `tokens` | Token[] | All tokens (if requested) |

**Semantic Relations:**
- Creates → `MODULE` node
- `MODULE` -[CONTAINS]→ all top-level declarations

### Program
| Attribute | Type | Description |
|-----------|------|-------------|
| `body` | Statement[] | Array of statements |
| `directives` | Directive[] | Prologue directives ("use strict") |
| `sourceType` | "script" \| "module" | Module or script mode |
| `interpreter` | InterpreterDirective? | Shebang line |

**Semantic Relations:**
- Creates → `SCOPE` (global/module scope)
- `SCOPE` -[CONTAINS]→ all body declarations

---

## 2. Declarations

### FunctionDeclaration
| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | Identifier | Function name |
| `params` | Pattern[] | Parameter list |
| `body` | BlockStatement | Function body |
| `generator` | boolean | Is generator function |
| `async` | boolean | Is async function |
| `returnType` | TypeAnnotation? | Return type (TS/Flow) |
| `typeParameters` | TypeParameterDeclaration? | Generic type params |
| `declare` | boolean | Is ambient declaration |
| `predicate` | DeclaredPredicate? | Flow predicate |

**Semantic Relations:**
- Creates → `FUNCTION` node
- `FUNCTION` -[RECEIVES_ARGUMENT]→ each `PARAMETER`
- `FUNCTION` -[RETURNS]→ return type/value
- `FUNCTION` -[HAS_SCOPE]→ `SCOPE` (function scope)
- Parent -[CONTAINS]→ `FUNCTION`

### VariableDeclaration
| Attribute | Type | Description |
|-----------|------|-------------|
| `kind` | "var" \| "let" \| "const" | Declaration kind |
| `declarations` | VariableDeclarator[] | Variable declarators |
| `declare` | boolean | Is ambient declaration |

**Semantic Relations:**
- Per declarator: Creates → `VARIABLE` or `CONSTANT` (if const)
- Parent scope -[DECLARES]→ `VARIABLE`

### VariableDeclarator
| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | LVal | Variable name/pattern |
| `init` | Expression? | Initial value |
| `definite` | boolean | Definite assignment (TS) |

**Semantic Relations:**
- Creates → `VARIABLE` node
- If `init` exists: `VARIABLE` -[ASSIGNED_FROM]→ init expression result
- If pattern destructuring: `VARIABLE` -[DERIVES_FROM]→ source object/array

### ClassDeclaration / ClassExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | Identifier? | Class name |
| `superClass` | Expression? | Parent class |
| `body` | ClassBody | Class body |
| `decorators` | Decorator[] | Class decorators |
| `implements` | TSExpressionWithTypeArguments[] | Implemented interfaces |
| `abstract` | boolean | Is abstract class (TS) |
| `declare` | boolean | Is ambient declaration |
| `mixins` | InterfaceExtends[] | Flow mixins |

**Semantic Relations:**
- Creates → `CLASS` node
- If `superClass`: `CLASS` -[EXTENDS]→ parent `CLASS`
- If `implements`: `CLASS` -[IMPLEMENTS]→ each `INTERFACE`
- If `decorators`: `DECORATOR` -[DECORATES]→ `CLASS`
- `CLASS` -[CONTAINS]→ each method/property

### ClassBody
| Attribute | Type | Description |
|-----------|------|-------------|
| `body` | ClassMember[] | Class members |

### ClassMethod / ClassPrivateMethod
| Attribute | Type | Description |
|-----------|------|-------------|
| `kind` | "constructor" \| "method" \| "get" \| "set" | Method kind |
| `key` | Expression \| PrivateName | Method name |
| `params` | Pattern[] | Parameters |
| `body` | BlockStatement | Method body |
| `computed` | boolean | Computed property name |
| `static` | boolean | Static method |
| `generator` | boolean | Generator method |
| `async` | boolean | Async method |
| `abstract` | boolean | Abstract method (TS) |
| `decorators` | Decorator[] | Method decorators |
| `returnType` | TypeAnnotation? | Return type |
| `typeParameters` | TypeParameterDeclaration? | Generic params |

**Semantic Relations:**
- Creates → `METHOD` node
- `CLASS` -[CONTAINS]→ `METHOD`
- `METHOD` -[RECEIVES_ARGUMENT]→ each `PARAMETER`
- If `kind === "constructor"`: `CLASS` -[HAS_CONSTRUCTOR]→ `METHOD`
- If getter/setter: `METHOD` -[ACCESSES]→ property
- If `decorators`: `DECORATOR` -[DECORATES]→ `METHOD`

### ClassProperty / ClassPrivateProperty / ClassAccessorProperty
| Attribute | Type | Description |
|-----------|------|-------------|
| `key` | Expression \| PrivateName | Property name |
| `value` | Expression? | Initial value |
| `typeAnnotation` | TypeAnnotation? | Type annotation |
| `static` | boolean | Static property |
| `computed` | boolean | Computed name |
| `readonly` | boolean | Readonly property (TS) |
| `abstract` | boolean | Abstract property (TS) |
| `declare` | boolean | Ambient declaration |
| `decorators` | Decorator[] | Property decorators |

**Semantic Relations:**
- Creates → `VARIABLE` node (class field)
- `CLASS` -[HAS_PROPERTY]→ `VARIABLE`
- If `value`: `VARIABLE` -[ASSIGNED_FROM]→ value expression

### StaticBlock
| Attribute | Type | Description |
|-----------|------|-------------|
| `body` | Statement[] | Static initializer statements |

**Semantic Relations:**
- Creates → `SCOPE` (static initialization scope)
- `CLASS` -[CONTAINS]→ `SCOPE`

---

## 3. Functions & Parameters

### FunctionExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | Identifier? | Optional function name |
| `params` | Pattern[] | Parameters |
| `body` | BlockStatement | Function body |
| `generator` | boolean | Generator function |
| `async` | boolean | Async function |
| `returnType` | TypeAnnotation? | Return type |
| `typeParameters` | TypeParameterDeclaration? | Generic params |

**Semantic Relations:**
- Creates → `FUNCTION` node (anonymous or named)
- Same as FunctionDeclaration

### ArrowFunctionExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `params` | Pattern[] | Parameters |
| `body` | BlockStatement \| Expression | Function body |
| `async` | boolean | Async function |
| `expression` | boolean | Body is expression |
| `generator` | false | Never a generator |

**Semantic Relations:**
- Creates → `FUNCTION` node (arrow)
- `FUNCTION` -[CAPTURES]→ variables from enclosing scope (lexical this)
- `FUNCTION` -[RECEIVES_ARGUMENT]→ each `PARAMETER`

### Parameter Patterns

#### Identifier (as parameter)
| Attribute | Type | Description |
|-----------|------|-------------|
| `name` | string | Parameter name |
| `typeAnnotation` | TypeAnnotation? | Type annotation |
| `optional` | boolean | Optional parameter (TS) |

**Semantic Relations:**
- Creates → `PARAMETER` node
- `FUNCTION` -[RECEIVES_ARGUMENT]→ `PARAMETER`

#### RestElement
| Attribute | Type | Description |
|-----------|------|-------------|
| `argument` | Pattern | Rest parameter pattern |
| `typeAnnotation` | TypeAnnotation? | Type annotation |

**Semantic Relations:**
- Creates → `PARAMETER` node (rest)
- `PARAMETER` -[FLOWS_INTO]→ array containing rest args

#### AssignmentPattern
| Attribute | Type | Description |
|-----------|------|-------------|
| `left` | Pattern | Parameter pattern |
| `right` | Expression | Default value |

**Semantic Relations:**
- `PARAMETER` -[ASSIGNED_FROM]→ default value (conditional)

#### ObjectPattern
| Attribute | Type | Description |
|-----------|------|-------------|
| `properties` | (ObjectProperty \| RestElement)[] | Destructured properties |
| `typeAnnotation` | TypeAnnotation? | Type annotation |

**Semantic Relations:**
- Each property creates → `VARIABLE` or `PARAMETER`
- `VARIABLE` -[DERIVES_FROM]→ source object
- `VARIABLE` -[READS_FROM]→ specific property

#### ArrayPattern
| Attribute | Type | Description |
|-----------|------|-------------|
| `elements` | (Pattern \| null)[] | Destructured elements |
| `typeAnnotation` | TypeAnnotation? | Type annotation |

**Semantic Relations:**
- Each element creates → `VARIABLE` or `PARAMETER`
- `VARIABLE` -[DERIVES_FROM]→ source array
- `VARIABLE` -[READS_FROM]→ specific index

---

## 4. Expressions

### CallExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `callee` | Expression | Function being called |
| `arguments` | (Expression \| SpreadElement)[] | Arguments |
| `typeArguments` | TSTypeParameterInstantiation? | Type arguments |

**Semantic Relations:**
- Creates → `CALL` node
- `CALL` -[CALLS]→ callee `FUNCTION`
- `CALL` -[PASSES_ARGUMENT]→ each argument
- If callback in args: `CALL` -[HAS_CALLBACK]→ callback `FUNCTION`
- If method call: `CALL` -[CALLS]→ `METHOD`

### NewExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `callee` | Expression | Constructor |
| `arguments` | (Expression \| SpreadElement)[] | Arguments |
| `typeArguments` | TSTypeParameterInstantiation? | Type arguments |

**Semantic Relations:**
- Creates → `CALL` node (constructor call)
- `CALL` -[CALLS]→ `CLASS` constructor
- Result -[INSTANCE_OF]→ `CLASS`

### MemberExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `object` | Expression | Object being accessed |
| `property` | Expression \| PrivateName | Property name |
| `computed` | boolean | Bracket notation |

**Semantic Relations:**
- Parent context determines edge:
  - Read: -[READS_FROM]→ property
  - Write: -[WRITES_TO]→ property
- `EXPRESSION` -[ACCESSES]→ object property

### OptionalMemberExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `object` | Expression | Object being accessed |
| `property` | Expression | Property name |
| `computed` | boolean | Bracket notation |
| `optional` | boolean | Has `?.` |

**Semantic Relations:**
- Same as MemberExpression (optional chain)

### OptionalCallExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `callee` | Expression | Function being called |
| `arguments` | (Expression \| SpreadElement)[] | Arguments |
| `optional` | boolean | Has `?.` |
| `typeArguments` | TSTypeParameterInstantiation? | Type arguments |

**Semantic Relations:**
- Same as CallExpression (optional chain)

### AssignmentExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `operator` | AssignmentOperator | Assignment operator |
| `left` | LVal | Left-hand side |
| `right` | Expression | Right-hand side |

**Semantic Relations:**
- `left` -[ASSIGNED_FROM]→ `right` result
- `left` -[MODIFIES]→ target variable/property
- If compound (`+=`, etc.): also -[READS_FROM]→ `left`

### BinaryExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `operator` | BinaryOperator | Binary operator |
| `left` | Expression | Left operand |
| `right` | Expression | Right operand |

**Operators:** `+`, `-`, `*`, `/`, `%`, `**`, `&`, `|`, `^`, `<<`, `>>`, `>>>`, `==`, `!=`, `===`, `!==`, `<`, `<=`, `>`, `>=`, `in`, `instanceof`, `|>`

**Semantic Relations:**
- Creates → `EXPRESSION` node
- `EXPRESSION` -[DERIVES_FROM]→ both operands

### LogicalExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `operator` | LogicalOperator | Logical operator |
| `left` | Expression | Left operand |
| `right` | Expression | Right operand |

**Operators:** `&&`, `||`, `??`

**Semantic Relations:**
- Creates → `EXPRESSION` node
- `EXPRESSION` -[DERIVES_FROM]→ both operands (short-circuit)

### UnaryExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `operator` | UnaryOperator | Unary operator |
| `argument` | Expression | Operand |
| `prefix` | boolean | Prefix operator |

**Operators:** `-`, `+`, `!`, `~`, `typeof`, `void`, `delete`, `throw`

**Semantic Relations:**
- If `delete`: -[MODIFIES]→ target property
- `EXPRESSION` -[DERIVES_FROM]→ argument

### UpdateExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `operator` | UpdateOperator | Update operator |
| `argument` | Expression | Operand |
| `prefix` | boolean | Prefix operator |

**Operators:** `++`, `--`

**Semantic Relations:**
- `argument` -[MODIFIES]→ target (read + write)
- `argument` -[READS_FROM]→ self
- `argument` -[WRITES_TO]→ self

### ConditionalExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `test` | Expression | Condition |
| `consequent` | Expression | If true |
| `alternate` | Expression | If false |

**Semantic Relations:**
- Result -[DERIVES_FROM]→ consequent OR alternate

### SequenceExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `expressions` | Expression[] | Comma-separated expressions |

**Semantic Relations:**
- Result -[DERIVES_FROM]→ last expression

### YieldExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `argument` | Expression? | Yielded value |
| `delegate` | boolean | yield* delegation |

**Semantic Relations:**
- `FUNCTION` -[RETURNS]→ yielded value (generator)
- If delegate: -[DELEGATES_TO]→ iterable

### AwaitExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `argument` | Expression | Awaited promise |

**Semantic Relations:**
- Result -[DERIVES_FROM]→ resolved promise value

### ThisExpression
No attributes.

**Semantic Relations:**
- -[REFERENCES]→ `this` binding in current scope

### Super
No attributes.

**Semantic Relations:**
- -[REFERENCES]→ parent class

### Import
Dynamic import expression (import()).

**Semantic Relations:**
- Creates → `IMPORT` (dynamic)
- -[IMPORTS_FROM]→ module

### MetaProperty
| Attribute | Type | Description |
|-----------|------|-------------|
| `meta` | Identifier | Meta object (new, import) |
| `property` | Identifier | Property (target, meta) |

**Semantic Relations:**
- `new.target`: -[REFERENCES]→ called constructor
- `import.meta`: -[REFERENCES]→ module metadata

---

## 5. Literals

### StringLiteral
| Attribute | Type | Description |
|-----------|------|-------------|
| `value` | string | String value |

**Semantic Relations:**
- Creates → `LITERAL` node

### NumericLiteral
| Attribute | Type | Description |
|-----------|------|-------------|
| `value` | number | Numeric value |

**Semantic Relations:**
- Creates → `LITERAL` node

### BooleanLiteral
| Attribute | Type | Description |
|-----------|------|-------------|
| `value` | boolean | Boolean value |

**Semantic Relations:**
- Creates → `LITERAL` node

### NullLiteral
No attributes.

**Semantic Relations:**
- Creates → `LITERAL` node

### BigIntLiteral
| Attribute | Type | Description |
|-----------|------|-------------|
| `value` | string | BigInt value as string |

**Semantic Relations:**
- Creates → `LITERAL` node

### RegExpLiteral
| Attribute | Type | Description |
|-----------|------|-------------|
| `pattern` | string | Regex pattern |
| `flags` | string | Regex flags |

**Semantic Relations:**
- Creates → `LITERAL` node

### TemplateLiteral
| Attribute | Type | Description |
|-----------|------|-------------|
| `quasis` | TemplateElement[] | Static parts |
| `expressions` | Expression[] | Dynamic parts |

**Semantic Relations:**
- Result -[DERIVES_FROM]→ each expression
- Creates → `EXPRESSION` node

### TemplateElement
| Attribute | Type | Description |
|-----------|------|-------------|
| `value` | {cooked: string, raw: string} | Template part |
| `tail` | boolean | Is last element |

### TaggedTemplateExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `tag` | Expression | Tag function |
| `quasi` | TemplateLiteral | Template literal |
| `typeArguments` | TSTypeParameterInstantiation? | Type arguments |

**Semantic Relations:**
- Creates → `CALL` node
- `CALL` -[CALLS]→ tag function
- `CALL` -[PASSES_ARGUMENT]→ template parts

---

## 6. Statements

### BlockStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `body` | Statement[] | Statements |
| `directives` | Directive[] | Directives |

**Semantic Relations:**
- Creates → `SCOPE` (block scope for let/const)
- `SCOPE` -[CONTAINS]→ declarations

### ExpressionStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `expression` | Expression | Expression |

**Semantic Relations:**
- Propagates child expression relations

### ReturnStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `argument` | Expression? | Return value |

**Semantic Relations:**
- `FUNCTION` -[RETURNS]→ argument value

### ThrowStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `argument` | Expression | Thrown value |

**Semantic Relations:**
- `FUNCTION` -[THROWS]→ thrown value

### IfStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `test` | Expression | Condition |
| `consequent` | Statement | If true branch |
| `alternate` | Statement? | Else branch |

**Semantic Relations:**
- Control flow branching (no direct graph edge)
- Propagates relations from both branches

### SwitchStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `discriminant` | Expression | Switch value |
| `cases` | SwitchCase[] | Case clauses |

**Semantic Relations:**
- Propagates relations from all cases

### SwitchCase
| Attribute | Type | Description |
|-----------|------|-------------|
| `test` | Expression? | Case value (null = default) |
| `consequent` | Statement[] | Case body |

### ForStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `init` | VariableDeclaration \| Expression? | Initializer |
| `test` | Expression? | Condition |
| `update` | Expression? | Update expression |
| `body` | Statement | Loop body |

**Semantic Relations:**
- Creates → `SCOPE` (for let/const in init)

### ForInStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `left` | VariableDeclaration \| LVal | Iterator variable |
| `right` | Expression | Iterated object |
| `body` | Statement | Loop body |

**Semantic Relations:**
- `left` -[DERIVES_FROM]→ keys of `right`

### ForOfStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `left` | VariableDeclaration \| LVal | Iterator variable |
| `right` | Expression | Iterable |
| `body` | Statement | Loop body |
| `await` | boolean | for await...of |

**Semantic Relations:**
- `left` -[DERIVES_FROM]→ values from `right` iterator

### WhileStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `test` | Expression | Condition |
| `body` | Statement | Loop body |

### DoWhileStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `test` | Expression | Condition |
| `body` | Statement | Loop body |

### TryStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `block` | BlockStatement | Try block |
| `handler` | CatchClause? | Catch clause |
| `finalizer` | BlockStatement? | Finally block |

**Semantic Relations:**
- Exception flow from try to catch

### CatchClause
| Attribute | Type | Description |
|-----------|------|-------------|
| `param` | Pattern? | Error parameter |
| `body` | BlockStatement | Catch body |

**Semantic Relations:**
- Creates → `SCOPE` (catch scope)
- `param` -[RECEIVES]→ thrown error

### BreakStatement / ContinueStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `label` | Identifier? | Jump label |

### LabeledStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `label` | Identifier | Label name |
| `body` | Statement | Labeled statement |

### WithStatement
| Attribute | Type | Description |
|-----------|------|-------------|
| `object` | Expression | Scope object |
| `body` | Statement | Body |

**Semantic Relations:**
- Creates ambiguous scope (avoid in analysis)

### EmptyStatement / DebuggerStatement
No attributes.

---

## 7. Modules (Import/Export)

### ImportDeclaration
| Attribute | Type | Description |
|-----------|------|-------------|
| `specifiers` | ImportSpecifier[] | Import specifiers |
| `source` | StringLiteral | Module path |
| `importKind` | "type" \| "typeof" \| "value" | Import kind |
| `attributes` | ImportAttribute[] | Import attributes |
| `module` | boolean | Module expression (Stage 3) |
| `phase` | "source" \| "defer" | Import phase |

**Semantic Relations:**
- Creates → `IMPORT` node
- `MODULE` -[IMPORTS_FROM]→ source module
- Per specifier: `VARIABLE` -[IMPORTS_FROM]→ exported binding

### ImportSpecifier
| Attribute | Type | Description |
|-----------|------|-------------|
| `imported` | Identifier \| StringLiteral | Imported name |
| `local` | Identifier | Local binding |
| `importKind` | "type" \| "typeof" \| "value" | Import kind |

**Semantic Relations:**
- `local` -[ASSIGNED_FROM]→ `imported` from module

### ImportDefaultSpecifier
| Attribute | Type | Description |
|-----------|------|-------------|
| `local` | Identifier | Local binding |

**Semantic Relations:**
- `local` -[ASSIGNED_FROM]→ default export

### ImportNamespaceSpecifier
| Attribute | Type | Description |
|-----------|------|-------------|
| `local` | Identifier | Local binding |

**Semantic Relations:**
- `local` -[ASSIGNED_FROM]→ module namespace object

### ImportExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `source` | Expression | Module specifier |
| `options` | Expression? | Import options |
| `phase` | "source" \| "defer" | Import phase |

**Semantic Relations:**
- Creates → `IMPORT` (dynamic)
- -[IMPORTS_FROM]→ computed module

### ImportAttribute
| Attribute | Type | Description |
|-----------|------|-------------|
| `key` | Identifier \| StringLiteral | Attribute key |
| `value` | StringLiteral | Attribute value |

### ExportNamedDeclaration
| Attribute | Type | Description |
|-----------|------|-------------|
| `declaration` | Declaration? | Exported declaration |
| `specifiers` | ExportSpecifier[] | Export specifiers |
| `source` | StringLiteral? | Re-export source |
| `exportKind` | "type" \| "value" | Export kind |
| `attributes` | ImportAttribute[] | Export attributes |

**Semantic Relations:**
- Creates → `EXPORT` node
- If declaration: `MODULE` -[EXPORTS]→ declaration
- If re-export: `MODULE` -[IMPORTS_FROM]→ source, then -[EXPORTS]→

### ExportDefaultDeclaration
| Attribute | Type | Description |
|-----------|------|-------------|
| `declaration` | Declaration \| Expression | Default export |
| `exportKind` | "type" \| "value" | Export kind |

**Semantic Relations:**
- Creates → `EXPORT` node (default)
- `MODULE` -[EXPORTS]→ default binding

### ExportAllDeclaration
| Attribute | Type | Description |
|-----------|------|-------------|
| `source` | StringLiteral | Re-export source |
| `exported` | Identifier? | export * as name |
| `exportKind` | "type" \| "value" | Export kind |
| `attributes` | ImportAttribute[] | Export attributes |

**Semantic Relations:**
- `MODULE` -[IMPORTS_FROM]→ source
- `MODULE` -[EXPORTS]→ all source exports

### ExportSpecifier
| Attribute | Type | Description |
|-----------|------|-------------|
| `local` | Identifier | Local name |
| `exported` | Identifier \| StringLiteral | Exported name |
| `exportKind` | "type" \| "value" | Export kind |

### ExportNamespaceSpecifier
| Attribute | Type | Description |
|-----------|------|-------------|
| `exported` | Identifier | Exported namespace name |

### ExportDefaultSpecifier
| Attribute | Type | Description |
|-----------|------|-------------|
| `exported` | Identifier | Exported default name |

---

## 8. Object/Array Literals

### ObjectExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `properties` | (ObjectProperty \| SpreadElement \| ObjectMethod)[] | Properties |

**Semantic Relations:**
- Creates → `OBJECT_LITERAL` or `EXPRESSION`
- -[HAS_PROPERTY]→ each property

### ObjectProperty
| Attribute | Type | Description |
|-----------|------|-------------|
| `key` | Expression | Property key |
| `value` | Expression \| Pattern | Property value |
| `computed` | boolean | Computed key |
| `shorthand` | boolean | Shorthand syntax |
| `decorators` | Decorator[] | Decorators |

**Semantic Relations:**
- Creates property node
- Property -[ASSIGNED_FROM]→ value

### ObjectMethod
| Attribute | Type | Description |
|-----------|------|-------------|
| `kind` | "method" \| "get" \| "set" | Method kind |
| `key` | Expression | Method name |
| `params` | Pattern[] | Parameters |
| `body` | BlockStatement | Method body |
| `computed` | boolean | Computed key |
| `generator` | boolean | Generator method |
| `async` | boolean | Async method |
| `decorators` | Decorator[] | Decorators |
| `returnType` | TypeAnnotation? | Return type |
| `typeParameters` | TypeParameterDeclaration? | Generic params |

**Semantic Relations:**
- Creates → `METHOD` node
- Object -[HAS_PROPERTY]→ `METHOD`

### ArrayExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `elements` | (Expression \| SpreadElement \| null)[] | Array elements |

**Semantic Relations:**
- Creates → `ARRAY_LITERAL` or `EXPRESSION`
- -[HAS_ELEMENT]→ each element
- -[FLOWS_INTO]→ from each element value

### SpreadElement
| Attribute | Type | Description |
|-----------|------|-------------|
| `argument` | Expression | Spread source |

**Semantic Relations:**
- -[DERIVES_FROM]→ source iterable
- Elements -[FLOWS_INTO]→ target array/object

---

## 9. Identifiers & Names

### Identifier
| Attribute | Type | Description |
|-----------|------|-------------|
| `name` | string | Identifier name |
| `typeAnnotation` | TypeAnnotation? | Type annotation |
| `optional` | boolean | Optional (TS) |
| `decorators` | Decorator[] | Decorators |

**Semantic Relations:**
- Context determines relation:
  - Declaration: Creates node, -[DECLARES]→
  - Reference read: -[USES]→ declaration
  - Reference write: -[MODIFIES]→ declaration

### PrivateName
| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | Identifier | Private identifier (#name) |

**Semantic Relations:**
- Same as Identifier (private scope)

---

## 10. TypeScript Declarations

### TSInterfaceDeclaration
| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | Identifier | Interface name |
| `typeParameters` | TSTypeParameterDeclaration? | Generic params |
| `extends` | TSExpressionWithTypeArguments[] | Extended interfaces |
| `body` | TSInterfaceBody | Interface body |
| `declare` | boolean | Ambient declaration |

**Semantic Relations:**
- Creates → `INTERFACE` node
- If `extends`: `INTERFACE` -[EXTENDS]→ parent interfaces
- `MODULE` -[CONTAINS]→ `INTERFACE`

### TSTypeAliasDeclaration
| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | Identifier | Type name |
| `typeParameters` | TSTypeParameterDeclaration? | Generic params |
| `typeAnnotation` | TSType | Type definition |
| `declare` | boolean | Ambient declaration |

**Semantic Relations:**
- Creates → `TYPE` node
- `TYPE` -[DERIVES_FROM]→ referenced types

### TSEnumDeclaration
| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | Identifier | Enum name |
| `body` | TSEnumBody | Enum body |
| `const` | boolean | Const enum |
| `declare` | boolean | Ambient declaration |

**Semantic Relations:**
- Creates → `ENUM` node
- `ENUM` -[HAS_MEMBER]→ each enum member
- `MODULE` -[CONTAINS]→ `ENUM`

### TSEnumMember
| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | Identifier \| StringLiteral | Member name |
| `initializer` | Expression? | Member value |

**Semantic Relations:**
- Creates → `CONSTANT` node
- `ENUM` -[HAS_MEMBER]→ `CONSTANT`

### TSModuleDeclaration
| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | Identifier \| StringLiteral | Module name |
| `body` | TSModuleBlock \| TSModuleDeclaration | Module body |
| `declare` | boolean | Ambient declaration |
| `kind` | "global" \| "module" \| "namespace" | Module kind |

**Semantic Relations:**
- Creates → `MODULE` node (namespace)
- -[CONTAINS]→ all declarations

### TSDeclareFunction
| Attribute | Type | Description |
|-----------|------|-------------|
| `id` | Identifier | Function name |
| `typeParameters` | TSTypeParameterDeclaration? | Generic params |
| `params` | Pattern[] | Parameters |
| `returnType` | TSTypeAnnotation? | Return type |
| `async` | boolean | Async function |
| `declare` | boolean | Ambient declaration |
| `generator` | boolean | Generator |

**Semantic Relations:**
- Creates → `FUNCTION` node (declaration only)
- Same as FunctionDeclaration (no body)

---

## 11. TypeScript Types

### TSTypeReference
| Attribute | Type | Description |
|-----------|------|-------------|
| `typeName` | Identifier \| TSQualifiedName | Type name |
| `typeArguments` | TSTypeParameterInstantiation? | Type arguments |

**Semantic Relations:**
- -[REFERENCES]→ `TYPE` / `INTERFACE` / `CLASS`

### TSFunctionType / TSConstructorType
| Attribute | Type | Description |
|-----------|------|-------------|
| `typeParameters` | TSTypeParameterDeclaration? | Generic params |
| `params` | Pattern[] | Parameters |
| `returnType` | TSTypeAnnotation | Return type |
| `abstract` | boolean | Abstract (constructor only) |

### TSUnionType / TSIntersectionType
| Attribute | Type | Description |
|-----------|------|-------------|
| `types` | TSType[] | Union/intersection members |

**Semantic Relations:**
- `TYPE` -[DERIVES_FROM]→ each member type

### TSArrayType
| Attribute | Type | Description |
|-----------|------|-------------|
| `elementType` | TSType | Element type |

### TSTupleType
| Attribute | Type | Description |
|-----------|------|-------------|
| `elementTypes` | (TSType \| TSNamedTupleMember)[] | Tuple element types |

### TSConditionalType
| Attribute | Type | Description |
|-----------|------|-------------|
| `checkType` | TSType | Check type |
| `extendsType` | TSType | Extends constraint |
| `trueType` | TSType | True branch |
| `falseType` | TSType | False branch |

### TSMappedType
| Attribute | Type | Description |
|-----------|------|-------------|
| `key` | Identifier | Key parameter |
| `constraint` | TSType | Key constraint |
| `nameType` | TSType? | Key remapping |
| `typeAnnotation` | TSType? | Value type |
| `optional` | boolean \| "+" \| "-" | Optional modifier |
| `readonly` | boolean \| "+" \| "-" | Readonly modifier |

### TSTypeLiteral
| Attribute | Type | Description |
|-----------|------|-------------|
| `members` | TSTypeElement[] | Type members |

### TSIndexedAccessType
| Attribute | Type | Description |
|-----------|------|-------------|
| `objectType` | TSType | Object type |
| `indexType` | TSType | Index type |

### TSInferType
| Attribute | Type | Description |
|-----------|------|-------------|
| `typeParameter` | TSTypeParameter | Inferred type param |

### TSTypeOperator
| Attribute | Type | Description |
|-----------|------|-------------|
| `operator` | "keyof" \| "unique" \| "readonly" | Operator |
| `typeAnnotation` | TSType | Target type |

### TSLiteralType
| Attribute | Type | Description |
|-----------|------|-------------|
| `literal` | Literal | Literal value |

### TSTemplateLiteralType
| Attribute | Type | Description |
|-----------|------|-------------|
| `quasis` | TemplateElement[] | Static parts |
| `types` | TSType[] | Dynamic parts |

### Type Keywords
`TSAnyKeyword`, `TSBooleanKeyword`, `TSBigIntKeyword`, `TSNeverKeyword`, `TSNullKeyword`, `TSNumberKeyword`, `TSObjectKeyword`, `TSStringKeyword`, `TSSymbolKeyword`, `TSUndefinedKeyword`, `TSUnknownKeyword`, `TSVoidKeyword`, `TSIntrinsicKeyword`, `TSThisType`

No attributes.

---

## 12. TypeScript Expressions

### TSAsExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `expression` | Expression | Expression |
| `typeAnnotation` | TSType | Type assertion |

**Semantic Relations:**
- -[DERIVES_FROM]→ expression (type cast)

### TSSatisfiesExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `expression` | Expression | Expression |
| `typeAnnotation` | TSType | Constraint type |

### TSTypeAssertion
| Attribute | Type | Description |
|-----------|------|-------------|
| `typeAnnotation` | TSType | Type assertion |
| `expression` | Expression | Expression |

### TSNonNullExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `expression` | Expression | Expression |

**Semantic Relations:**
- -[DERIVES_FROM]→ expression (non-null assertion)

### TSInstantiationExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `expression` | Expression | Expression |
| `typeArguments` | TSTypeParameterInstantiation | Type arguments |

---

## 13. TypeScript Signatures

### TSPropertySignature
| Attribute | Type | Description |
|-----------|------|-------------|
| `key` | Expression | Property key |
| `typeAnnotation` | TSTypeAnnotation? | Property type |
| `computed` | boolean | Computed key |
| `kind` | "get" \| "set" | Accessor kind |
| `optional` | boolean | Optional property |
| `readonly` | boolean | Readonly property |

### TSMethodSignature
| Attribute | Type | Description |
|-----------|------|-------------|
| `key` | Expression | Method name |
| `typeParameters` | TSTypeParameterDeclaration? | Generic params |
| `params` | Pattern[] | Parameters |
| `returnType` | TSTypeAnnotation? | Return type |
| `computed` | boolean | Computed key |
| `kind` | "method" \| "get" \| "set" | Method kind |
| `optional` | boolean | Optional method |

### TSCallSignatureDeclaration
| Attribute | Type | Description |
|-----------|------|-------------|
| `typeParameters` | TSTypeParameterDeclaration? | Generic params |
| `params` | Pattern[] | Parameters |
| `returnType` | TSTypeAnnotation? | Return type |

### TSConstructSignatureDeclaration
| Attribute | Type | Description |
|-----------|------|-------------|
| `typeParameters` | TSTypeParameterDeclaration? | Generic params |
| `params` | Pattern[] | Parameters |
| `returnType` | TSTypeAnnotation? | Return type |

### TSIndexSignature
| Attribute | Type | Description |
|-----------|------|-------------|
| `parameters` | Identifier[] | Index parameters |
| `typeAnnotation` | TSTypeAnnotation? | Value type |
| `readonly` | boolean | Readonly index |
| `static` | boolean | Static index |

---

## 14. TypeScript Parameters

### TSParameterProperty
| Attribute | Type | Description |
|-----------|------|-------------|
| `parameter` | Pattern | Parameter |
| `accessibility` | "public" \| "protected" \| "private" | Access modifier |
| `decorators` | Decorator[] | Decorators |
| `override` | boolean | Override modifier |
| `readonly` | boolean | Readonly modifier |

**Semantic Relations:**
- Creates → `PARAMETER` node
- Also creates → `VARIABLE` (class field)
- `CLASS` -[HAS_PROPERTY]→ `VARIABLE`

### TSTypeParameter
| Attribute | Type | Description |
|-----------|------|-------------|
| `name` | string | Parameter name |
| `constraint` | TSType? | Type constraint |
| `default` | TSType? | Default type |

---

## 15. Decorators

### Decorator
| Attribute | Type | Description |
|-----------|------|-------------|
| `expression` | Expression | Decorator expression |

**Semantic Relations:**
- Creates → `DECORATOR` node
- `DECORATOR` -[DECORATES]→ target (class/method/property)
- `DECORATOR` -[CALLS]→ decorator function

---

## 16. JSX

### JSXElement
| Attribute | Type | Description |
|-----------|------|-------------|
| `openingElement` | JSXOpeningElement | Opening tag |
| `closingElement` | JSXClosingElement? | Closing tag |
| `children` | JSXChild[] | Child elements |

**Semantic Relations:**
- Creates → `EXPRESSION` (JSX element)
- -[CALLS]→ component function/class
- -[PASSES_ARGUMENT]→ props

### JSXOpeningElement
| Attribute | Type | Description |
|-----------|------|-------------|
| `name` | JSXName | Element name |
| `attributes` | JSXAttribute[] | Attributes |
| `selfClosing` | boolean | Self-closing |
| `typeArguments` | TSTypeParameterInstantiation? | Type arguments |

**Semantic Relations:**
- -[REFERENCES]→ component

### JSXClosingElement
| Attribute | Type | Description |
|-----------|------|-------------|
| `name` | JSXName | Element name |

### JSXAttribute
| Attribute | Type | Description |
|-----------|------|-------------|
| `name` | JSXIdentifier \| JSXNamespacedName | Attribute name |
| `value` | JSXValue? | Attribute value |

**Semantic Relations:**
- -[PASSES_ARGUMENT]→ prop value

### JSXSpreadAttribute
| Attribute | Type | Description |
|-----------|------|-------------|
| `argument` | Expression | Spread source |

### JSXExpressionContainer
| Attribute | Type | Description |
|-----------|------|-------------|
| `expression` | Expression \| JSXEmptyExpression | Expression |

### JSXSpreadChild
| Attribute | Type | Description |
|-----------|------|-------------|
| `expression` | Expression | Spread expression |

### JSXFragment
| Attribute | Type | Description |
|-----------|------|-------------|
| `openingFragment` | JSXOpeningFragment | Opening fragment |
| `closingFragment` | JSXClosingFragment | Closing fragment |
| `children` | JSXChild[] | Children |

### JSXText
| Attribute | Type | Description |
|-----------|------|-------------|
| `value` | string | Text content |

### JSXIdentifier
| Attribute | Type | Description |
|-----------|------|-------------|
| `name` | string | Identifier name |

### JSXMemberExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `object` | JSXIdentifier \| JSXMemberExpression | Object |
| `property` | JSXIdentifier | Property |

### JSXNamespacedName
| Attribute | Type | Description |
|-----------|------|-------------|
| `namespace` | JSXIdentifier | Namespace |
| `name` | JSXIdentifier | Name |

### JSXEmptyExpression
No attributes.

### JSXOpeningFragment / JSXClosingFragment
No attributes.

---

## 17. Miscellaneous

### Directive
| Attribute | Type | Description |
|-----------|------|-------------|
| `value` | DirectiveLiteral | Directive value |

### DirectiveLiteral
| Attribute | Type | Description |
|-----------|------|-------------|
| `value` | string | Directive string |

### InterpreterDirective
| Attribute | Type | Description |
|-----------|------|-------------|
| `value` | string | Shebang content |

### ChainExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `expression` | CallExpression \| MemberExpression | Chain expression |

### BindExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `object` | Expression? | Bind object |
| `callee` | Expression | Bound function |

**Semantic Relations:**
- Creates → `FUNCTION` (bound)
- `FUNCTION` -[CAPTURES]→ bound `this`

### DoExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `body` | BlockStatement | Do block |
| `async` | boolean | Async do |

### ModuleExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `body` | Program | Module body |

### PipelineTopicExpression
| Attribute | Type | Description |
|-----------|------|-------------|
| `expression` | Expression | Pipeline expression |

### PipelineBareFunction
| Attribute | Type | Description |
|-----------|------|-------------|
| `callee` | Expression | Pipeline function |

### PipelinePrimaryTopicReference / TopicReference
No attributes.

### Placeholder
| Attribute | Type | Description |
|-----------|------|-------------|
| `expectedNode` | string | Expected node type |
| `name` | Identifier | Placeholder name |

---

## Summary: Node → Edge Mapping

| AST Node Category | Creates Grafema Node | Primary Edges |
|------------------|---------------------|---------------|
| FunctionDeclaration/Expression | `FUNCTION` | RECEIVES_ARGUMENT, RETURNS, HAS_SCOPE, CAPTURES |
| ClassDeclaration/Expression | `CLASS` | EXTENDS, IMPLEMENTS, CONTAINS, HAS_PROPERTY |
| ClassMethod | `METHOD` | RECEIVES_ARGUMENT, RETURNS, CONTAINS |
| VariableDeclaration | `VARIABLE`/`CONSTANT` | DECLARES, ASSIGNED_FROM |
| ImportDeclaration | `IMPORT` | IMPORTS_FROM |
| ExportDeclaration | `EXPORT` | EXPORTS |
| CallExpression | `CALL` | CALLS, PASSES_ARGUMENT, HAS_CALLBACK |
| AssignmentExpression | - | ASSIGNED_FROM, MODIFIES, WRITES_TO |
| MemberExpression | - | READS_FROM, WRITES_TO, ACCESSES |
| Identifier (ref) | - | USES, REFERENCES |
| TSInterfaceDeclaration | `INTERFACE` | EXTENDS, CONTAINS |
| TSTypeAliasDeclaration | `TYPE` | DERIVES_FROM |
| TSEnumDeclaration | `ENUM` | HAS_MEMBER, CONTAINS |
| Decorator | `DECORATOR` | DECORATES, CALLS |
| JSXElement | `EXPRESSION` | CALLS, PASSES_ARGUMENT |

---

## Data Flow Edge Summary

| Edge Type | Source | Target | When Created |
|-----------|--------|--------|--------------|
| `ASSIGNED_FROM` | Variable/Property | Expression result | Assignment, initialization |
| `READS_FROM` | Expression | Variable/Property | Read access |
| `WRITES_TO` | Expression | Variable/Property | Write access |
| `DERIVES_FROM` | Variable | Source expression | Destructuring, computation |
| `FLOWS_INTO` | Value | Container | Array/object element |
| `CAPTURES` | Arrow/Closure | Outer variable | Closure capture |
| `MODIFIES` | Statement | Variable | Mutation |
| `USES` | Reference | Declaration | Identifier reference |

---

## Control Flow (Not Graph Edges)

These AST nodes affect control flow but don't create graph edges:
- IfStatement, SwitchStatement → branching
- ForStatement, WhileStatement, DoWhileStatement → loops
- BreakStatement, ContinueStatement → jumps
- TryStatement, CatchClause → exception handling
- ReturnStatement → function exit
- ThrowStatement → exception throw

Control flow is implicitly represented through code order and function boundaries.

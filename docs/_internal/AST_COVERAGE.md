# AST Node Coverage

> **Note:** This document covers BOTH core (v1 plugins) and core-v2 (declarative walker).
> Status columns show: **v1 | v2**. Where only one status is shown, it applies to both.

This document tracks which JavaScript/TypeScript AST nodes are handled by Grafema's static analyzer.

## Legend

- **Handled** - Creates graph nodes/edges, fully tracked
- **Partial** - Recognized but limited handling
- **Not Handled** - No processing, could be added
- **N/A** - Not relevant for code graph analysis

---

## Declarations

| AST Node | v1 | v2 | Creates (v2) | Notes |
|----------|----|----|--------------|-------|
| `FunctionDeclaration` | Handled | Handled | FUNCTION + PARAMETER nodes | Params, scope, HAS_BODY, RECEIVES_ARGUMENT, SHADOWS |
| `ClassDeclaration` | Handled | Handled | CLASS node | EXTENDS (deferred), IMPLEMENTS, scope, SHADOWS |
| `ClassExpression` | Partial | Handled | CLASS node | Same as ClassDeclaration in v2 |
| `ClassMethod` | Handled | Handled | METHOD/GETTER/SETTER node | Getter/setter distinction (REG-293), RECEIVES_ARGUMENT |
| `ClassPrivateMethod` | Not Handled | Handled | METHOD/GETTER/SETTER node | #privateMethods, getter/setter, ACCESSES_PRIVATE |
| `ClassProperty` | Handled | Handled | PROPERTY node | Static metadata |
| `ClassPrivateProperty` | Not Handled | Handled | PROPERTY node | #privateFields (REG-292), ACCESSES_PRIVATE |
| `ClassAccessorProperty` | Not Handled | Handled | PROPERTY node | Delegates to ClassProperty visitor |
| `StaticBlock` | Not Handled | Handled | STATIC_BLOCK node | REG-291, scope push |
| `ClassBody` | N/A | Handled | (passthrough) | HAS_MEMBER edges via edge-map |
| `VariableDeclaration` | Handled | Handled | (passthrough) | Container; VariableDeclarators produce nodes |
| `VariableDeclarator` | Handled | Handled | VARIABLE/CONSTANT node | ASSIGNED_FROM, ALIASES, SHADOWS |
| `ImportDeclaration` | Handled | Handled | IMPORT + EXTERNAL + EXTERNAL_MODULE | DEPENDS_ON, IMPORTS, IMPORTS_FROM, ALIASES |
| `ExportNamedDeclaration` | Handled | Handled | EXPORT node | Re-exports, specifiers, declaration exports |
| `ExportDefaultDeclaration` | Handled | Handled | EXPORT node | Default exports |
| `ExportAllDeclaration` | Partial | Handled | EXPORT + EXTERNAL_MODULE | `export * from '...'`, IMPORTS_FROM |

## Expressions

| AST Node | v1 | v2 | Creates (v2) | Notes |
|----------|----|----|--------------|-------|
| `CallExpression` | Handled | Handled | CALL node | CALLS, CALLS_ON, CHAINS_FROM, PASSES_ARGUMENT, BINDS_THIS_TO, FLOWS_INTO, ELEMENT_OF, KEY_OF, INVOKES, LISTENS_TO, MERGES_WITH |
| `NewExpression` | Handled | Handled | CALL node (isNew) | Constructor calls, PASSES_ARGUMENT via edge-map |
| `MemberExpression` | Partial | Handled | PROPERTY_ACCESS node | CHAINS_FROM for chaining, ACCESSES_PRIVATE for #fields |
| `OptionalMemberExpression` | Not Handled | Handled | PROPERTY_ACCESS node | Delegates to MemberExpression visitor |
| `OptionalCallExpression` | Not Handled | Handled | CALL node | Delegates to CallExpression visitor |
| `ArrowFunctionExpression` | Handled | Handled | FUNCTION node | PARAMETER nodes, RECEIVES_ARGUMENT, HAS_BODY, RETURNS via edge-map |
| `FunctionExpression` | Handled | Handled | FUNCTION node | Same as ArrowFunctionExpression |
| `AssignmentExpression` | Handled | Handled | EXPRESSION node | WRITES_TO (deferred), ASSIGNED_FROM via edge-map |
| `UpdateExpression` | Handled | Handled | EXPRESSION node | MODIFIES (deferred) |
| `AwaitExpression` | Partial | Handled | EXPRESSION node | AWAITS edge (deferred + edge-map) |
| `YieldExpression` | Partial | Handled | EXPRESSION node | YIELDS edge, DELEGATES_TO for yield* |
| `BinaryExpression` | Not Handled | Handled | EXPRESSION node | Operator in metadata, USES via edge-map |
| `UnaryExpression` | Not Handled | Handled | EXPRESSION node | Operator, DELETES for delete expressions, USES via edge-map |
| `LogicalExpression` | Not Handled | Handled | EXPRESSION node | Delegates to BinaryExpression visitor |
| `ConditionalExpression` | Not Handled | Handled | EXPRESSION node | HAS_CONDITION, HAS_CONSEQUENT, HAS_ALTERNATE via edge-map |
| `SequenceExpression` | Not Handled | Handled | EXPRESSION node | Comma operator |
| `SpreadElement` | Not Handled | Handled | EXPRESSION node | SPREADS_FROM via edge-map |
| `ObjectExpression` | Partial | Handled | LITERAL node | HAS_PROPERTY via edge-map |
| `ArrayExpression` | Not Handled | Handled | LITERAL node | HAS_ELEMENT via edge-map |
| `ObjectProperty` | Not Handled | Handled | PROPERTY_ACCESS node | Object literal key/value |
| `ObjectMethod` | Not Handled | Handled | FUNCTION/GETTER/SETTER node | Getter/setter in objects, RECEIVES_ARGUMENT |
| `TaggedTemplateExpression` | Not Handled | Handled | CALL node | sql\`query\`, CALLS deferred |
| `Identifier` | Partial | Handled | (deferred) | READS_FROM for read contexts, LITERAL for globals (undefined, NaN, Infinity) |
| `ThisExpression` | Handled | Handled | LITERAL node | Used in method calls |
| `ParenthesizedExpression` | N/A | Handled | (passthrough) | Transparent wrapper |

## Statements

| AST Node | v1 | v2 | Creates (v2) | Notes |
|----------|----|----|--------------|-------|
| `IfStatement` | Handled | Handled | BRANCH node | HAS_CONDITION, HAS_CONSEQUENT, HAS_ALTERNATE via edge-map |
| `BlockStatement` | N/A | Handled | BRANCH/FINALLY_BLOCK/SCOPE | Context-dependent: else blocks, finally blocks, standalone scopes |
| `ForStatement` | Handled | Handled | LOOP node | HAS_INIT, HAS_CONDITION, HAS_UPDATE, HAS_BODY via edge-map |
| `ForInStatement` | Partial | Handled | LOOP node | ITERATES_OVER, MODIFIES, DECLARES via edge-map |
| `ForOfStatement` | Partial | Handled | LOOP node | ITERATES_OVER, MODIFIES, await support |
| `WhileStatement` | Handled | Handled | LOOP node | HAS_CONDITION, HAS_BODY via edge-map |
| `DoWhileStatement` | Handled | Handled | LOOP node | HAS_CONDITION, HAS_BODY via edge-map |
| `TryStatement` | Handled | Handled | TRY_BLOCK node | HAS_BODY, HAS_CATCH, HAS_FINALLY via edge-map |
| `CatchClause` | Partial | Handled | CATCH_BLOCK + PARAMETER | CATCHES_FROM, catch param scope |
| `ThrowStatement` | Not Handled | Handled | (deferred) | THROWS edge via edge-map |
| `ReturnStatement` | Handled | Handled | (deferred) | RETURNS edge (enclosing function) |
| `SwitchStatement` | Not Handled | Handled | BRANCH node | HAS_CONDITION, HAS_CASE via edge-map |
| `SwitchCase` | Not Handled | Handled | CASE node | HAS_CONDITION, HAS_BODY via edge-map |
| `BreakStatement` | N/A | Handled | EXPRESSION node | Creates graph node in v2 |
| `ContinueStatement` | N/A | Handled | EXPRESSION node | Creates graph node in v2 |
| `LabeledStatement` | N/A | Handled | LABEL node | Label name tracked |
| `WithStatement` | N/A | Handled | EXPRESSION node | EXTENDS_SCOPE_WITH, with-scope |
| `DebuggerStatement` | N/A | Handled | SIDE_EFFECT node | Debugger presence tracked |
| `ExpressionStatement` | N/A | Handled | (passthrough) | Container |
| `EmptyStatement` | N/A | Handled | (passthrough) | No-op |

## Patterns (Destructuring)

| AST Node | v1 | v2 | Creates (v2) | Notes |
|----------|----|----|--------------|-------|
| `ObjectPattern` | Not Handled | Handled | VARIABLE/PARAMETER nodes | Per-binding nodes, context-aware (param vs var) |
| `ArrayPattern` | Not Handled | Handled | VARIABLE/PARAMETER nodes | Per-element nodes, ELEMENT_OF deferred |
| `RestElement` | Not Handled | Handled | VARIABLE/PARAMETER node | `...rest` in params and destructuring |
| `AssignmentPattern` | Not Handled | Handled | VARIABLE/PARAMETER node | Default values, HAS_DEFAULT via edge-map |

## Literals

| AST Node | v1 | v2 | Creates (v2) | Notes |
|----------|----|----|--------------|-------|
| `StringLiteral` | Handled | Handled | LITERAL node | Value + valueType metadata |
| `NumericLiteral` | Handled | Handled | LITERAL node | Value + valueType metadata |
| `BooleanLiteral` | Handled | Handled | LITERAL node | Value + valueType metadata |
| `NullLiteral` | Partial | Handled | LITERAL node | Fully handled in v2 |
| `BigIntLiteral` | Not Handled | Handled | LITERAL node | BigInt values |
| `RegExpLiteral` | Not Handled | Handled | LITERAL node | Pattern + flags |
| `TemplateLiteral` | Partial | Handled | LITERAL or EXPRESSION | LITERAL for no-expression templates, EXPRESSION for interpolated |
| `TemplateElement` | Not Handled | Handled | LITERAL node | Individual template parts |

## Special

| AST Node | v1 | v2 | Creates (v2) | Notes |
|----------|----|----|--------------|-------|
| `ThisExpression` | Handled | Handled | LITERAL node | `this` keyword |
| `Super` | Not Handled | Handled | (passthrough) | Used by CallExpression/MemberExpression visitors |
| `MetaProperty` | Not Handled | Handled | META_PROPERTY node | `import.meta`, `new.target` |
| `PrivateName` | Not Handled | Handled | (passthrough) | REG-292; used by ClassPrivateMethod/Property, MemberExpression |
| `Decorator` | Not Handled | Handled | DECORATOR node | CALLS deferred, DECORATED_BY via edge-map |

## TypeScript-Specific

| AST Node | v1 | v2 | Creates (v2) | Notes |
|----------|----|----|--------------|-------|
| `TSTypeAnnotation` | Not Handled | Handled | (passthrough) | Transparent wrapper |
| `TSTypeReference` | Not Handled | Handled | TYPE_REFERENCE node | HAS_TYPE, RESOLVES_TO (deferred) |
| `TSInterfaceDeclaration` | Not Handled | Handled | INTERFACE node | EXTENDS (deferred), scope push |
| `TSTypeAliasDeclaration` | Not Handled | Handled | TYPE_ALIAS node | HAS_TYPE_PARAMETER, ASSIGNED_FROM via edge-map |
| `TSEnumDeclaration` | Not Handled | Handled | ENUM node | Enum tracking |
| `TSEnumMember` | Not Handled | Handled | ENUM_MEMBER node | Enum member values |
| `TSModuleDeclaration` | Not Handled | Handled | NAMESPACE node | Namespace/module |
| `TSAsExpression` | Not Handled | Handled | EXPRESSION node | `value as Type`, HAS_TYPE via edge-map |
| `TSSatisfiesExpression` | Not Handled | Handled | EXPRESSION node | `value satisfies Type`, HAS_TYPE via edge-map |
| `TSTypeAssertion` | Not Handled | Handled | EXPRESSION node | `<Type>value` |
| `TSNonNullExpression` | Not Handled | Handled | EXPRESSION node | `value!` |
| `TSTypeParameter` | Not Handled | Handled | TYPE_PARAMETER node | CONSTRAINED_BY, DEFAULTS_TO via edge-map |
| `TSUnionType` | Not Handled | Handled | TYPE_REFERENCE node | UNION_MEMBER via edge-map |
| `TSIntersectionType` | Not Handled | Handled | TYPE_REFERENCE node | INTERSECTS_WITH via edge-map |
| `TSLiteralType` | Not Handled | Handled | LITERAL_TYPE / TYPE_REFERENCE | Template literal types |
| `TSConditionalType` | Not Handled | Handled | CONDITIONAL_TYPE node | HAS_CONDITION, EXTENDS, RETURNS via edge-map |
| `TSInferType` | Not Handled | Handled | INFER_TYPE node | INFERS edge |
| `TSMappedType` | Not Handled | Handled | TYPE_REFERENCE node | ITERATES_OVER, CONTAINS, HAS_TYPE via edge-map |
| `TSTypeLiteral` | Not Handled | Handled | TYPE_REFERENCE node | Object type literals |
| `TSPropertySignature` | Not Handled | Handled | PROPERTY node | Interface/type properties, HAS_TYPE via edge-map |
| `TSMethodSignature` | Not Handled | Handled | METHOD node | Interface methods, RECEIVES_ARGUMENT, RETURNS via edge-map |
| `TSCallSignatureDeclaration` | Not Handled | Handled | METHOD node | Call signatures, RETURNS_TYPE via edge-map |
| `TSConstructSignatureDeclaration` | Not Handled | Handled | METHOD node | Construct signatures, RETURNS_TYPE via edge-map |
| `TSFunctionType` | Not Handled | Handled | PARAMETER nodes | Function type params, RETURNS_TYPE via edge-map |
| `TSConstructorType` | Not Handled | Handled | TYPE_REFERENCE node | Constructor type |
| `TSDeclareFunction` | Not Handled | Handled | FUNCTION node | Overload signatures, RETURNS_TYPE via edge-map |
| `TSDeclareMethod` | Not Handled | Handled | METHOD node | Method overloads |
| `TSParameterProperty` | Not Handled | Handled | PARAMETER + PROPERTY | `constructor(private x)`, DECLARES, HAS_MEMBER |
| `TSIndexSignature` | Not Handled | Handled | PARAMETER nodes | Index signatures `[key: string]` |
| `TSTypePredicate` | Not Handled | Handled | TYPE_REFERENCE node | `x is Type`, `asserts x is Type` |
| `TSTypeOperator` | Not Handled | Handled | TYPE_REFERENCE node | `keyof`, `readonly`, `unique` |
| `TSIndexedAccessType` | Not Handled | Handled | TYPE_REFERENCE node | `Foo['bar']` |
| `TSArrayType` | Not Handled | Handled | TYPE_REFERENCE node | `string[]` |
| `TSTupleType` | Not Handled | Handled | TYPE_REFERENCE node | `[string, number]` |
| `TSTemplateLiteralType` | Not Handled | Handled | TYPE_REFERENCE node | `` `${string}-${number}` `` |
| `TSTypeQuery` | Not Handled | Handled | TYPE_REFERENCE node | `typeof x` |
| TS keyword types | Not Handled | Handled | TYPE_REFERENCE node | string, number, boolean, any, void, never, etc. |

## JSX

| AST Node | v1 | v2 | Notes |
|----------|----|----|-------|
| `JSXElement`, `JSXFragment`, etc. | Not Handled | Handled | Passthrough (no graph nodes yet) |

---

## Currently Handled Node Types (v2)

v2 handles virtually all Babel-parseable AST nodes. This is the comprehensive list of node types that produce graph nodes:

```
Declarations:       FunctionDeclaration   ClassDeclaration    ClassExpression
                    VariableDeclarator    ImportDeclaration   ExportNamedDeclaration
                    ExportDefaultDeclaration                  ExportAllDeclaration

Classes:            ClassMethod           ClassPrivateMethod  ClassProperty
                    ClassPrivateProperty  StaticBlock         ClassAccessorProperty

Expressions:        CallExpression        NewExpression       MemberExpression
                    OptionalMemberExpression                  OptionalCallExpression
                    ArrowFunctionExpression                   FunctionExpression
                    AssignmentExpression   UpdateExpression    BinaryExpression
                    LogicalExpression     UnaryExpression     ConditionalExpression
                    SequenceExpression    SpreadElement        AwaitExpression
                    YieldExpression       TaggedTemplateExpression
                    ObjectExpression      ArrayExpression     ObjectProperty
                    ObjectMethod          ClassExpression

Statements:         IfStatement           ForStatement        ForInStatement
                    ForOfStatement        WhileStatement      DoWhileStatement
                    SwitchStatement       SwitchCase          TryStatement
                    CatchClause           ReturnStatement     ThrowStatement
                    BlockStatement        BreakStatement      ContinueStatement
                    LabeledStatement      WithStatement       DebuggerStatement

Patterns:           ObjectPattern         ArrayPattern        RestElement
                    AssignmentPattern

Literals:           StringLiteral         NumericLiteral      BooleanLiteral
                    NullLiteral           BigIntLiteral       RegExpLiteral
                    TemplateLiteral       TemplateElement

Special:            ThisExpression        Identifier          MetaProperty
                    Decorator

TypeScript:         TSInterfaceDeclaration  TSTypeAliasDeclaration  TSEnumDeclaration
                    TSEnumMember          TSModuleDeclaration     TSTypeReference
                    TSTypeParameter       TSUnionType             TSIntersectionType
                    TSLiteralType         TSConditionalType       TSInferType
                    TSMappedType          TSTypeLiteral           TSPropertySignature
                    TSMethodSignature     TSCallSignatureDeclaration
                    TSConstructSignatureDeclaration               TSFunctionType
                    TSConstructorType     TSDeclareFunction       TSDeclareMethod
                    TSParameterProperty   TSIndexSignature        TSTypePredicate
                    TSTypeOperator        TSIndexedAccessType     TSArrayType
                    TSTupleType           TSTemplateLiteralType   TSTypeQuery
                    TSAsExpression        TSSatisfiesExpression   TSTypeAssertion
                    TSNonNullExpression   TS keyword types (14 types)
```

## Graph Nodes Created

| Node Type | From AST (v1) | From AST (v2) |
|-----------|---------------|---------------|
| FUNCTION | FunctionDeclaration, ArrowFunctionExpression, ClassMethod | FunctionDeclaration, ArrowFunctionExpression, FunctionExpression, ObjectMethod (regular), TSDeclareFunction |
| CLASS | ClassDeclaration | ClassDeclaration, ClassExpression |
| METHOD | ClassMethod | ClassMethod (regular), ClassPrivateMethod (regular), TSMethodSignature, TSCallSignatureDeclaration, TSConstructSignatureDeclaration, TSDeclareMethod |
| GETTER | - | ClassMethod (kind=get), ClassPrivateMethod (kind=get), ObjectMethod (kind=get) |
| SETTER | - | ClassMethod (kind=set), ClassPrivateMethod (kind=set), ObjectMethod (kind=set) |
| VARIABLE | VariableDeclaration | VariableDeclarator, ObjectPattern, ArrayPattern, RestElement, AssignmentPattern |
| CONSTANT | VariableDeclaration (const with literal) | VariableDeclarator (const + literal init) |
| PARAMETER | - | Function params, ObjectPattern/ArrayPattern in param context, RestElement, AssignmentPattern, CatchClause param, TSParameterProperty, TSFunctionType params, TSIndexSignature params |
| PROPERTY | - | ClassProperty, ClassPrivateProperty, TSPropertySignature, TSParameterProperty |
| PROPERTY_ACCESS | - | MemberExpression, OptionalMemberExpression, ObjectProperty |
| CALL | CallExpression, NewExpression | CallExpression, NewExpression, OptionalCallExpression, TaggedTemplateExpression |
| IMPORT | ImportDeclaration | ImportDeclaration |
| EXPORT | ExportDeclaration | ExportNamedDeclaration, ExportDefaultDeclaration, ExportAllDeclaration |
| EXTERNAL | - | ImportDeclaration, ExportNamedDeclaration (re-exports) |
| EXTERNAL_MODULE | - | ImportDeclaration, require/import() calls, ExportAllDeclaration |
| BRANCH | - | IfStatement, SwitchStatement, BlockStatement (else) |
| LOOP | - | ForStatement, ForInStatement, ForOfStatement, WhileStatement, DoWhileStatement |
| CASE | - | SwitchCase |
| SCOPE | IfStatement, ForStatement, WhileStatement, TryStatement | BlockStatement (standalone) |
| TRY_BLOCK | - | TryStatement |
| CATCH_BLOCK | - | CatchClause |
| FINALLY_BLOCK | - | BlockStatement (as TryStatement.finalizer) |
| STATIC_BLOCK | - | StaticBlock |
| LABEL | - | LabeledStatement |
| LITERAL | StringLiteral, NumericLiteral, BooleanLiteral | All literal types + NullLiteral, BigIntLiteral, RegExpLiteral, TemplateLiteral, TemplateElement, ObjectExpression, ArrayExpression, ThisExpression, Identifier (undefined/NaN/Infinity) |
| MODULE | File-level | File-level |
| EXPRESSION | - | AssignmentExpression, UpdateExpression, BinaryExpression, UnaryExpression, LogicalExpression, ConditionalExpression, SequenceExpression, SpreadElement, AwaitExpression, YieldExpression, BreakStatement, ContinueStatement, WithStatement, TSAsExpression, TSSatisfiesExpression, TSTypeAssertion, TSNonNullExpression |
| SIDE_EFFECT | - | ImportDeclaration (no specifiers), DebuggerStatement |
| DECORATOR | - | Decorator |
| META_PROPERTY | - | MetaProperty (import.meta, new.target) |
| INTERFACE | - | TSInterfaceDeclaration |
| TYPE_ALIAS | - | TSTypeAliasDeclaration |
| ENUM | - | TSEnumDeclaration |
| ENUM_MEMBER | - | TSEnumMember |
| NAMESPACE | - | TSModuleDeclaration |
| TYPE_REFERENCE | - | TSTypeReference, TSUnionType, TSIntersectionType, TSTypeLiteral, TSArrayType, TSTupleType, TSTemplateLiteralType, TSTypeQuery, TSTypeOperator, TSIndexedAccessType, TSMappedType, TSConstructorType, TSTypePredicate, TSLiteralType (template), TS keyword types |
| TYPE_PARAMETER | - | TSTypeParameter |
| LITERAL_TYPE | - | TSLiteralType |
| CONDITIONAL_TYPE | - | TSConditionalType |
| INFER_TYPE | - | TSInferType |

## Graph Edges Created

### v1 Edges

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

### v2 Edges: Structural (via edge-map)

These edges are created declaratively by the edge-map when the walk engine visits child nodes:

| Edge Type | From edge-map Key | Purpose |
|-----------|-------------------|---------|
| RETURNS | ReturnStatement.argument, ArrowFunctionExpression.body | Return value flow |
| HAS_BODY | FunctionDeclaration.body, ForStatement.body, WhileStatement.body, etc. | Structural containment |
| HAS_CONDITION | IfStatement.test, ForStatement.test, ConditionalExpression.test, SwitchStatement.discriminant, SwitchCase.test | Condition expressions |
| HAS_CONSEQUENT | IfStatement.consequent, ConditionalExpression.consequent | Then-branch |
| HAS_ALTERNATE | IfStatement.alternate, ConditionalExpression.alternate | Else-branch |
| HAS_INIT | ForStatement.init | Loop initializer |
| HAS_UPDATE | ForStatement.update | Loop update |
| HAS_CASE | SwitchStatement.cases | Switch case branches |
| HAS_CATCH | TryStatement.handler | Catch block |
| HAS_FINALLY | TryStatement.finalizer | Finally block |
| HAS_PROPERTY | ObjectExpression.properties | Object literal properties |
| HAS_ELEMENT | ArrayExpression.elements | Array literal elements |
| HAS_MEMBER | ClassBody.body (srcFrom: enclosingClass) | Class member containment |
| HAS_DEFAULT | AssignmentPattern.right | Default parameter values |
| ITERATES_OVER | ForInStatement.right, ForOfStatement.right, TSMappedType.typeParameter | Loop iteration targets |
| THROWS | ThrowStatement.argument | Throw expressions |
| YIELDS | YieldExpression.argument | Generator yield values |
| AWAITS | AwaitExpression.argument (srcFrom: enclosingFunction) | Async await targets |
| SPREADS_FROM | SpreadElement.argument | Spread source |
| DECORATED_BY | Decorator.expression, Class/Method/Property.decorators | Decorator application |
| EXTENDS | ClassDeclaration.superClass, ClassExpression.superClass, TSConditionalType.extendsType | Inheritance |
| PASSES_ARGUMENT | CallExpression.arguments, NewExpression.arguments, OptionalCallExpression.arguments | Argument passing |
| RECEIVES_ARGUMENT | Function/Method/Arrow.params, ObjectMethod.params | Parameter declaration |
| ASSIGNED_FROM | VariableDeclarator.init, AssignmentExpression.right, TSTypeAliasDeclaration.typeAnnotation | Value assignment |
| USES | BinaryExpression.left/right, LogicalExpression.left/right, UnaryExpression.argument | Operand usage |
| DECLARES | ForInStatement.left, ForOfStatement.left | Loop variable declaration |
| HAS_TYPE | TSAsExpression.typeAnnotation, TSSatisfiesExpression.typeAnnotation, TSMappedType.nameType, TSPropertySignature.typeAnnotation | Type annotation |
| HAS_TYPE_PARAMETER | Function/Class/Interface/TypeAlias.typeParameters | Generic type params |
| RETURNS_TYPE | Function/Method/Arrow.returnType, TSFunctionType/TSConstructSignatureDeclaration/TSDeclareFunction/TSDeclareMethod/TSCallSignatureDeclaration.typeAnnotation | Return type annotation |
| UNION_MEMBER | TSUnionType.types | Union type members |
| INTERSECTS_WITH | TSIntersectionType.types | Intersection type members |
| CONSTRAINED_BY | TSTypeParameter.constraint | Type parameter constraint |
| DEFAULTS_TO | TSTypeParameter.default | Type parameter default |

### v2 Edges: Semantic (via visitor logic)

These edges are created by visitor code, often as deferred scope lookups:

| Edge Type | From Pattern | Purpose |
|-----------|--------------|---------|
| CALLS | CallExpression callee (deferred) | Function call resolution |
| CALLS_ON | obj.method() (deferred) | Method call on object |
| CHAINS_FROM | a.b().c() -> c chains from b | Method chaining |
| WRITES_TO | AssignmentExpression lhs (deferred) | Variable mutation |
| MODIFIES | UpdateExpression argument (deferred), ForInStatement/ForOfStatement loop var | Variable mutation |
| READS_FROM | Identifier in read context (deferred) | Variable reads |
| SHADOWS | Re-declaration in nested scope | Scope shadowing |
| ALIASES | `const y = x`, `import { X as Y }` (deferred) | Alias tracking |
| ELEMENT_OF | Array callback params, arr.pop(), Object.values(), ArrayPattern destructuring | Array element relationship |
| KEY_OF | Object.keys() (deferred) | Object key relationship |
| FLOWS_INTO | arr.push(x), arr.unshift(x) (deferred) | Mutation data flow |
| BINDS_THIS_TO | fn.bind(ctx), arr.filter(cb, ctx) (deferred) | This binding |
| INVOKES | fn.call(ctx), fn.apply(ctx) (deferred) | Indirect invocation |
| LISTENS_TO | addEventListener, on, once (deferred) | Event listener registration |
| MERGES_WITH | Object.assign(target, ...sources) (deferred) | Object merging |
| DELETES | `delete obj.prop` (deferred) | Property deletion |
| DELEGATES_TO | yield* (generator delegation) | Generator delegation |
| ACCESSES_PRIVATE | this.#field (deferred) | Private field access |
| EXTENDS_SCOPE_WITH | with(obj) (deferred) | With statement scope |
| CATCHES_FROM | CatchClause -> TryStatement | Error handling |
| DEPENDS_ON | ImportDeclaration (module -> external) | Module dependency |
| IMPORTS | ImportDeclaration (module -> import specifier) | Module import |
| IMPORTS_FROM | Import/export resolution (deferred) | Cross-module resolution |
| EXPORTS | Export specifier lookup (deferred) | Module export |
| IMPLEMENTS | `class Foo implements Bar` (deferred) | Interface implementation |
| RESOLVES_TO | TSTypeReference scope lookup (deferred) | Type resolution |
| HAS_TYPE | TSTypeReference type resolve (deferred), param type annotations | Type annotation resolution |
| INFERS | TSInferType -> enclosing TSConditionalType | Type inference |
| DECLARES | TSParameterProperty -> PROPERTY | Constructor param property |

---

## Priority Recommendations

### High Priority (Remaining Gaps)

1. **Destructuring in VariableDeclarator** - v2 handles ObjectPattern/ArrayPattern as standalone visitors, but `VariableDeclarator` skips non-Identifier `id` nodes (returns EMPTY_RESULT)
2. **JSX semantic edges** - JSX nodes are passthrough; could create component CALLS, prop HAS_PROPERTY edges
3. **Re-export resolution** - `export * from` barrel files need full re-export graph

### Medium Priority (Enhancements)

4. **Template literal interpolation tracking** - Track data flow through template expressions
5. **Computed property resolution** - `obj[dynamicKey]` creates `<computed>` names; could improve with const propagation
6. **Generator return/iteration protocol** - Track what generators yield vs return

### Low Priority (Nice to Have)

7. **TSImportType** - `import('module').Type` passthrough currently
8. **TSInstantiationExpression** - `fn<Type>` passthrough
9. **Deeper JSX analysis** - Component tree, prop types

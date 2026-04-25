# REG-665: C/C++ Language Support — Full Plan

## JSON AST Node Types (~75 total)

### Declarations (19)
FunctionDecl, VarDecl, ParamDecl, FieldDecl, StructDecl, UnionDecl, ClassDecl, EnumDecl, EnumConstantDecl, TypedefDecl, TypeAliasDecl, Namespace, UsingDirective, UsingDeclaration, MethodDecl, ConstructorDecl, DestructorDecl, ConversionDecl, FriendDecl

### Templates (6)
ClassTemplate, FunctionTemplate, ClassTemplatePartialSpec, TemplateTypeParam, TemplateNonTypeParam, TemplateTemplateParam

### Statements (20)
CompoundStmt, ReturnStmt, IfStmt, ForStmt, WhileStmt, DoStmt, SwitchStmt, CaseStmt, DefaultStmt, BreakStmt, ContinueStmt, GotoStmt, LabelStmt, DeclStmt, RangeForStmt, TryStmt, CatchStmt, NullStmt, CoReturn, CoAwait, CoYield

### Expressions (25)
CallExpr, MemberRefExpr, DeclRefExpr, IntegerLiteral, FloatingLiteral, StringLiteral, CharacterLiteral, BinaryOperator, UnaryOperator, ConditionalOperator, CStyleCast, StaticCast, DynamicCast, ReinterpretCast, ConstCast, NewExpr, DeleteExpr, ThrowExpr, ThisExpr, LambdaExpr, InitListExpr, ArraySubscriptExpr, ParenExpr, GenericSelectionExpr, FoldExpr

### Preprocessor (3)
MacroDefinition, MacroExpansion, IncludeDirective

### Access (2)
AccessSpecifier, BaseSpecifier

## File Extensions
`.c`, `.h`, `.cpp`, `.hpp`, `.cc`, `.cxx`, `.hxx`, `.c++`, `.h++`, `.C`, `.H`, `.hh`, `.inl`, `.ipp`, `.tpp`, `.txx`

## Analyzer Node Types (30)
MODULE, FUNCTION, VARIABLE, CONSTANT, PARAMETER, CLASS, STRUCT, UNION, ENUM, ENUM_MEMBER, INTERFACE, TYPEDEF, NAMESPACE, TEMPLATE, IMPORT, IMPORT_BINDING, EXPORT, CALL, REFERENCE, PROPERTY_ACCESS, EXPRESSION, LITERAL, BRANCH, CASE, LOOP, TRY_BLOCK, CATCH_BLOCK, SCOPE, LAMBDA, MACRO, ATTRIBUTE

## Analyzer Edge Types (26)
CONTAINS, HAS_SCOPE, DECLARES, HAS_PARAMETER, HAS_PROPERTY, HAS_MEMBER, HAS_CONDITION, HAS_CONSEQUENT, HAS_ALTERNATE, HAS_BODY, HAS_INIT, HAS_UPDATE, HAS_CASE, HAS_DEFAULT, HAS_CATCH, ASSIGNED_FROM, READS_FROM, WRITES_TO, RETURNS, THROWS, PASSES_ARGUMENT, ITERATES_OVER, EXTENDS (deferred), CALLS (deferred), INCLUDES (deferred), INSTANTIATES (deferred)

## Scope Types (9)
ModuleScope, FunctionScope, BlockScope, ClassScope, NamespaceScope, TemplateScope, LambdaScope, TryScope, LoopScope

## Semantic ID Format
`file.cpp->TYPE->name[in:parent,h:xxxx]`
- Methods: `file.cpp->FUNCTION->bar[in:MyClass]`
- Constructors: `file.cpp->FUNCTION->MyClass[in:MyClass,h:xxxx]`
- Destructors: `file.cpp->FUNCTION->~MyClass[in:MyClass]`
- Operators: `file.cpp->FUNCTION->operator+[in:MyClass]`
- Namespaced: `file.cpp->CLASS->MyClass[in:ns]`
- Lambdas: `file.cpp->LAMBDA-><lambda>[in:foo,h:xxxx]`

## Deferred Reference Kinds
IncludeResolve, CallResolve, TypeResolve, InheritanceResolve, TemplateResolve

## Resolver Edge Types
IMPORTS_FROM (IMPORT→MODULE), EXTENDS (CLASS→CLASS), IMPLEMENTS (CLASS→CLASS abstract), TYPE_OF (VARIABLE→CLASS), RETURNS (FUNCTION→CLASS), TYPE_ALIAS (TYPEDEF→CLASS), CALLS (CALL→FUNCTION), INSTANTIATES (CALL→CLASS), OVERRIDES (FUNCTION→FUNCTION virtual), DISPATCHES_TO (CALL→FUNCTION each override), INSTANTIATES_TEMPLATE (usage→template def), SPECIALIZES (specialization→primary template)

## Resolver Execution DAG
Phase 0: IncludeResolution, TemplateResolution (independent)
Phase 1: TypeResolution (needs MODULE index from Phase 0)
Phase 2: CallResolution, ConstructorResolution, OperatorResolution (need class hierarchy)
Phase 3: VirtualDispatch (needs hierarchy + call edges)

/**
 * Declarative edge mapping: (parentASTType, childKey) → edgeType.
 *
 * The walk engine uses this to create the correct structural edge type
 * when connecting parent graph nodes to child graph nodes, instead of
 * always using CONTAINS.
 *
 * For most parent-child relationships, CONTAINS is correct.
 * This map overrides specific relationships with semantic edge types.
 */

export interface EdgeMapping {
  edgeType: string;
  /**
   * Where the edge source comes from:
   * - 'parent' (default): the graph node created by the parent visitor
   * - 'enclosingFunction': nearest ancestor FUNCTION/METHOD node
   * - 'enclosingClass': nearest ancestor CLASS node
   * - 'grandparent': the graph node that is the parent of the current parent
   *   (e.g., ObjectExpression → ObjectProperty → value: grandparent = ObjectExpression node)
   */
  srcFrom?: 'parent' | 'enclosingFunction' | 'enclosingClass' | 'grandparent';
}

/**
 * Map of `ASTType.childKey` → EdgeMapping.
 *
 * When the walk engine is about to visit a child at `parentNode[childKey]`,
 * it checks this map. If found, uses the specified edge type.
 * If not found, uses CONTAINS.
 */
export const EDGE_MAP: Record<string, EdgeMapping> = {
  // ─── Return ──────────────────────────────────────────────
  'ReturnStatement.argument':        { edgeType: 'RETURNS', srcFrom: 'enclosingFunction' },
  // Arrow expression body (no explicit return) → RETURNS
  'ArrowFunctionExpression.body':    { edgeType: 'RETURNS' },

  // ─── Function body ─────────────────────────────────────────
  'FunctionDeclaration.body':        { edgeType: 'HAS_BODY' },
  'FunctionExpression.body':         { edgeType: 'HAS_BODY' },

  // ─── If/Else ─────────────────────────────────────────────
  'IfStatement.test':                { edgeType: 'HAS_CONDITION' },
  'IfStatement.consequent':          { edgeType: 'HAS_CONSEQUENT' },
  'IfStatement.alternate':           { edgeType: 'HAS_ALTERNATE' },

  // ─── Loops ───────────────────────────────────────────────
  'ForStatement.init':               { edgeType: 'HAS_INIT' },
  'ForStatement.test':               { edgeType: 'HAS_CONDITION' },
  'ForStatement.update':             { edgeType: 'HAS_UPDATE' },
  'ForStatement.body':               { edgeType: 'HAS_BODY' },
  'ForInStatement.right':            { edgeType: 'ITERATES_OVER' },
  'ForInStatement.body':             { edgeType: 'HAS_BODY' },
  'ForOfStatement.right':            { edgeType: 'ITERATES_OVER' },
  'ForOfStatement.body':             { edgeType: 'HAS_BODY' },
  'WhileStatement.test':             { edgeType: 'HAS_CONDITION' },
  'WhileStatement.body':             { edgeType: 'HAS_BODY' },
  'DoWhileStatement.test':           { edgeType: 'HAS_CONDITION' },
  'DoWhileStatement.body':           { edgeType: 'HAS_BODY' },

  // ─── Switch ──────────────────────────────────────────────
  'SwitchStatement.discriminant':    { edgeType: 'HAS_CONDITION' },
  'SwitchStatement.cases':           { edgeType: 'HAS_CASE' },

  // ─── Try/Catch/Finally ───────────────────────────────────
  'TryStatement.block':              { edgeType: 'HAS_BODY' },
  'TryStatement.handler':            { edgeType: 'HAS_CATCH' },
  'TryStatement.finalizer':          { edgeType: 'HAS_FINALLY' },

  // ─── Throw ───────────────────────────────────────────────
  'ThrowStatement.argument':         { edgeType: 'THROWS' },

  // ─── Yield / Await ───────────────────────────────────────
  'YieldExpression.argument':        { edgeType: 'YIELDS' },
  'AwaitExpression.argument':        { edgeType: 'AWAITS', srcFrom: 'enclosingFunction' },

  // ─── Object / Array ──────────────────────────────────────
  'ObjectExpression.properties':     { edgeType: 'HAS_PROPERTY' },
  'ArrayExpression.elements':        { edgeType: 'HAS_ELEMENT' },

  // ─── Spread ──────────────────────────────────────────────
  'SpreadElement.argument':          { edgeType: 'SPREADS_FROM' },
  'TSRestType.typeAnnotation':       { edgeType: 'SPREADS_FROM' },

  // ─── Conditional ─────────────────────────────────────────
  'ConditionalExpression.test':      { edgeType: 'HAS_CONDITION' },
  'ConditionalExpression.consequent': { edgeType: 'HAS_CONSEQUENT' },
  'ConditionalExpression.alternate': { edgeType: 'HAS_ALTERNATE' },

  // ─── Decorator ───────────────────────────────────────────
  'Decorator.expression':            { edgeType: 'DECORATED_BY' },

  // ─── Class ───────────────────────────────────────────────
  'ClassDeclaration.superClass':     { edgeType: 'EXTENDS' },
  'ClassExpression.superClass':      { edgeType: 'EXTENDS' },

  // ─── Call arguments ─────────────────────────────────────────
  'CallExpression.arguments':        { edgeType: 'PASSES_ARGUMENT' },
  'NewExpression.arguments':         { edgeType: 'PASSES_ARGUMENT' },
  'OptionalCallExpression.arguments': { edgeType: 'PASSES_ARGUMENT' },

  // ─── Variable initializer ─────────────────────────────────
  'VariableDeclarator.init':         { edgeType: 'ASSIGNED_FROM' },

  // ─── Assignment ──────────────────────────────────────────
  'AssignmentExpression.right':      { edgeType: 'ASSIGNED_FROM' },

  // ─── Binary / logical operands ───────────────────────────
  'BinaryExpression.left':           { edgeType: 'USES' },
  'BinaryExpression.right':          { edgeType: 'USES' },
  'LogicalExpression.left':          { edgeType: 'USES' },
  'LogicalExpression.right':         { edgeType: 'USES' },
  'UnaryExpression.argument':        { edgeType: 'USES' },

  // ─── Type parameters ──────────────────────────────────────
  'FunctionDeclaration.typeParameters':    { edgeType: 'HAS_TYPE_PARAMETER' },
  'ArrowFunctionExpression.typeParameters': { edgeType: 'HAS_TYPE_PARAMETER' },
  'FunctionExpression.typeParameters':     { edgeType: 'HAS_TYPE_PARAMETER' },
  'ClassMethod.typeParameters':            { edgeType: 'HAS_TYPE_PARAMETER' },
  'ClassDeclaration.typeParameters':       { edgeType: 'HAS_TYPE_PARAMETER' },
  'ClassExpression.typeParameters':        { edgeType: 'HAS_TYPE_PARAMETER' },
  'TSTypeAliasDeclaration.typeParameters': { edgeType: 'HAS_TYPE_PARAMETER' },
  'TSInterfaceDeclaration.typeParameters': { edgeType: 'HAS_TYPE_PARAMETER' },

  // ─── Type annotations ──────────────────────────────────────
  'FunctionDeclaration.returnType':     { edgeType: 'RETURNS_TYPE' },
  'ArrowFunctionExpression.returnType': { edgeType: 'RETURNS_TYPE' },
  'FunctionExpression.returnType':      { edgeType: 'RETURNS_TYPE' },
  'ClassMethod.returnType':             { edgeType: 'RETURNS_TYPE' },

  // ─── Switch case body ──────────────────────────────────────
  'SwitchCase.test':                 { edgeType: 'HAS_CONDITION' },
  'SwitchCase.consequent':           { edgeType: 'HAS_BODY' },

  // ─── Decorator on class/method ─────────────────────────────
  'ClassDeclaration.decorators':     { edgeType: 'DECORATED_BY' },
  'ClassExpression.decorators':      { edgeType: 'DECORATED_BY' },
  'ClassMethod.decorators':          { edgeType: 'DECORATED_BY' },
  'ClassProperty.decorators':        { edgeType: 'DECORATED_BY' },

  // ─── TS union/intersection members ─────────────────────────
  'TSUnionType.types':               { edgeType: 'UNION_MEMBER' },
  'TSIntersectionType.types':        { edgeType: 'INTERSECTS_WITH' },

  // ─── TS conditional type ───────────────────────────────────
  'TSConditionalType.checkType':     { edgeType: 'HAS_CONDITION' },
  'TSConditionalType.extendsType':   { edgeType: 'EXTENDS' },
  'TSConditionalType.trueType':      { edgeType: 'RETURNS' },
  'TSConditionalType.falseType':     { edgeType: 'RETURNS' },

  // ─── TS mapped type ────────────────────────────────────────
  'TSMappedType.typeParameter':      { edgeType: 'ITERATES_OVER' },
  'TSMappedType.typeAnnotation':     { edgeType: 'CONTAINS' },
  'TSMappedType.nameType':           { edgeType: 'HAS_TYPE' },

  // ─── TS type parameter constraint/default ──────────────────
  'TSTypeParameter.constraint':      { edgeType: 'CONSTRAINED_BY' },
  'TSTypeParameter.default':         { edgeType: 'DEFAULTS_TO' },

  // ─── Default values (AssignmentPattern = destructuring default / param default) ─
  'AssignmentPattern.right':         { edgeType: 'HAS_DEFAULT' },

  // ─── Class body ────────────────────────────────────────────
  'ClassDeclaration.body':           { edgeType: 'HAS_BODY' },
  'ClassExpression.body':            { edgeType: 'HAS_BODY' },
  'ClassBody.body':                  { edgeType: 'HAS_MEMBER', srcFrom: 'enclosingClass' },

  // ─── For loop declarations ────────────────────────────────
  'ForInStatement.left':             { edgeType: 'DECLARES' },
  'ForOfStatement.left':             { edgeType: 'DECLARES' },

  // ─── TS as / satisfies ────────────────────────────────────
  'TSAsExpression.typeAnnotation':   { edgeType: 'HAS_TYPE' },
  'TSSatisfiesExpression.typeAnnotation': { edgeType: 'HAS_TYPE' },

  // ─── TS type alias initializer ──────────────────────────────
  'TSTypeAliasDeclaration.typeAnnotation': { edgeType: 'ASSIGNED_FROM' },

  // ─── TS interface method/property return type ──────────────
  'TSMethodSignature.typeAnnotation':  { edgeType: 'RETURNS' },
  'TSPropertySignature.typeAnnotation': { edgeType: 'HAS_TYPE' },

  // ─── TS function types / declare function ─────────────────
  'TSFunctionType.typeAnnotation':     { edgeType: 'RETURNS_TYPE' },
  'TSConstructSignatureDeclaration.typeAnnotation': { edgeType: 'RETURNS_TYPE' },
  'TSDeclareFunction.returnType':      { edgeType: 'RETURNS_TYPE' },
  'TSDeclareMethod.returnType':        { edgeType: 'RETURNS_TYPE' },

  // ─── TS call signature ────────────────────────────────────
  'TSCallSignatureDeclaration.typeAnnotation': { edgeType: 'RETURNS_TYPE' },

  // ─── Function params ──────────────────────────────────────
  'FunctionDeclaration.params':      { edgeType: 'RECEIVES_ARGUMENT' },
  'FunctionExpression.params':       { edgeType: 'RECEIVES_ARGUMENT' },
  'ArrowFunctionExpression.params':  { edgeType: 'RECEIVES_ARGUMENT' },
  'ClassMethod.params':              { edgeType: 'RECEIVES_ARGUMENT' },
  'ObjectMethod.params':             { edgeType: 'RECEIVES_ARGUMENT' },
};

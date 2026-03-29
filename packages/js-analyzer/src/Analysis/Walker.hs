{-# LANGUAGE OverloadedStrings #-}
-- AST walker: dispatches to Rules by node type
module Analysis.Walker
  ( walkProgram
  , walkNode
  ) where

import Data.Text (Text)
import qualified Data.Map.Strict as Map
import Analysis.Types
import Analysis.Context
import AST.Types

import Rules.Declarations
import Rules.Expressions
import Rules.Statements
import Rules.TypeScript
import Rules.Patterns
import Rules.JSX

-- | Walk the top-level Program node. Entry point for per-file analysis.
walkProgram :: ASTNode -> Analyzer ()
walkProgram node = do
  file <- askFile
  moduleId <- askModuleId

  emitNode GraphNode
    { gnId       = moduleId
    , gnType     = "MODULE"
    , gnName     = file
    , gnFile     = file
    , gnLine     = 1
    , gnColumn   = 0
    , gnEndLine  = 1
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.empty
    }

  let children = getChildren "body" node
  mapM_ (\child -> withAncestor node (walkNode child)) children

-- | Dispatch a single AST node to the appropriate rule.
-- Returns the emitted node's ID (if any) so parents can use it for edges.
-- Every constructor is handled — GHC -Wall ensures exhaustiveness.
walkNode :: ASTNode -> Analyzer (Maybe Text)
walkNode node = case node of
  -- ── Program ─────────────────────────────────────────────
  ProgramNode _ _             -> walkProgram node >> return Nothing

  -- ── Declarations ────────────────────────────────────────
  VariableDeclarationNode _ _ -> ruleVariableDeclaration node
  VariableDeclaratorNode _ _  -> walkChildren' node >> return Nothing
  FunctionDeclarationNode _ _ -> ruleFunctionDeclaration node
  FunctionExpressionNode _ _  -> ruleArrowFunction node
  ClassDeclarationNode _ _    -> ruleClassDeclaration node
  ClassExpressionNode _ _     -> ruleClassDeclaration node
  ClassBodyNode _ _           -> ruleClassBody node
  MethodDefinitionNode _ _    -> ruleMethodDefinition node
  ImportDeclarationNode _ _   -> ruleImportDeclaration node
  ImportSpecifierNode _ _     -> ruleImportSpecifier node
  ImportDefaultSpecifierNode _ _ -> ruleImportDefaultSpecifier node
  ImportNamespaceSpecifierNode _ _ -> ruleImportNamespaceSpecifier node
  ImportAttributeNode _ _     -> return Nothing
  ExportNamedDeclarationNode _ _ -> ruleExportNamedDeclaration node
  ExportDefaultDeclarationNode _ _ -> ruleExportDefaultDeclaration node
  ExportAllDeclarationNode _ _ -> ruleExportAllDeclaration node
  ExportSpecifierNode _ _     -> ruleExportSpecifier node

  -- ── Expressions ─────────────────────────────────────────
  CallExpressionNode _ _      -> ruleCallExpression node
  NewExpressionNode _ _       -> ruleNewExpression node
  MemberExpressionNode _ _    -> ruleMemberExpression node
  AssignmentExpressionNode _ _ -> ruleAssignmentExpression node
  ArrowFunctionExpressionNode _ _ -> ruleArrowFunction node
  IdentifierNode _ _          -> ruleIdentifier node
  LiteralNode _ _             -> ruleLiteral node
  TemplateLiteralNode _ _     -> ruleTemplateLiteral node
  TemplateElementNode _ _     -> return Nothing
  TaggedTemplateExpressionNode _ _ -> ruleTaggedTemplateExpression node
  BinaryExpressionNode _ _    -> ruleBinaryExpression node
  LogicalExpressionNode _ _   -> ruleLogicalExpression node
  UnaryExpressionNode _ _     -> ruleUnaryExpression node
  UpdateExpressionNode _ _    -> ruleUpdateExpression node
  ConditionalExpressionNode _ _ -> ruleConditionalExpression node
  ObjectExpressionNode _ _    -> ruleObjectExpression node
  ArrayExpressionNode _ _     -> ruleArrayExpression node
  SpreadElementNode _ _       -> ruleSpreadElement node
  PropertyNode _ _            -> ruleProperty node
  SequenceExpressionNode _ _  -> ruleSequenceExpression node
  AwaitExpressionNode _ _     -> ruleAwaitExpression node
  YieldExpressionNode _ _     -> ruleYieldExpression node
  ThisExpressionNode _ _      -> ruleThisExpression node
  SuperNode _ _               -> ruleSuperExpression node
  MetaPropertyNode _ _        -> return Nothing
  ChainExpressionNode _ _     -> ruleTransparentWrapper "expression" node
  ParenthesizedExpressionNode _ _ -> ruleTransparentWrapper "expression" node
  ImportExpressionNode _ _    -> ruleImportExpression node
  V8IntrinsicExpressionNode _ _ -> walkChildren' node >> return Nothing

  -- ── Statements ──────────────────────────────────────────
  BlockStatementNode _ _      -> ruleBlockStatement node
  ExpressionStatementNode _ _ -> ruleExpressionStatement node
  ReturnStatementNode _ _     -> ruleReturnStatement node
  ThrowStatementNode _ _      -> ruleThrowStatement node
  IfStatementNode _ _         -> ruleIfStatement node
  SwitchStatementNode _ _     -> ruleSwitchStatement node
  SwitchCaseNode _ _          -> ruleSwitchCase node
  ForStatementNode _ _        -> ruleForStatement node
  ForInStatementNode _ _      -> ruleForInOfStatement node
  ForOfStatementNode _ _      -> ruleForInOfStatement node
  WhileStatementNode _ _      -> ruleWhileStatement node
  DoWhileStatementNode _ _    -> ruleWhileStatement node
  TryStatementNode _ _        -> ruleTryStatement node
  CatchClauseNode _ _         -> ruleCatchClause node
  BreakStatementNode _ _      -> return Nothing
  ContinueStatementNode _ _   -> return Nothing
  LabeledStatementNode _ _    -> do
    -- body is a single Statement, not array — walkChildren' misses it via getChildren
    case getChildrenMaybe "body" node of
      Just body -> withAncestor node (walkNode body) >> return ()
      Nothing   -> return ()
    return Nothing
  WithStatementNode _ _       -> walkChildren' node >> return Nothing
  EmptyStatementNode _ _      -> return Nothing
  DebuggerStatementNode _ _   -> return Nothing
  HashbangNode _ _            -> return Nothing
  StaticBlockNode _ _         -> walkChildren' node >> return Nothing

  -- ── Patterns ────────────────────────────────────────────
  ObjectPatternNode _ _       -> ruleObjectPattern node
  ArrayPatternNode _ _        -> ruleArrayPattern node
  AssignmentPatternNode _ _   -> ruleAssignmentPattern node
  RestElementNode _ _         -> ruleRestElement node

  -- ── TypeScript ──────────────────────────────────────────
  TSInterfaceDeclarationNode _ _ -> ruleTSInterfaceDeclaration node
  TSTypeAliasDeclarationNode _ _ -> ruleTSTypeAliasDeclaration node
  TSEnumDeclarationNode _ _   -> ruleTSEnumDeclaration node
  TSEnumBodyNode _ _          -> walkChildren' node >> return Nothing
  TSEnumMemberNode _ _        -> ruleTSEnumMember node
  TSModuleDeclarationNode _ _ -> ruleTSModuleDeclaration node
  TSModuleBlockNode _ _       -> walkChildren' node >> return Nothing
  TSTypeAnnotationNode _ _    -> ruleTSTypeAnnotation node
  TSTypeReferenceNode _ _     -> ruleTSTypeReference node
  -- type-level, no DFG
  TSTypeParameterDeclarationNode _ _ -> return Nothing
  TSTypeParameterNode _ _     -> return Nothing
  TSTypeParameterInstantiationNode _ _ -> return Nothing
  -- transparent wrappers (expression passes through)
  TSAsExpressionNode _ _      -> ruleTransparentWrapper "expression" node
  TSSatisfiesExpressionNode _ _ -> ruleTransparentWrapper "expression" node
  TSTypeAssertionNode _ _     -> ruleTransparentWrapper "expression" node
  TSNonNullExpressionNode _ _ -> ruleTransparentWrapper "expression" node
  TSInstantiationExpressionNode _ _ -> ruleTransparentWrapper "expression" node
  -- type-level, no DFG
  TSImportEqualsDeclarationNode _ _ -> return Nothing
  TSExportAssignmentNode _ _  -> walkChildren' node >> return Nothing
  TSNamespaceExportDeclarationNode _ _ -> return Nothing
  TSExternalModuleReferenceNode _ _ -> return Nothing
  TSParameterPropertyNode _ _ -> walkChildren' node >> return Nothing
  TSQualifiedNameNode _ _     -> return Nothing
  TSInterfaceHeritageNode _ _ -> return Nothing
  TSInterfaceBodyNode _ _     -> walkChildren' node >> return Nothing
  TSClassImplementsNode _ _   -> return Nothing
  TSPropertySignatureNode _ _ -> ruleTSPropertySignature node
  TSMethodSignatureNode _ _   -> ruleTSMethodSignature node
  -- type-level, no DFG
  TSCallSignatureDeclarationNode _ _ -> return Nothing
  TSConstructSignatureDeclarationNode _ _ -> return Nothing
  TSIndexSignatureNode _ _    -> return Nothing
  TSUnionTypeNode _ _         -> return Nothing
  TSIntersectionTypeNode _ _  -> return Nothing
  TSConditionalTypeNode _ _   -> return Nothing
  TSMappedTypeNode _ _        -> return Nothing
  TSIndexedAccessTypeNode _ _ -> return Nothing
  TSArrayTypeNode _ _         -> return Nothing
  TSTupleTypeNode _ _         -> return Nothing
  TSNamedTupleMemberNode _ _  -> return Nothing
  TSFunctionTypeNode _ _      -> return Nothing
  TSConstructorTypeNode _ _   -> return Nothing
  TSTypeLiteralNode _ _       -> return Nothing
  TSTypePredicateNode _ _     -> return Nothing
  TSTypeOperatorNode _ _      -> return Nothing
  TSTypeQueryNode _ _         -> return Nothing
  TSInferTypeNode _ _         -> return Nothing
  TSImportTypeNode _ _        -> return Nothing
  TSLiteralTypeNode _ _       -> return Nothing
  TSTemplateLiteralTypeNode _ _ -> return Nothing
  TSThisTypeNode _ _          -> return Nothing
  TSAnyKeywordNode _ _        -> return Nothing
  TSStringKeywordNode _ _     -> return Nothing
  TSBooleanKeywordNode _ _    -> return Nothing
  TSNumberKeywordNode _ _     -> return Nothing
  TSObjectKeywordNode _ _     -> return Nothing
  TSBigIntKeywordNode _ _     -> return Nothing
  TSSymbolKeywordNode _ _     -> return Nothing
  TSVoidKeywordNode _ _       -> return Nothing
  TSUndefinedKeywordNode _ _  -> return Nothing
  TSNullKeywordNode _ _       -> return Nothing
  TSNeverKeywordNode _ _      -> return Nothing
  TSUnknownKeywordNode _ _    -> return Nothing
  TSIntrinsicKeywordNode _ _  -> return Nothing
  TSRestTypeNode _ _          -> return Nothing
  TSOptionalTypeNode _ _      -> return Nothing
  TSParenthesizedTypeNode _ _ -> return Nothing
  TSJSDocNonNullableTypeNode _ _ -> return Nothing
  TSJSDocNullableTypeNode _ _ -> return Nothing
  TSJSDocUnknownTypeNode _ _  -> return Nothing
  TSAbstractMethodDefinitionNode _ _ -> ruleMethodDefinition node
  TSAbstractPropertyDefinitionNode _ _ -> walkChildren' node >> return Nothing
  TSAbstractAccessorPropertyNode _ _ -> walkChildren' node >> return Nothing
  TSDeclareFunctionNode _ _   -> ruleFunctionDeclaration node
  TSEmptyBodyFunctionExpressionNode _ _ -> return Nothing

  -- ── JSX ─────────────────────────────────────────────────
  JSXElementNode _ _          -> ruleJSXElement node
  JSXFragmentNode _ _         -> ruleJSXFragment node
  JSXOpeningElementNode _ _   -> ruleJSXOpeningElement node
  JSXClosingElementNode _ _   -> return Nothing
  JSXOpeningFragmentNode _ _  -> return Nothing
  JSXClosingFragmentNode _ _  -> return Nothing
  JSXAttributeNode _ _        -> ruleJSXAttribute node
  JSXSpreadAttributeNode _ _  -> walkChildren' node >> return Nothing
  JSXSpreadChildNode _ _      -> walkChildren' node >> return Nothing
  JSXExpressionContainerNode _ _ -> ruleJSXExpressionContainer node
  JSXEmptyExpressionNode _ _  -> return Nothing
  JSXTextNode _ _             -> return Nothing
  JSXMemberExpressionNode _ _ -> return Nothing
  JSXNamespacedNameNode _ _   -> return Nothing
  JSXIdentifierNode _ _       -> return Nothing

  -- ── Class fields ────────────────────────────────────────
  PropertyDefinitionNode _ _  -> rulePropertyDefinition node
  AccessorPropertyNode _ _    -> walkChildren' node >> return Nothing
  PrivateIdentifierNode _ _   -> return Nothing
  DecoratorNode _ _           -> walkChildren' node >> return Nothing

  -- ── Fallback ────────────────────────────────────────────
  UnknownNode _ _ _           -> return Nothing

-- | Internal: walk all child nodes in well-known array/nullable fields.
walkChildren' :: ASTNode -> Analyzer ()
walkChildren' node = do
  let arrayFields =
        [ "body", "declarations", "properties", "elements", "arguments"
        , "params", "cases", "consequent", "specifiers", "expressions"
        , "children", "attributes", "members", "decorators", "quasis"
        ]
  let singleFields =
        [ "init", "test", "alternate", "left", "right"
        , "object", "property", "callee", "argument", "expression"
        , "key", "value", "id", "superClass", "declaration", "source"
        , "handler", "finalizer", "label", "block", "param"
        , "tag", "quasi", "discriminant", "update", "exported"
        , "local", "imported", "openingElement", "closingElement"
        , "openingFragment", "closingFragment", "returnType"
        ]

  mapM_ (\field -> do
    let children = getChildren field node
    mapM_ (\child -> withAncestor node (walkNode child)) children
    ) arrayFields

  mapM_ (\field ->
    case getChildrenMaybe field node of
      Just child -> withAncestor node (walkNode child) >> return ()
      Nothing    -> return ()
    ) singleFields

{-# LANGUAGE OverloadedStrings #-}
-- | Namespace declarations for C++.
--
-- Handles:
--   * 'Namespace' -> NAMESPACE node
--   * Nested namespaces (C++17 namespace a::b::c) -> nested NAMESPACE nodes
--   * Inline namespaces
--   * Anonymous namespaces
module Rules.Namespaces
  ( walkNamespace
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import CppAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId)
import {-# SOURCE #-} Rules.Declarations (walkDeclaration)
import {-# SOURCE #-} Rules.Statements (walkStmt)
import {-# SOURCE #-} Rules.DataTypes (walkDataType)
import Rules.Imports (walkImport)
import Rules.Templates (walkTemplate)
import Rules.TypeLevel (walkTypeLevel)
import Rules.Preprocessor (walkPreprocessor)
import Rules.Lambdas (walkLambda)
import Rules.ErrorFlow (walkErrorFlow)
import Rules.Attributes (walkAttribute)
import {-# SOURCE #-} Rules.Expressions (walkExpr)

-- ── Namespace walker ──────────────────────────────────────────────────

walkNamespace :: CppNode -> Analyzer ()
walkNamespace node | nodeKind node == "Namespace" = do
  file    <- askFile
  scopeId <- askScopeId

  let name        = maybe "<anonymous>" id (nodeName node)
      line        = nodeLine node
      col         = nodeColumn node
      endLine     = maybe line id (nodeEndLine node)
      endCol      = maybe col id (nodeEndColumn node)
      isInline    = lookupBoolField "isInline" node
      isAnonymous = nodeName node == Nothing

  -- Handle nested namespaces (namespace a::b::c)
  let nsParts = T.splitOn "::" name
  walkNestedNamespaces file scopeId nsParts line col endLine endCol isInline isAnonymous (nodeChildren node)

walkNamespace _ = pure ()

-- | Walk possibly nested namespace parts, creating a NAMESPACE node for each.
walkNestedNamespaces :: Text -> Text -> [Text] -> Int -> Int -> Int -> Int -> Bool -> Bool -> [CppNode] -> Analyzer ()
walkNestedNamespaces _file _parentId [] _ _ _ _ _ _ children =
  mapM_ walkNsChild children
walkNestedNamespaces file parentId [part] line col endLine endCol isInline isAnonymous children = do
  let nodeId = semanticId file "NAMESPACE" part Nothing Nothing

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "NAMESPACE"
    , gnName      = part
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [] ++
        [ ("isInline",    MetaBool True) | isInline ] ++
        [ ("isAnonymous", MetaBool True) | isAnonymous ]
    }

  emitEdge GraphEdge
    { geSource   = parentId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk children in namespace scope
  let nsScope = Scope
        { scopeId           = nodeId
        , scopeKind         = NamespaceScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope nsScope $
    withNamespace part $
      mapM_ walkNsChild children

walkNestedNamespaces file parentId (part:rest) line col endLine endCol isInline _isAnonymous children = do
  let nodeId = semanticId file "NAMESPACE" part Nothing Nothing

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "NAMESPACE"
    , gnName      = part
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [] ++
        [ ("isInline", MetaBool True) | isInline ]
    }

  emitEdge GraphEdge
    { geSource   = parentId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Recurse for nested parts
  let nsScope = Scope
        { scopeId           = nodeId
        , scopeKind         = NamespaceScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope nsScope $
    withNamespace part $
      walkNestedNamespaces file nodeId rest line col endLine endCol False False children

-- | Walk a namespace child node by dispatching on kind.
-- This avoids circular imports with Analysis.Walker.
walkNsChild :: CppNode -> Analyzer ()
walkNsChild child = case nodeKind child of
  -- Declarations
  "FunctionDecl"    -> walkDeclaration child
  "VarDecl"         -> walkDeclaration child
  "ParamDecl"       -> walkDeclaration child
  "MethodDecl"      -> walkDeclaration child
  "ConstructorDecl" -> walkDeclaration child
  "DestructorDecl"  -> walkDeclaration child
  "ConversionDecl"  -> walkDeclaration child
  -- Data types
  "ClassDecl"       -> walkDataType child
  "StructDecl"      -> walkDataType child
  "UnionDecl"       -> walkDataType child
  "EnumDecl"        -> walkDataType child
  "EnumConstantDecl" -> walkDataType child
  "FieldDecl"       -> walkDataType child
  "BaseSpecifier"   -> walkDataType child
  -- Imports
  "IncludeDirective" -> walkImport child
  "UsingDirective"  -> walkImport child
  "UsingDeclaration" -> walkImport child
  -- Namespaces
  "Namespace"       -> walkNamespace child
  -- Templates
  "ClassTemplate"              -> walkTemplate child
  "FunctionTemplate"           -> walkTemplate child
  "ClassTemplatePartialSpec"   -> walkTemplate child
  "TemplateTypeParam"          -> walkTemplate child
  "TemplateNonTypeParam"       -> walkTemplate child
  "TemplateTemplateParam"      -> walkTemplate child
  -- Preprocessor
  "MacroDefinition"  -> walkPreprocessor child
  "MacroExpansion"   -> walkPreprocessor child
  -- Type-level
  "TypedefDecl"      -> walkTypeLevel child
  "TypeAliasDecl"    -> walkTypeLevel child
  -- Attributes
  "Attribute"        -> walkAttribute child
  -- Statements
  "CompoundStmt"     -> walkStmt child
  "IfStmt"           -> walkStmt child
  "ForStmt"          -> walkStmt child
  "WhileStmt"        -> walkStmt child
  "SwitchStmt"       -> walkStmt child
  "ReturnStmt"       -> walkStmt child
  "DeclStmt"         -> walkStmt child
  -- Expressions
  "CallExpr"         -> walkExpr child
  "MemberRefExpr"    -> walkExpr child
  "DeclRefExpr"      -> walkExpr child
  "BinaryOperator"   -> walkExpr child
  "LambdaExpr"       -> walkLambda child
  -- Error flow
  "TryStmt"          -> walkErrorFlow child
  "CatchStmt"        -> walkErrorFlow child
  "ThrowExpr"        -> walkErrorFlow child
  -- Access specifier (handled by class scope)
  "AccessSpecifier"  -> pure ()
  -- Unknown: walk children
  _                  -> mapM_ walkNsChild (nodeChildren child)

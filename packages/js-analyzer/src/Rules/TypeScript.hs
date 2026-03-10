{-# LANGUAGE OverloadedStrings #-}
-- Rules for TypeScript-specific nodes
module Rules.TypeScript
  ( ruleTSInterfaceDeclaration
  , ruleTSTypeAliasDeclaration
  , ruleTSEnumDeclaration
  , ruleTSModuleDeclaration
  , ruleTSTypeReference
  , ruleTSEnumMember
  , ruleTSPropertySignature
  , ruleTSMethodSignature
  , ruleTSTypeAnnotation
  ) where

import Data.Text (Text)
import qualified Data.Map.Strict as Map
import Analysis.Types
import Analysis.Context
import {-# SOURCE #-} Analysis.Walker (walkNode)
import Analysis.Scope (withScope)
import Analysis.SemanticId (semanticId)
import AST.Types
import AST.Span (Span(..))

-- ── TSInterfaceDeclaration ──────────────────────────────────────────────

ruleTSInterfaceDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleTSInterfaceDeclaration node = do
  file <- askFile
  moduleId <- askModuleId
  parent <- askNamedParent
  let sp   = astNodeSpan node
      name = case getChildrenMaybe "id" node of
               Just idNode -> getTextFieldOr "name" "<interface>" idNode
               Nothing     -> "<interface>"
      nodeId = semanticId file "INTERFACE" name parent Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "INTERFACE", gnName = name
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  emitEdge GraphEdge
    { geSource = moduleId, geTarget = nodeId
    , geType = "CONTAINS", geMetadata = Map.empty
    }

  -- Walk body
  case getChildrenMaybe "body" node of
    Just body -> withAncestor node (walkNode body) >> return ()
    Nothing   -> return ()

  return (Just nodeId)

-- ── TSTypeAliasDeclaration ──────────────────────────────────────────────

ruleTSTypeAliasDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleTSTypeAliasDeclaration node = do
  file <- askFile
  moduleId <- askModuleId
  parent <- askNamedParent
  let sp   = astNodeSpan node
      name = case getChildrenMaybe "id" node of
               Just idNode -> getTextFieldOr "name" "<type>" idNode
               Nothing     -> "<type>"
      nodeId = semanticId file "TYPE_ALIAS" name parent Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "TYPE_ALIAS", gnName = name
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  emitEdge GraphEdge
    { geSource = moduleId, geTarget = nodeId
    , geType = "CONTAINS", geMetadata = Map.empty
    }

  return (Just nodeId)

-- ── TSEnumDeclaration ───────────────────────────────────────────────────

ruleTSEnumDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleTSEnumDeclaration node = do
  file <- askFile
  moduleId <- askModuleId
  parent <- askNamedParent
  let sp   = astNodeSpan node
      name = case getChildrenMaybe "id" node of
               Just idNode -> getTextFieldOr "name" "<enum>" idNode
               Nothing     -> "<enum>"
      nodeId = semanticId file "ENUM" name parent Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "ENUM", gnName = name
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  emitEdge GraphEdge
    { geSource = moduleId, geTarget = nodeId
    , geType = "CONTAINS", geMetadata = Map.empty
    }

  -- Walk body/members in class-like scope so members can find parent
  withEnclosingClass nodeId $
    case getChildrenMaybe "body" node of
      Just body -> withAncestor node (walkNode body) >> return ()
      Nothing   -> return ()

  return (Just nodeId)

-- ── TSModuleDeclaration (namespace) ─────────────────────────────────────

ruleTSModuleDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleTSModuleDeclaration node = do
  file <- askFile
  moduleId <- askModuleId
  parent <- askNamedParent
  let sp   = astNodeSpan node
      name = case getChildrenMaybe "id" node of
               Just idNode -> getTextFieldOr "name" "<namespace>" idNode
               Nothing     -> "<namespace>"
      nodeId = semanticId file "NAMESPACE" name parent Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "NAMESPACE", gnName = name
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  emitEdge GraphEdge
    { geSource = moduleId, geTarget = nodeId
    , geType = "CONTAINS", geMetadata = Map.empty
    }

  case getChildrenMaybe "body" node of
    Just body -> withScope ModuleScope nodeId (withAncestor node (walkNode body)) >> return ()
    Nothing   -> return ()

  return (Just nodeId)

-- ── TSTypeReference ─────────────────────────────────────────────────────

ruleTSTypeReference :: ASTNode -> Analyzer (Maybe Text)
ruleTSTypeReference node = do
  file <- askFile
  encFn <- askEnclosingFn
  moduleId <- askModuleId
  let sp   = astNodeSpan node
      name = case getChildrenMaybe "typeName" node of
               Just tn -> getTextFieldOr "name" "<type>" tn
               Nothing -> "<type>"
      fromId = case encFn of
        Just fnId -> fnId
        Nothing   -> moduleId
  curScopeId <- askScopeId
  emitDeferred DeferredRef
    { drKind = TypeResolve, drName = name
    , drFromNodeId = fromId
    , drEdgeType = "REFERS_TO_TYPE"
    , drScopeId = Just curScopeId, drSource = Nothing
    , drFile = file, drLine = spanStart sp, drColumn = 0
    , drReceiver = Nothing, drMetadata = Map.empty
    }
  return Nothing

-- ── TSEnumMember ────────────────────────────────────────────────────────

ruleTSEnumMember :: ASTNode -> Analyzer (Maybe Text)
ruleTSEnumMember node = do
  file <- askFile
  encClass <- askEnclosingClass
  parent <- askNamedParent
  let sp   = astNodeSpan node
      name = case getChildrenMaybe "id" node of
               Just idNode -> getTextFieldOr "name" "<member>" idNode
               Nothing     -> "<member>"
      nodeId = semanticId file "ENUM_MEMBER" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "ENUM_MEMBER", gnName = name
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  case encClass of
    Just enumId -> emitEdge GraphEdge
      { geSource = enumId, geTarget = nodeId
      , geType = "HAS_MEMBER", geMetadata = Map.empty
      }
    Nothing -> return ()
  -- Walk initializer if present
  case getChildrenMaybe "initializer" node of
    Just ini -> withAncestor node (walkNode ini) >> return ()
    Nothing  -> return ()

  return (Just nodeId)

-- ── TSPropertySignature ─────────────────────────────────────────────────

ruleTSPropertySignature :: ASTNode -> Analyzer (Maybe Text)
ruleTSPropertySignature node = do
  file <- askFile
  parent <- askNamedParent
  let sp   = astNodeSpan node
      name = case getChildrenMaybe "key" node of
               Just keyNode -> getTextFieldOr "name" "<prop>" keyNode
               Nothing      -> "<prop>"
      nodeId = semanticId file "PROPERTY_SIGNATURE" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "PROPERTY_SIGNATURE", gnName = name
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  -- Walk type annotation if present
  case getChildrenMaybe "typeAnnotation" node of
    Just ta -> withAncestor node (walkNode ta) >> return ()
    Nothing -> return ()

  return (Just nodeId)

-- ── TSMethodSignature ───────────────────────────────────────────────────

ruleTSMethodSignature :: ASTNode -> Analyzer (Maybe Text)
ruleTSMethodSignature node = do
  file <- askFile
  parent <- askNamedParent
  let sp   = astNodeSpan node
      name = case getChildrenMaybe "key" node of
               Just keyNode -> getTextFieldOr "name" "<method>" keyNode
               Nothing      -> "<method>"
      nodeId = semanticId file "METHOD_SIGNATURE" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "METHOD_SIGNATURE", gnName = name
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  -- Walk params
  let params = getChildren "params" node
  mapM_ (\p -> withAncestor node (walkNode p) >> return ()) params
  -- Walk return type
  case getChildrenMaybe "returnType" node of
    Just rt -> withAncestor node (walkNode rt) >> return ()
    Nothing -> return ()

  return (Just nodeId)

-- ── TSTypeAnnotation ────────────────────────────────────────────────────

ruleTSTypeAnnotation :: ASTNode -> Analyzer (Maybe Text)
ruleTSTypeAnnotation node = do
  case getChildrenMaybe "typeAnnotation" node of
    Just ta -> withAncestor node (walkNode ta) >> return ()
    Nothing -> return ()
  return Nothing

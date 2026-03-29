{-# LANGUAGE OverloadedStrings #-}
-- | Type-level declarations: typedef and type alias.
--
-- Handles:
--   * 'TypedefDecl'    -> TYPEDEF node with underlyingType metadata
--   * 'TypeAliasDecl'  -> TYPEDEF node (using X = Y)
--
-- Both emit deferred TypeResolve for the underlying type.
module Rules.TypeLevel
  ( walkTypeLevel
  ) where

import qualified Data.Map.Strict as Map

import CppAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId)

-- ── Type-level walker ─────────────────────────────────────────────────

walkTypeLevel :: CppNode -> Analyzer ()

-- typedef old_type new_name;
walkTypeLevel node | nodeKind node == "TypedefDecl" = do
  file    <- askFile
  scopeId <- askScopeId

  let name           = maybe "<typedef>" id (nodeName node)
      line           = nodeLine node
      col            = nodeColumn node
      endLine        = maybe line id (nodeEndLine node)
      endCol         = maybe col id (nodeEndColumn node)
      nodeId         = semanticId file "TYPEDEF" name Nothing Nothing
      underlyingType = lookupTextField "underlyingType" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "TYPEDEF"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind", MetaText "typedef")
        ] ++
        [ ("underlyingType", MetaText ut) | Just ut <- [underlyingType] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred type resolution
  case underlyingType of
    Just ut ->
      emitDeferred DeferredRef
        { drKind       = TypeResolve
        , drName       = ut
        , drFromNodeId = nodeId
        , drEdgeType   = "TYPE_ALIAS_OF"
        , drScopeId    = Nothing
        , drSource     = Nothing
        , drFile       = file
        , drLine       = line
        , drColumn     = col
        , drReceiver   = Nothing
        , drMetadata   = Map.empty
        }
    Nothing -> pure ()

-- using new_name = old_type;
walkTypeLevel node | nodeKind node == "TypeAliasDecl" = do
  file    <- askFile
  scopeId <- askScopeId

  let name           = maybe "<alias>" id (nodeName node)
      line           = nodeLine node
      col            = nodeColumn node
      endLine        = maybe line id (nodeEndLine node)
      endCol         = maybe col id (nodeEndColumn node)
      nodeId         = semanticId file "TYPEDEF" name Nothing Nothing
      underlyingType = lookupTextField "underlyingType" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "TYPEDEF"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind", MetaText "type_alias")
        ] ++
        [ ("underlyingType", MetaText ut) | Just ut <- [underlyingType] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred type resolution
  case underlyingType of
    Just ut ->
      emitDeferred DeferredRef
        { drKind       = TypeResolve
        , drName       = ut
        , drFromNodeId = nodeId
        , drEdgeType   = "TYPE_ALIAS_OF"
        , drScopeId    = Nothing
        , drSource     = Nothing
        , drFile       = file
        , drLine       = line
        , drColumn     = col
        , drReceiver   = Nothing
        , drMetadata   = Map.empty
        }
    Nothing -> pure ()

-- Fallback
walkTypeLevel _ = pure ()

{-# LANGUAGE OverloadedStrings #-}
-- | Template declarations for C++.
--
-- Handles:
--   * 'ClassTemplate'                -> TEMPLATE node wrapping CLASS
--   * 'FunctionTemplate'             -> TEMPLATE node wrapping FUNCTION
--   * 'ClassTemplatePartialSpec'     -> TEMPLATE node (kind=partial_specialization)
--   * 'TemplateTypeParam'            -> metadata on parent TEMPLATE
--   * 'TemplateNonTypeParam'         -> metadata on parent TEMPLATE
--   * 'TemplateTemplateParam'        -> metadata on parent TEMPLATE
module Rules.Templates
  ( walkTemplate
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import CppAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)
import {-# SOURCE #-} Rules.Declarations (walkDeclaration)
import {-# SOURCE #-} Rules.DataTypes (walkDataType)

-- ── Helpers ────────────────────────────────────────────────────────────

posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- ── Template walker ───────────────────────────────────────────────────

walkTemplate :: CppNode -> Analyzer ()

-- Class template
walkTemplate node | nodeKind node == "ClassTemplate" = do
  file    <- askFile
  scopeId <- askScopeId

  let name    = maybe "<template>" id (nodeName node)
      line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      nodeId  = semanticId file "TEMPLATE" name Nothing Nothing

      -- Extract template parameter names
      tparams   = lookupNodesField "templateParams" node
      paramNames = [ maybe "<param>" id (nodeName p) | p <- tparams ]
      paramKinds = [ nodeKind p | p <- tparams ]

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "TEMPLATE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind",        MetaText "class_template")
        , ("paramCount",  MetaInt (length tparams))
        , ("paramNames",  MetaList (map MetaText paramNames))
        , ("paramKinds",  MetaList (map MetaText paramKinds))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred resolution for template instantiation tracking
  emitDeferred DeferredRef
    { drKind       = TemplateResolve
    , drName       = name
    , drFromNodeId = nodeId
    , drEdgeType   = "INSTANTIATES"
    , drScopeId    = Nothing
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.singleton "templateName" (MetaText name)
    }

  -- Walk the underlying class declaration
  let tmplScope = Scope
        { scopeId           = nodeId
        , scopeKind         = TemplateScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope tmplScope $
    mapM_ walkDataType (lookupNodesField "declaration" node)

  -- Also walk children for the class body
  withScope tmplScope $
    mapM_ walkTemplateChild (nodeChildren node)

-- Function template
walkTemplate node | nodeKind node == "FunctionTemplate" = do
  file    <- askFile
  scopeId <- askScopeId

  let name    = maybe "<template>" id (nodeName node)
      line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      nodeId  = semanticId file "TEMPLATE" name Nothing Nothing

      tparams   = lookupNodesField "templateParams" node
      paramNames = [ maybe "<param>" id (nodeName p) | p <- tparams ]
      paramKinds = [ nodeKind p | p <- tparams ]

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "TEMPLATE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList $
        [ ("kind",        MetaText "function_template")
        , ("paramCount",  MetaInt (length tparams))
        , ("paramNames",  MetaList (map MetaText paramNames))
        , ("paramKinds",  MetaList (map MetaText paramKinds))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred resolution for template instantiation tracking
  emitDeferred DeferredRef
    { drKind       = TemplateResolve
    , drName       = name
    , drFromNodeId = nodeId
    , drEdgeType   = "INSTANTIATES"
    , drScopeId    = Nothing
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.singleton "templateName" (MetaText name)
    }

  -- Walk the underlying function declaration
  let tmplScope = Scope
        { scopeId           = nodeId
        , scopeKind         = TemplateScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope tmplScope $
    mapM_ walkDeclaration (lookupNodesField "declaration" node)

  withScope tmplScope $
    mapM_ walkTemplateChild (nodeChildren node)

-- Partial specialization
walkTemplate node | nodeKind node == "ClassTemplatePartialSpec" = do
  file    <- askFile
  scopeId <- askScopeId

  let name    = maybe "<partial_spec>" id (nodeName node)
      line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      hash    = posHash line col
      nodeId  = semanticId file "TEMPLATE" name Nothing (Just hash)

      tparams   = lookupNodesField "templateParams" node
      paramNames = [ maybe "<param>" id (nodeName p) | p <- tparams ]

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "TEMPLATE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.fromList
        [ ("kind",        MetaText "partial_specialization")
        , ("paramCount",  MetaInt (length tparams))
        , ("paramNames",  MetaList (map MetaText paramNames))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred resolution for template specialization
  emitDeferred DeferredRef
    { drKind       = TemplateResolve
    , drName       = name
    , drFromNodeId = nodeId
    , drEdgeType   = "SPECIALIZES"
    , drScopeId    = Nothing
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.empty
    }

-- Template parameters are handled as metadata on the parent template.
-- If they appear standalone, we just skip them.
walkTemplate node | nodeKind node `elem`
    ["TemplateTypeParam", "TemplateNonTypeParam", "TemplateTemplateParam"] =
  pure ()

-- Fallback
walkTemplate _ = pure ()

-- | Walk a template child node, dispatching to the appropriate handler.
walkTemplateChild :: CppNode -> Analyzer ()
walkTemplateChild child = case nodeKind child of
  "ClassDecl"    -> walkDataType child
  "StructDecl"   -> walkDataType child
  "FunctionDecl" -> walkDeclaration child
  "MethodDecl"   -> walkDeclaration child
  _              -> pure ()

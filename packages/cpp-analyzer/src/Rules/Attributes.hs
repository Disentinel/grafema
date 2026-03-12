{-# LANGUAGE OverloadedStrings #-}
-- | C/C++ attribute handling.
--
-- Handles [[attributes]] and __attribute__:
--   * Emits ATTRIBUTE node with name
--   * Attaches to parent declaration via metadata
module Rules.Attributes
  ( walkAttribute
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import CppAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)

-- ── Helpers ────────────────────────────────────────────────────────────

posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- ── Attribute walker ──────────────────────────────────────────────────

walkAttribute :: CppNode -> Analyzer ()
walkAttribute node | nodeKind node == "Attribute" = do
  file    <- askFile
  scopeId <- askScopeId

  let name    = maybe "<attribute>" id (nodeName node)
      line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      hash    = posHash line col
      nodeId  = semanticId file "ATTRIBUTE" name Nothing (Just hash)

      -- Extract attribute-specific fields
      attrNamespace = lookupTextField "namespace" node
      attrArgs      = lookupTextsField "args" node
      isGnuAttr     = lookupBoolField "isGnuAttribute" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "ATTRIBUTE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [] ++
        [ ("namespace",      MetaText ns) | Just ns <- [attrNamespace] ] ++
        [ ("isGnuAttribute", MetaBool True) | isGnuAttr ] ++
        [ ("args", MetaList (map MetaText attrArgs)) | not (null attrArgs) ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "HAS_ATTRIBUTE"
    , geMetadata = Map.empty
    }

-- Fallback
walkAttribute _ = pure ()

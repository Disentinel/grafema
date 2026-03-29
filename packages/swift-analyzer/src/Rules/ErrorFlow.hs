{-# LANGUAGE OverloadedStrings #-}
-- | Error flow rule for Swift: throw/try/catch error propagation.
--
-- Emits graph nodes for error-flow statements:
--   ThrowStmt                       -> CALL with kind="throw"
--   DoStmt (with non-empty catches) -> SCOPE with kind="try-catch"
module Rules.ErrorFlow (walkErrorFlowStmt) where

import qualified Data.Map.Strict as Map
import qualified Data.Text as T

import SwiftAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)

-- | Position hash for disambiguating nodes at different locations.
posHash :: Int -> Int -> T.Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- | Walk a statement for error flow analysis, emitting CALL (throw) and
-- SCOPE (try-catch) nodes as appropriate.
walkErrorFlowStmt :: SwiftStmt -> Analyzer ()

-- ThrowStmt -> CALL with kind="throw"
walkErrorFlowStmt (ThrowStmt _mExpr sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = posHash line col
      nodeId = semanticId file "CALL" "<throw>" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "CALL", gnName = "<throw>", gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "throw")
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

-- DoStmt with non-empty catch clauses -> SCOPE with kind="try-catch"
walkErrorFlowStmt (DoStmt _body catches sp)
  | not (null catches) = do
      file <- askFile
      scopeId <- askScopeId
      parent <- askNamedParent
      let line = posLine (spanStart sp)
          col  = posCol (spanStart sp)
          hash = posHash line col
          nodeId = semanticId file "SCOPE" "try-catch" parent (Just hash)
      emitNode GraphNode
        { gnId = nodeId, gnType = "SCOPE", gnName = "try-catch", gnFile = file
        , gnLine = line, gnColumn = col
        , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
        , gnExported = False
        , gnMetadata = Map.fromList
            [ ("kind", MetaText "try-catch")
            , ("language", MetaText "swift")
            , ("catchCount", MetaInt (length catches))
            ]
        }
      emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  | otherwise = return ()

-- All other statements -- no error flow nodes
walkErrorFlowStmt _ = return ()

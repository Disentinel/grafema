{-# LANGUAGE OverloadedStrings #-}
-- | Obj-C message expression rules.
--
-- Handles [receiver selector:arg ...] message send expressions,
-- emitting CALL nodes with objc_message kind.
module Rules.Messages (walkMessageExpr) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import ObjcAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)

walkMessageExpr :: ObjcDecl -> Analyzer ()
walkMessageExpr (ObjCMessageExpr _name selector _children sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let sel = case selector of Just s -> s; Nothing -> _name
      lineHint = contentHash [("line", T.pack (show (posLine (spanStart sp))))]
      nodeId = semanticId file "CALL" sel parent (Just lineHint)
  emitNode GraphNode
    { gnId = nodeId, gnType = "CALL", gnName = sel, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList [("kind", MetaText "objc_message"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
walkMessageExpr _ = return ()

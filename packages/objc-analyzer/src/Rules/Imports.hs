{-# LANGUAGE OverloadedStrings #-}
-- | Import rules for Obj-C analysis.
--
-- Handles #import and #include directives, emitting IMPORT nodes.
module Rules.Imports (walkImportDecl) where

import qualified Data.Map.Strict as Map
import ObjcAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId)

walkImportDecl :: ObjcDecl -> Analyzer ()
walkImportDecl (InclusionDirective name sp) = do
  file <- askFile
  moduleId <- askModuleId
  let nodeId = semanticId file "IMPORT" name Nothing Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "IMPORT", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList [("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = moduleId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
walkImportDecl _ = return ()

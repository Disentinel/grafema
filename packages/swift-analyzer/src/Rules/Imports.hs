{-# LANGUAGE OverloadedStrings #-}
-- | Import declarations rule for Swift.
--
-- Handles Swift import statements:
--   * Regular import (e.g. import Foundation)
--     -> IMPORT node
--   * Scoped import (e.g. import class UIKit.UIViewController)
--     -> IMPORT node with importKind metadata
--   * Re-exported import (e.g. @_exported import Module)
--     -> IMPORT node with reExported metadata
module Rules.Imports
  ( walkImport
  ) where

import qualified Data.Map.Strict as Map

import SwiftAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId)

-- | Walk a single Swift import, emitting an IMPORT node.
walkImport :: SwiftImport -> Analyzer ()
walkImport imp = do
  file     <- askFile
  moduleId <- askModuleId
  let name = siName imp
      nodeId = semanticId file "IMPORT" name Nothing Nothing
      line = posLine (spanStart (siSpan imp))
      col  = posCol  (spanStart (siSpan imp))
  emitNode GraphNode
    { gnId = nodeId, gnType = "IMPORT", gnName = name, gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd (siSpan imp))
    , gnEndColumn = posCol (spanEnd (siSpan imp))
    , gnExported = siExported imp
    , gnMetadata = Map.fromList $
        [ ("language", MetaText "swift") ] ++
        [ ("importKind", MetaText k) | Just k <- [siImportKind imp] ] ++
        [ ("reExported", MetaBool True) | siExported imp ]
    }
  emitEdge GraphEdge
    { geSource = moduleId
    , geTarget = nodeId
    , geType = "CONTAINS"
    , geMetadata = Map.empty
    }

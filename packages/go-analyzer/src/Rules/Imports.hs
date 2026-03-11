{-# LANGUAGE OverloadedStrings #-}
-- | Import declarations rule for Go.
--
-- Handles Go import statements, producing IMPORT nodes.
--
-- Handles these Go AST constructs:
--   * Regular import (e.g. @import "fmt"@)
--     -> IMPORT node (path = "fmt")
--   * Aliased import (e.g. @import f "fmt"@)
--     -> IMPORT node (path = "fmt", alias = "f")
--   * Blank import (e.g. @import _ "database/sql"@)
--     -> IMPORT node (path = "database/sql", blank = True)
--   * Dot import (e.g. @import . "fmt"@)
--     -> IMPORT node (path = "fmt", dot = True)
--
-- Node types: IMPORT
-- Edge types: CONTAINS (moduleId -> import)
-- Deferred: IMPORTS_FROM (for cross-file resolution)
--
-- Called from 'Analysis.Walker.walkFile' for each import.
module Rules.Imports
  ( walkImport
  ) where

import qualified Data.Map.Strict as Map

import GoAST
import Analysis.Types
    ( GraphNode(..)
    , GraphEdge(..)
    , MetaValue(..)
    , DeferredRef(..)
    , DeferredKind(..)
    )
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , emitDeferred
    , askFile
    , askModuleId
    )
import Grafema.SemanticId (semanticId)

-- ── Import walker ──────────────────────────────────────────────────────────

-- | Walk a single Go import, emitting an IMPORT node.
walkImport :: GoImport -> Analyzer ()
walkImport imp = do
  file     <- askFile
  moduleId <- askModuleId

  let importPath   = giPath imp
      importName   = giName imp
      alias        = giAlias imp
      isBlank      = giBlank imp
      isDot        = giDot imp
      line         = posLine (spanStart (giSpan imp))
      col          = posCol  (spanStart (giSpan imp))
      importNodeId = semanticId file "IMPORT" importPath Nothing Nothing

  -- Emit IMPORT node
  emitNode GraphNode
    { gnId        = importNodeId
    , gnType      = "IMPORT"
    , gnName      = importPath
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (giSpan imp))
    , gnEndColumn = posCol  (spanEnd (giSpan imp))
    , gnExported  = False  -- imports are never exported
    , gnMetadata  = Map.fromList $
        [ ("path",  MetaText importPath)
        , ("blank", MetaBool isBlank)
        , ("dot",   MetaBool isDot)
        ]
        ++ [ ("alias", MetaText a) | Just a <- [alias] ]
        ++ [ ("local_name", MetaText importName) ]
    }

  -- CONTAINS edge from module scope
  emitEdge GraphEdge
    { geSource   = moduleId
    , geTarget   = importNodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred IMPORTS_FROM for cross-file resolution
  emitDeferred DeferredRef
    { drKind       = ImportResolve
    , drName       = importName
    , drFromNodeId = importNodeId
    , drEdgeType   = "IMPORTS_FROM"
    , drScopeId    = Nothing
    , drSource     = Just importPath
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.fromList $
        [ ("blank", MetaBool isBlank) | isBlank ] ++
        [ ("dot",   MetaBool isDot)   | isDot ]
    }

{-# LANGUAGE OverloadedStrings #-}
-- | Import declarations rule.
--
-- Handles Java import statements, producing IMPORT and IMPORT_BINDING nodes.
--
-- Handles these Java AST constructs:
--   * Regular import (e.g. @import com.example.Foo;@)
--     -> IMPORT node (path) + IMPORT_BINDING node (Foo)
--   * Static import (e.g. @import static com.example.Foo.bar;@)
--     -> IMPORT node (path, static=True) + IMPORT_BINDING
--   * Wildcard import (e.g. @import com.example.*;@)
--     -> IMPORT node (path, glob=True)
--
-- Node types: IMPORT, IMPORT_BINDING
-- Edge types: CONTAINS (scope -> import, import -> binding)
-- Deferred: IMPORTS_FROM (for cross-file resolution)
--
-- Called from 'Analysis.Walker.walkFile' for each import.
module Rules.Imports
  ( walkImports
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import JavaAST
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
    , askScopeId
    )
import Grafema.SemanticId (semanticId)

-- ── Import walker ────────────────────────────────────────────────────────

-- | Walk a single Java import, emitting IMPORT and IMPORT_BINDING nodes.
walkImports :: JavaImport -> Analyzer ()
walkImports imp = do
  file    <- askFile
  scopeId <- askScopeId

  let fullName = jiName imp
      isGlob   = jiAsterisk imp
      isStat   = jiStatic imp
      line     = posLine (spanStart (jiSpan imp))
      col      = posCol  (spanStart (jiSpan imp))

      -- For "com.example.Foo", basePath = "com.example", leafName = "Foo"
      -- For "com.example.*", basePath = "com.example", leafName = "*"
      (basePath, leafName) = splitImportName fullName isGlob

      importNodeId = semanticId file "IMPORT" fullName Nothing Nothing

  -- Emit IMPORT node
  emitNode GraphNode
    { gnId        = importNodeId
    , gnType      = "IMPORT"
    , gnName      = fullName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (jiSpan imp))
    , gnEndColumn = posCol  (spanEnd (jiSpan imp))
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("path",   MetaText fullName)
        , ("glob",   MetaBool isGlob)
        , ("static", MetaBool isStat)
        ]
    }

  -- CONTAINS edge from module scope to IMPORT
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = importNodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- For non-glob imports, emit IMPORT_BINDING
  if isGlob
    then pure ()
    else do
      let bindingNodeId = semanticId file "IMPORT_BINDING" leafName Nothing (Just fullName)

      emitNode GraphNode
        { gnId        = bindingNodeId
        , gnType      = "IMPORT_BINDING"
        , gnName      = leafName
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = posLine (spanEnd (jiSpan imp))
        , gnEndColumn = posCol  (spanEnd (jiSpan imp))
        , gnExported  = False
        , gnMetadata  = Map.fromList
            [ ("imported_name", MetaText leafName)
            , ("local_name",    MetaText leafName)
            , ("static",        MetaBool isStat)
            ]
        }

      -- CONTAINS edge from IMPORT to IMPORT_BINDING
      emitEdge GraphEdge
        { geSource   = importNodeId
        , geTarget   = bindingNodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }

      -- Deferred IMPORTS_FROM for cross-file resolution
      emitDeferred DeferredRef
        { drKind       = ImportResolve
        , drName       = leafName
        , drFromNodeId = bindingNodeId
        , drEdgeType   = "IMPORTS_FROM"
        , drScopeId    = Nothing
        , drSource     = Just basePath
        , drFile       = file
        , drLine       = line
        , drColumn     = col
        , drReceiver   = Nothing
        , drMetadata   = Map.fromList
            [ ("static", MetaBool isStat) | isStat ]
        }

-- ── Helpers ──────────────────────────────────────────────────────────────

-- | Split an import name into base path and leaf name.
-- "com.example.Foo" -> ("com.example", "Foo")
-- "com.example.*"   -> ("com.example", "*")
splitImportName :: Text -> Bool -> (Text, Text)
splitImportName fullName isGlob =
  let segments = T.splitOn "." fullName
  in case segments of
       []  -> (fullName, fullName)
       [x] -> (x, x)
       _   ->
         if isGlob
         then (fullName, "*")
         else (T.intercalate "." (init segments), last segments)

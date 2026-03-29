{-# LANGUAGE OverloadedStrings #-}
-- | Import declarations rule for Kotlin.
--
-- Handles Kotlin import statements:
--   * Regular import (e.g. import com.example.Foo)
--     -> IMPORT node (path) + IMPORT_BINDING node (Foo)
--   * Aliased import (e.g. import com.example.Foo as Bar)
--     -> IMPORT node + IMPORT_BINDING with metadata alias=Bar, imported_name=Foo
--   * Wildcard import (e.g. import com.example.*)
--     -> IMPORT node (path, glob=True)
--
-- Note: Kotlin has no static imports (all imports work the same way).
module Rules.Imports
  ( walkImport
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import KotlinAST
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

-- | Walk a single Kotlin import, emitting IMPORT and IMPORT_BINDING nodes.
walkImport :: KotlinImport -> Analyzer ()
walkImport imp = do
  file    <- askFile
  scopeId <- askScopeId

  let fullName = kiName imp
      isGlob   = kiAsterisk imp
      mAlias   = kiAlias imp
      line     = posLine (spanStart (kiSpan imp))
      col      = posCol  (spanStart (kiSpan imp))

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
    , gnEndLine   = posLine (spanEnd (kiSpan imp))
    , gnEndColumn = posCol  (spanEnd (kiSpan imp))
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("path", MetaText fullName)
        , ("glob", MetaBool isGlob)
        ]
        ++ [ ("alias", MetaText a) | Just a <- [mAlias] ]
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
      let localName = case mAlias of
            Just alias -> alias
            Nothing    -> leafName
          bindingNodeId = semanticId file "IMPORT_BINDING" localName Nothing (Just fullName)

      emitNode GraphNode
        { gnId        = bindingNodeId
        , gnType      = "IMPORT_BINDING"
        , gnName      = localName
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = posLine (spanEnd (kiSpan imp))
        , gnEndColumn = posCol  (spanEnd (kiSpan imp))
        , gnExported  = False
        , gnMetadata  = Map.fromList $
            [ ("imported_name", MetaText leafName)
            , ("local_name",    MetaText localName)
            ]
            ++ [ ("alias", MetaText a) | Just a <- [mAlias] ]
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
        , drMetadata   = Map.empty
        }

-- Helpers

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

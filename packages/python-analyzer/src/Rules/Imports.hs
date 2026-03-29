{-# LANGUAGE OverloadedStrings #-}
-- | Import rule: emits IMPORT and IMPORT_BINDING nodes for
-- Python import/import-from statements.
--
-- Handles these Python AST constructs:
--   * 'ImportStmt'     (import foo, import foo as bar)
--     -> IMPORT node + IMPORT_BINDING node per alias
--   * 'ImportFromStmt' (from foo import bar, from . import baz)
--     -> IMPORT node + IMPORT_BINDING node(s)
--
-- Relative imports are encoded via relative_level metadata.
-- Glob imports (from foo import *) are marked with glob=True.
--
-- Node types: IMPORT, IMPORT_BINDING
-- Edge types: CONTAINS (scope -> import, import -> binding)
-- Deferred: IMPORTS_FROM (for cross-file resolution)
--
-- Called from 'Analysis.Walker.walkFile' for each import statement.
module Rules.Imports
  ( walkImport
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import PythonAST
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
import Grafema.SemanticId (semanticId, contentHash)

-- ── Import walker ────────────────────────────────────────────────────

-- | Walk an import statement and emit IMPORT and IMPORT_BINDING nodes.
walkImport :: PythonStmt -> Analyzer ()

-- import foo / import foo as bar / import foo, bar
walkImport (ImportStmt names sp) = do
  file    <- askFile
  scopeId <- askScopeId

  let line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)

  mapM_ (\alias -> do
    let modName = palName alias
        localName = case palAsname alias of
          Just asn -> asn
          Nothing  -> modName
        importNodeId = semanticId file "IMPORT" modName Nothing Nothing

    -- Emit IMPORT node
    emitNode GraphNode
      { gnId        = importNodeId
      , gnType      = "IMPORT"
      , gnName      = modName
      , gnFile      = file
      , gnLine      = line
      , gnColumn    = col
      , gnEndLine   = posLine (spanEnd sp)
      , gnEndColumn = posCol  (spanEnd sp)
      , gnExported  = False
      , gnMetadata  = Map.fromList
          [ ("path", MetaText modName)
          , ("glob", MetaBool False)
          ]
      }

    -- CONTAINS edge from module scope to IMPORT
    emitEdge GraphEdge
      { geSource   = scopeId
      , geTarget   = importNodeId
      , geType     = "CONTAINS"
      , geMetadata = Map.empty
      }

    -- Emit IMPORT_BINDING node
    let hash = contentHash [("import", modName), ("local", localName)]
        bindingNodeId = semanticId file "IMPORT_BINDING" localName Nothing (Just hash)

    emitNode GraphNode
      { gnId        = bindingNodeId
      , gnType      = "IMPORT_BINDING"
      , gnName      = localName
      , gnFile      = file
      , gnLine      = line
      , gnColumn    = col
      , gnEndLine   = posLine (spanEnd sp)
      , gnEndColumn = posCol  (spanEnd sp)
      , gnExported  = False
      , gnMetadata  = Map.fromList
          [ ("imported_name", MetaText modName)
          , ("local_name",    MetaText localName)
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
      , drName       = localName
      , drFromNodeId = bindingNodeId
      , drEdgeType   = "IMPORTS_FROM"
      , drScopeId    = Nothing
      , drSource     = Just modName
      , drFile       = file
      , drLine       = line
      , drColumn     = col
      , drReceiver   = Nothing
      , drMetadata   = Map.empty
      }
    ) names

-- from foo import bar / from foo import * / from . import bar
walkImport (ImportFromStmt mModule names level sp) = do
  file    <- askFile
  scopeId <- askScopeId

  let line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)

      -- Build the full module path, including relative dots
      modulePart = case mModule of
        Just m  -> m
        Nothing -> ""
      dots = T.replicate level "."
      fullPath = if T.null modulePart
                 then dots
                 else dots <> modulePart

      -- Detect glob import (from foo import *)
      isGlob = case names of
        [alias] -> palName alias == "*"
        _       -> False

      importNodeId = semanticId file "IMPORT" fullPath Nothing Nothing

  -- Emit IMPORT node
  emitNode GraphNode
    { gnId        = importNodeId
    , gnType      = "IMPORT"
    , gnName      = fullPath
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("path",           MetaText fullPath)
        , ("glob",           MetaBool isGlob)
        , ("relative_level", MetaInt level)
        ]
        ++ if T.null modulePart
           then []
           else [("module", MetaText modulePart)]
    }

  -- CONTAINS edge from scope to IMPORT
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = importNodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- For non-glob imports, emit IMPORT_BINDING for each name
  if isGlob
    then pure ()
    else mapM_ (\alias -> do
      let importedName = palName alias
          localName = case palAsname alias of
            Just asn -> asn
            Nothing  -> importedName
          hash = contentHash
            [ ("import", fullPath)
            , ("name", importedName)
            , ("local", localName)
            ]
          bindingNodeId = semanticId file "IMPORT_BINDING" localName Nothing (Just hash)

      emitNode GraphNode
        { gnId        = bindingNodeId
        , gnType      = "IMPORT_BINDING"
        , gnName      = localName
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = posLine (spanEnd sp)
        , gnEndColumn = posCol  (spanEnd sp)
        , gnExported  = False
        , gnMetadata  = Map.fromList
            [ ("imported_name", MetaText importedName)
            , ("local_name",    MetaText localName)
            , ("source_module", MetaText fullPath)
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
        , drName       = localName
        , drFromNodeId = bindingNodeId
        , drEdgeType   = "IMPORTS_FROM"
        , drScopeId    = Nothing
        , drSource     = Just fullPath
        , drFile       = file
        , drLine       = line
        , drColumn     = col
        , drReceiver   = Nothing
        , drMetadata   = Map.fromList $
            [ ("imported_name", MetaText importedName) | importedName /= localName ]
            ++ [ ("relative_level", MetaInt level) | level > 0 ]
        }
      ) names

-- Other statements are not imports — ignore
walkImport _ = pure ()

{-# LANGUAGE OverloadedStrings #-}
-- | Phase 6 rule: import declarations (use statements).
--
-- Handles Rust @use@ declarations by flattening use trees into IMPORT and
-- IMPORT_BINDING nodes.
--
-- Handles these Rust AST constructs:
--   * 'ItemUse' with 'UsePath'   -> path segment leading to subtree
--   * 'ItemUse' with 'UseName'   -> simple import (e.g. @use std::io;@)
--   * 'ItemUse' with 'UseRename' -> renamed import (e.g. @use std::io::Read as IoRead;@)
--   * 'ItemUse' with 'UseGlob'   -> glob import (e.g. @use std::io::*;@)
--   * 'ItemUse' with 'UseGroup'  -> grouped import (e.g. @use std::io::{Read, Write};@)
--
-- Node types: IMPORT, IMPORT_BINDING
-- Edge types: CONTAINS (scope -> import, import -> binding)
-- Deferred: IMPORTS_FROM (for cross-file resolution)
--
-- Metadata on IMPORT: path (Text), glob (Bool)
-- Metadata on IMPORT_BINDING: imported_name (Text), local_name (Text)
--
-- Called from 'Analysis.Walker.walkFile' for each top-level item.
module Rules.Imports
  ( walkImports
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import RustAST
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
    , askExported
    )
import Grafema.SemanticId (semanticId)

-- ── Flat binding (result of use tree flattening) ────────────────────────

-- | A single flattened binding extracted from a use tree.
data FlatBinding = FlatBinding
  { fbPath      :: !Text    -- ^ full path like "std::io::Read"
  , fbName      :: !Text    -- ^ imported name ("Read")
  , fbLocalName :: !Text    -- ^ local name (same as fbName unless renamed)
  , fbGlob      :: !Bool    -- ^ true for glob imports
  } deriving (Show, Eq)

-- ── Visibility helpers ──────────────────────────────────────────────────

-- | Is this visibility public (exported)?
isPub :: Vis -> Bool
isPub VisPub      = True
isPub VisPubCrate = True
isPub _           = False

-- ── Use tree flattening ─────────────────────────────────────────────────

-- | Flatten a recursive 'RustUseTree' into a list of flat bindings.
--
-- Recursively traverses the tree, accumulating path prefixes, and produces
-- one 'FlatBinding' for each leaf (UseName, UseRename, UseGlob).
-- UseGroup fans out into multiple bindings via concatMap.
flattenUseTree :: Text -> RustUseTree -> [FlatBinding]
flattenUseTree prefix (UsePath ident subtree) =
  let newPrefix = if T.null prefix then ident else prefix <> "::" <> ident
  in flattenUseTree newPrefix subtree
flattenUseTree prefix (UseName ident) =
  [FlatBinding
    { fbPath      = if T.null prefix then ident else prefix <> "::" <> ident
    , fbName      = ident
    , fbLocalName = ident
    , fbGlob      = False
    }]
flattenUseTree prefix (UseRename ident rename) =
  [FlatBinding
    { fbPath      = if T.null prefix then ident else prefix <> "::" <> ident
    , fbName      = ident
    , fbLocalName = rename
    , fbGlob      = False
    }]
flattenUseTree prefix UseGlob =
  [FlatBinding
    { fbPath      = prefix <> "::*"
    , fbName      = "*"
    , fbLocalName = "*"
    , fbGlob      = True
    }]
flattenUseTree prefix (UseGroup items) =
  concatMap (flattenUseTree prefix) items

-- ── Path extraction (strip trailing name for import path) ───────────────

-- | Extract the base path from a full binding path (strip last segment).
-- "std::io::Read" -> "std::io"
-- "std::io"       -> "std"
-- "io"            -> "io"  (single-segment paths stay as-is)
importBasePath :: Text -> Text
importBasePath fullPath =
  let segments = T.splitOn "::" fullPath
  in case segments of
       []  -> fullPath
       [_] -> fullPath
       _   -> T.intercalate "::" (init segments)

-- ── Top-level item walker ───────────────────────────────────────────────

-- | Walk a single Rust item for import analysis.
--
-- Handles ItemUse only. Other item types are silently ignored
-- (handled by other rule modules).
walkImports :: RustItem -> Analyzer ()

walkImports (ItemUse tree vis sp _attrs) = do
  file     <- askFile
  scopeId  <- askScopeId
  exported <- askExported

  let useExported = exported || isPub vis
      bindings    = flattenUseTree T.empty tree
      line        = posLine (spanStart sp)
      col         = posCol  (spanStart sp)

  -- Group bindings by their import path to avoid emitting duplicate
  -- IMPORT nodes when multiple items are imported from the same module
  -- (e.g. use std::io::{Read, Write}; should produce one IMPORT "std::io").
  let grouped = groupByImportPath bindings
  mapM_ (emitImportGroup file scopeId useExported line col) grouped

-- All other items: silently skip
walkImports _ = pure ()

-- ── Grouping ─────────────────────────────────────────────────────────────

-- | Group flat bindings by their import path (the module path).
-- Returns a list of (importPath, isGlob, bindings) tuples.
-- For glob imports, the import path includes "::*".
-- Preserves order of first occurrence of each import path.
groupByImportPath :: [FlatBinding] -> [(Text, Bool, [FlatBinding])]
groupByImportPath = map collapse . groupByKey importKey
  where
    importKey b = if fbGlob b then fbPath b else importBasePath (fbPath b)
    collapse bs =
      let isGlob = any fbGlob bs
          key = importKey (head bs)
      in (key, isGlob, bs)

-- | Group a list by a key function, preserving order of first occurrence.
-- Handles non-consecutive elements with the same key.
groupByKey :: (Eq b) => (a -> b) -> [a] -> [[a]]
groupByKey _ [] = []
groupByKey f (x:xs) =
  let key = f x
      (same, rest) = partition (\y -> f y == key) xs
  in (x : same) : groupByKey f rest
  where
    partition _ [] = ([], [])
    partition p (y:ys) =
      let (yes, no) = partition p ys
      in if p y then (y:yes, no) else (yes, y:no)

-- ── Per-group emission ───────────────────────────────────────────────────

-- | Emit an IMPORT node for a group of bindings sharing the same import path,
-- then emit IMPORT_BINDING nodes for each non-glob binding.
emitImportGroup :: Text -> Text -> Bool -> Int -> Int -> (Text, Bool, [FlatBinding]) -> Analyzer ()
emitImportGroup file scopeId useExported line col (importPath, isGlob, bindings) = do
  let importNodeId = semanticId file "IMPORT" importPath Nothing Nothing

  -- Emit IMPORT node
  emitNode GraphNode
    { gnId       = importNodeId
    , gnType     = "IMPORT"
    , gnName     = importPath
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = useExported
    , gnMetadata = Map.fromList
        [ ("path", MetaText importPath)
        , ("glob", MetaBool isGlob)
        ]
    }

  -- Emit CONTAINS edge from scope to IMPORT
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = importNodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- For each non-glob binding, emit IMPORT_BINDING + CONTAINS + deferred ref
  mapM_ (emitBinding file importNodeId useExported line col) (filter (not . fbGlob) bindings)

-- ── Per-binding emission ─────────────────────────────────────────────────

-- | Emit an IMPORT_BINDING node, CONTAINS edge from IMPORT to binding,
-- and a deferred IMPORTS_FROM reference for cross-file resolution.
emitBinding :: Text -> Text -> Bool -> Int -> Int -> FlatBinding -> Analyzer ()
emitBinding file importNodeId useExported line col binding = do
  let path = fbPath binding
      bindingNodeId = semanticId file "IMPORT_BINDING" (fbLocalName binding) Nothing (Just path)

  emitNode GraphNode
    { gnId       = bindingNodeId
    , gnType     = "IMPORT_BINDING"
    , gnName     = fbLocalName binding
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = useExported
    , gnMetadata = Map.fromList
        [ ("imported_name", MetaText (fbName binding))
        , ("local_name",    MetaText (fbLocalName binding))
        ]
    }

  -- Emit CONTAINS edge from IMPORT to IMPORT_BINDING
  emitEdge GraphEdge
    { geSource   = importNodeId
    , geTarget   = bindingNodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit deferred IMPORTS_FROM for cross-file resolution
  emitDeferred DeferredRef
    { drKind       = ImportResolve
    , drName       = fbName binding
    , drFromNodeId = bindingNodeId
    , drEdgeType   = "IMPORTS_FROM"
    , drScopeId    = Nothing
    , drSource     = Just path
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.empty
    }

{-# LANGUAGE OverloadedStrings #-}
-- | JS/TS class inheritance EXTENDS edge resolution.
--
-- Creates EXTENDS edges for class inheritance patterns:
--   - Same-file: @class Dog extends Animal@ → CLASS Dog → EXTENDS → CLASS Animal (same file)
--   - Cross-file: @import { Animal } from './base'; class Dog extends Animal@
--               → CLASS Dog → EXTENDS → CLASS Animal (different file, resolved via imports)
--
-- The @superClass@ metadata is recorded by the JS/TS analyzer (Declarations.hs:320)
-- but no edge was previously created. This plugin fills that gap.
--
-- V1 scope:
--   - Handles direct superClass metadata (single level of inheritance)
--   - Resolves cross-file via IMPORT_BINDING + ExportIndex (relative specifiers only)
--   - Does NOT handle namespace imports (@import * as X@) — future work
--   - Does NOT chain inheritance transitively — callers can traverse EXTENDS edges
module ClassInheritance (resolveAll, resolveFileWithIndex) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import ImportResolution
  ( ExportIndex, ExportEntry(..)
  , buildExportIndex, resolveModulePath, isRelativeSpecifier
  , findMatchingExport, extractImportSource, extractImportedName
  )
import ResolveUtil (lookupMetaText)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- | Same-file class index: (file, className) -> node ID
type ClassIndex = Map (Text, Text) Text

-- | Import binding record.
data ImportBinding = ImportBinding
  { ibSource       :: !Text  -- module specifier (e.g., "./base")
  , ibImportedName :: !Text  -- original export name (e.g., "Animal")
  }

-- | Import binding index: (file, localName) -> ImportBinding
type ImportBindingIndex = Map (Text, Text) ImportBinding

-- ---------------------------------------------------------------------------
-- Index construction
-- ---------------------------------------------------------------------------

-- | Build an index of CLASS nodes: (file, className) -> nodeId.
buildClassIndex :: [GraphNode] -> ClassIndex
buildClassIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), gnId n)
    | n <- nodes
    , gnType n == "CLASS"
    , not (T.null (gnName n))
    ]

-- | Build an index of import bindings from IMPORT_BINDING nodes.
-- Only relative specifiers (bare specifiers like npm packages handled elsewhere).
buildImportBindingIndex :: [GraphNode] -> ImportBindingIndex
buildImportBindingIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), ImportBinding source importedName)
    | n <- nodes
    , gnType n == "IMPORT_BINDING"
    , Just source <- [extractImportSource n]
    , isRelativeSpecifier source
    , Just importedName <- [extractImportedName n]
    ]

-- | Check if a node is a JS/TS file.
isJsTsFile :: Text -> Bool
isJsTsFile f = any (`T.isSuffixOf` f) [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

-- | Resolve a single CLASS node that has a superClass to an EXTENDS edge.
resolveOne
  :: ClassIndex
  -> ImportBindingIndex
  -> ExportIndex
  -> GraphNode  -- must be a CLASS node with superClass metadata
  -> [PluginCommand]
resolveOne classIdx importIdx exportIdx classNode =
  let file       = gnFile classNode
      superName  = lookupMetaText "superClass" (gnMetadata classNode)
  in case superName of
    Nothing -> []
    Just sc ->
      -- 1. Try same-file: superClass is a CLASS in the same file
      case Map.lookup (file, sc) classIdx of
        Just targetId ->
          [ EmitEdge GraphEdge
              { geSource   = gnId classNode
              , geTarget   = targetId
              , geType     = "EXTENDS"
              , geMetadata = Map.singleton "resolvedVia" (MetaText "class-inheritance")
              }
          ]
        Nothing ->
          -- 2. Try cross-file: superClass was imported
          case Map.lookup (file, sc) importIdx of
            Nothing -> []
            Just ib ->
              case resolveModulePath file (ibSource ib) exportIdx Map.empty of
                Nothing -> []
                Just resolvedPath ->
                  case Map.lookup resolvedPath exportIdx of
                    Nothing -> []
                    Just exports ->
                      case findMatchingExport (ibImportedName ib) exports of
                        Nothing -> []
                        Just entry ->
                          [ EmitEdge GraphEdge
                              { geSource   = gnId classNode
                              , geTarget   = eeNodeId entry
                              , geType     = "EXTENDS"
                              , geMetadata = Map.fromList
                                  [ ("resolvedVia", MetaText "class-inheritance")
                                  , ("importedFrom", MetaText (ibSource ib))
                                  ]
                              }
                          ]

-- | Resolve all CLASS inheritance edges.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let classIdx  = buildClassIndex nodes
      importIdx = buildImportBindingIndex nodes
      exportIdx = buildExportIndex nodes
      -- Only process CLASS nodes with superClass metadata, in JS/TS files
      classNodes = filter (\n ->
          gnType n == "CLASS" &&
          isJsTsFile (gnFile n) &&
          Map.member "superClass" (gnMetadata n)
        ) nodes
      results = concatMap (resolveOne classIdx importIdx exportIdx) classNodes
  in results

-- | Resolve with a pre-built export index (for streaming per-file mode).
resolveFileWithIndex :: ExportIndex -> [GraphNode] -> [PluginCommand]
resolveFileWithIndex exportIdx fileNodes =
  -- Build file-local class index (for same-file inheritance detection)
  -- Note: cross-file superclasses in fileNodes won't have targets in classIdx
  -- but importIdx will still be built from fileNodes' IMPORT_BINDINGs
  let classIdx  = buildClassIndex fileNodes
      importIdx = buildImportBindingIndex fileNodes
      classNodes = filter (\n ->
          gnType n == "CLASS" &&
          isJsTsFile (gnFile n) &&
          Map.member "superClass" (gnMetadata n)
        ) fileNodes
  in concatMap (resolveOne classIdx importIdx exportIdx) classNodes

{-# LANGUAGE OverloadedStrings #-}
-- | Cross-file CALLS resolution plugin.
--
-- Creates CALLS edges for cross-file invocations. When a file imports a
-- function via @import { greet } from './utils'@ and then calls @greet()@,
-- this plugin creates a CALLS edge from the CALL node to the FUNCTION node
-- in utils.js.
--
-- Re-derives import links from IMPORT_BINDING metadata (source + importedName)
-- and the export index built from all nodes. No dependency on prior resolution
-- passes — only needs the raw analysis nodes.
module CrossFileCalls (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)
import ImportResolution
  ( ExportIndex, ExportEntry(..)
  , buildExportIndex, resolveModulePath, isRelativeSpecifier
  , findMatchingExport, extractImportSource, extractImportedName
  )

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- | An import binding record: in file F, local name L was imported
-- from source S with imported name N.
data ImportBinding = ImportBinding
  { ibSource       :: !Text  -- module specifier (e.g., "./utils")
  , ibImportedName :: !Text  -- original export name (e.g., "greet", "default")
  }

-- | Import binding index: (file, localName) -> ImportBinding
type ImportBindingIndex = Map (Text, Text) ImportBinding

-- ---------------------------------------------------------------------------
-- Index construction
-- ---------------------------------------------------------------------------

-- | Build an index of import bindings from IMPORT_BINDING nodes.
-- Only includes relative specifiers (bare specifiers are handled by Builtins).
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

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

-- | Core cross-file CALLS resolution logic.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let exportIndex = buildExportIndex nodes
      importBindingIndex = buildImportBindingIndex nodes
      callNodes = filter (\n -> gnType n == "CALL") nodes
  in concatMap (resolveCallNode exportIndex importBindingIndex) callNodes

-- | Resolve a single CALL node to a cross-file CALLS edge.
resolveCallNode :: ExportIndex -> ImportBindingIndex -> GraphNode -> [PluginCommand]
resolveCallNode exportIndex importBindingIndex callNode =
  let file = gnFile callNode
      callee = gnName callNode
  in case resolveCallee importBindingIndex exportIndex file callee of
    Nothing       -> []
    Just targetId -> [EmitEdge GraphEdge
      { geSource   = gnId callNode
      , geTarget   = targetId
      , geType     = "CALLS"
      , geMetadata = Map.singleton "resolvedVia" (MetaText "cross-file-calls")
      }]

-- | Resolve a callee name against the import binding index and export index.
-- Returns the target node ID if the call resolves to a cross-file function.
resolveCallee :: ImportBindingIndex -> ExportIndex -> Text -> Text -> Maybe Text
resolveCallee importBindingIndex exportIndex file callee =
  case T.breakOn "." callee of
    -- Method call: "utils.greet" -> objectName="utils", methodName="greet"
    -- Object might be a namespace import (import * as utils from './utils')
    (objectName, rest)
      | not (T.null rest) ->
          let methodName = T.drop 1 rest
          in case Map.lookup (file, objectName) importBindingIndex of
            Just ib
              | ibImportedName ib == "*" ->
                  -- Namespace import: resolve methodName from the target module
                  resolveInModule exportIndex file (ibSource ib) methodName
              | otherwise -> Nothing  -- Not a namespace import, skip
            Nothing -> Nothing

    -- Direct call: "greet" -> look up in import binding index
      | otherwise ->
          case Map.lookup (file, callee) importBindingIndex of
            Just ib ->
              resolveInModule exportIndex file (ibSource ib) (ibImportedName ib)
            Nothing -> Nothing

-- | Resolve a function name from a module's exports.
-- Returns the node ID of the target export entry.
resolveInModule :: ExportIndex -> Text -> Text -> Text -> Maybe Text
resolveInModule exportIndex importerFile source importedName =
  case resolveModulePath importerFile source exportIndex Map.empty of
    Nothing -> Nothing
    Just resolvedFile ->
      case Map.lookup resolvedFile exportIndex of
        Nothing      -> Nothing
        Just exports ->
          case findMatchingExport importedName exports of
            Nothing    -> Nothing
            Just entry -> Just (eeNodeId entry)

-- ---------------------------------------------------------------------------
-- CLI entry point
-- ---------------------------------------------------------------------------

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)

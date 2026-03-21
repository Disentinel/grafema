{-# LANGUAGE OverloadedStrings #-}
-- | Property access resolution plugin.
--
-- Creates READS_FROM edges for PROPERTY_ACCESS nodes that read properties.
-- Handles (in priority order):
--   1. @this.prop@ → PROPERTY_ASSIGNMENT or METHOD in same class
--   2. @ClassName.staticProp@ → PROPERTY_ASSIGNMENT or METHOD in named class
--   3. @nsImport.prop@ → exported declaration via namespace import
--
-- Does NOT handle dynamic property access or type-inferred resolution.
module PropertyAccess (run, resolveAll, resolveFileWithIndex) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)
import ResolveUtil (extractClassFromId, lookupMetaText, ClassRangeIndex, buildClassRangeIndex, findEnclosingClass)
import ImportResolution
  ( ExportIndex, ExportEntry(..)
  , buildExportIndex, resolveModulePath, isRelativeSpecifier
  , findMatchingExport, extractImportSource, extractImportedName
  )

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import Data.Char (isUpper)

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- | Property definition index: (file, className, propertyName) -> node ID
type PropertyDefIndex = Map (Text, Text, Text) Text

-- | An import binding record: in file F, local name L was imported
-- from source S with imported name N.
data ImportBinding = ImportBinding
  { ibSource       :: !Text  -- module specifier (e.g., "./utils")
  , ibImportedName :: !Text  -- original export name (e.g., "greet", "default", "*")
  }

-- | Import binding index: (file, localName) -> ImportBinding
type ImportBindingIndex = Map (Text, Text) ImportBinding

-- ---------------------------------------------------------------------------
-- Index construction
-- ---------------------------------------------------------------------------

-- | Build an index of property definitions from PROPERTY_ASSIGNMENT nodes.
-- Key: (file, className, propertyName) where className comes from metadata or semantic ID.
buildPropertyDefIndex :: [GraphNode] -> PropertyDefIndex
buildPropertyDefIndex nodes =
  Map.fromList $ concat
    [ -- PROPERTY_ASSIGNMENT nodes with className metadata
      [ ((gnFile n, className, gnName n), gnId n)
      | n <- nodes
      , gnType n == "PROPERTY_ASSIGNMENT"
      , not (T.null (gnName n))
      , Just className <- [extractClassName n]
      ]
    , -- METHOD/FUNCTION nodes with [in:ClassName] in their semantic ID
      [ ((gnFile n, className, gnName n), gnId n)
      | n <- nodes
      , gnType n == "METHOD" || gnType n == "FUNCTION"
      , not (T.null (gnName n))
      , Just className <- [extractClassFromId (gnId n)]
      ]
    ]

-- | Extract className from a PROPERTY_ASSIGNMENT node.
-- Tries metadata.className first, then falls back to extractClassFromId.
extractClassName :: GraphNode -> Maybe Text
extractClassName node =
  case lookupMetaText "className" (gnMetadata node) of
    Just cn -> Just cn
    Nothing -> extractClassFromId (gnId node)

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

-- | Core property access resolution logic.
-- Tries same-file class resolution first, then cross-file namespace imports.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let propDefIndex      = buildPropertyDefIndex nodes
      exportIndex       = buildExportIndex nodes
      importBindingIndex = buildImportBindingIndex nodes
      classRangeIdx     = buildClassRangeIndex nodes
      propAccessNodes   = filter (\n -> gnType n == "PROPERTY_ACCESS") nodes
  in concatMap (resolvePropAccess propDefIndex exportIndex importBindingIndex classRangeIdx) propAccessNodes

-- | Resolve a single PROPERTY_ACCESS node.
-- Priority: same-file class members → cross-file namespace imports.
resolvePropAccess :: PropertyDefIndex -> ExportIndex -> ImportBindingIndex -> ClassRangeIndex -> GraphNode -> [PluginCommand]
resolvePropAccess propDefIndex exportIndex importBindingIndex classRangeIdx node =
  let file     = gnFile node
      propName = gnName node
      mObjectName = lookupMetaText "base" (gnMetadata node)
  in case mObjectName of
    Nothing -> tryCrossFile exportIndex importBindingIndex node
    Just objectName
      -- "this.prop", "super.prop", or "<obj>.prop" -> use line containment to find enclosing class
      | objectName == "this" || objectName == "super" || objectName == "<obj>" ->
          case findEnclosingClass classRangeIdx file (gnLine node) of
            Just className ->
              case tryResolveClass propDefIndex file className propName node of
                [] -> tryCrossFile exportIndex importBindingIndex node
                result -> result
            Nothing -> tryCrossFile exportIndex importBindingIndex node
      -- "ClassName.prop" where ClassName starts with uppercase
      | not (T.null objectName) && isUpper (T.head objectName) ->
          case tryResolveClass propDefIndex file objectName propName node of
            [] -> tryCrossFile exportIndex importBindingIndex node
            result -> result
      -- "obj.prop" where obj is a variable -> try cross-file
      | otherwise -> tryCrossFile exportIndex importBindingIndex node

-- | Try to resolve a property to its same-file class definition.
tryResolveClass :: PropertyDefIndex -> Text -> Text -> Text -> GraphNode -> [PluginCommand]
tryResolveClass propDefIndex file className propName node =
  case Map.lookup (file, className, propName) propDefIndex of
    Just targetId -> [EmitEdge GraphEdge
      { geSource   = gnId node
      , geTarget   = targetId
      , geType     = "READS_FROM"
      , geMetadata = Map.singleton "resolvedVia" (MetaText "property-access")
      }]
    Nothing -> []

-- | Try to resolve via cross-file namespace import.
tryCrossFile :: ExportIndex -> ImportBindingIndex -> GraphNode -> [PluginCommand]
tryCrossFile exportIndex importBindingIndex node =
  let file = gnFile node
      name = gnName node
  in case resolvePropertyAccess importBindingIndex exportIndex file name of
    Just targetId -> [EmitEdge GraphEdge
      { geSource   = gnId node
      , geTarget   = targetId
      , geType     = "READS_FROM"
      , geMetadata = Map.singleton "resolvedVia" (MetaText "property-access")
      }]
    Nothing -> []

-- | Resolve a property access against the import binding index and export index.
-- V1: Only resolves namespace imports (import * as X from '...'; X.prop).
resolvePropertyAccess :: ImportBindingIndex -> ExportIndex -> Text -> Text -> Maybe Text
resolvePropertyAccess importBindingIndex exportIndex file name =
  case T.breakOn "." name of
    (objectName, rest)
      | not (T.null rest) ->
          let propertyName = T.drop 1 rest
          in case Map.lookup (file, objectName) importBindingIndex of
            Just ib
              | ibImportedName ib == "*" ->
                  -- Namespace import: resolve propertyName from the target module
                  resolveInModule exportIndex file (ibSource ib) propertyName
              | otherwise -> Nothing  -- Named import, skip in V1
            Nothing -> Nothing  -- Not an import, skip
      | otherwise -> Nothing  -- No "." in name, not a property access

-- | Resolve a name from a module's exports.
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
-- Per-file streaming resolution (uses pre-built ExportIndex)
-- ---------------------------------------------------------------------------

-- | Resolve property accesses for a single file's nodes using a pre-built ExportIndex.
--
-- Unlike 'resolveAll' which builds all indexes from all nodes, this function
-- takes a pre-built ExportIndex (from 'build-index' phase) and builds the
-- PropertyDefIndex and ImportBindingIndex from the file's own nodes only.
resolveFileWithIndex :: ExportIndex -> [GraphNode] -> [PluginCommand]
resolveFileWithIndex exportIndex fileNodes =
  let propDefIndex       = buildPropertyDefIndex fileNodes
      importBindingIndex = buildImportBindingIndex fileNodes
      propAccessNodes    = filter (\n -> gnType n == "PROPERTY_ACCESS") fileNodes
  in concatMap (resolvePropAccess propDefIndex exportIndex importBindingIndex) propAccessNodes

-- ---------------------------------------------------------------------------
-- CLI entry point
-- ---------------------------------------------------------------------------

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)

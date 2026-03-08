{-# LANGUAGE OverloadedStrings #-}
-- | Property access read-context resolution plugin.
--
-- Creates READS_FROM edges for PROPERTY_ACCESS nodes that read properties.
-- Handles:
--   - @this.prop@ → PROPERTY_ASSIGNMENT or METHOD in same class
--   - @ClassName.staticProp@ → PROPERTY_ASSIGNMENT or METHOD in named class
--
-- Does NOT handle dynamic property access or type-inferred resolution.
module PropertyAccess (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)
import ResolveUtil (extractClassFromId, lookupMetaText)

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

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

-- | Core property access resolution logic.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let propDefIndex = buildPropertyDefIndex nodes
      propAccessNodes = filter (\n -> gnType n == "PROPERTY_ACCESS") nodes
  in concatMap (resolvePropAccess propDefIndex) propAccessNodes

-- | Resolve a single PROPERTY_ACCESS node.
resolvePropAccess :: PropertyDefIndex -> GraphNode -> [PluginCommand]
resolvePropAccess propDefIndex node =
  let file     = gnFile node
      propName = gnName node
      -- objectName can be in metadata or derivable from context
      mObjectName = lookupMetaText "base" (gnMetadata node)
  in case mObjectName of
    Nothing -> []
    Just objectName
      -- "this.prop" or "super.prop" -> resolve in enclosing class
      | objectName == "this" || objectName == "super" ->
          case extractClassFromId (gnId node) of
            Just className ->
              tryResolve propDefIndex file className propName node
            Nothing -> []
      -- "ClassName.prop" where ClassName starts with uppercase
      | not (T.null objectName) && isUpper (T.head objectName) ->
          tryResolve propDefIndex file objectName propName node
      -- "obj.prop" where obj is a variable -> can't resolve without types
      | otherwise -> []

-- | Try to resolve a property to its definition.
tryResolve :: PropertyDefIndex -> Text -> Text -> Text -> GraphNode -> [PluginCommand]
tryResolve propDefIndex file className propName node =
  case Map.lookup (file, className, propName) propDefIndex of
    Just targetId -> [EmitEdge GraphEdge
      { geSource   = gnId node
      , geTarget   = targetId
      , geType     = "READS_FROM"
      , geMetadata = Map.singleton "resolvedVia" (MetaText "property-access")
      }]
    Nothing -> []

-- ---------------------------------------------------------------------------
-- CLI entry point
-- ---------------------------------------------------------------------------

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)

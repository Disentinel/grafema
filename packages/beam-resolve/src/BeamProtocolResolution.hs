{-# LANGUAGE OverloadedStrings #-}
-- | BEAM protocol resolution plugin.
--
-- Finds "defimpl" patterns in the graph and creates IMPLEMENTS edges
-- between implementation MODULE nodes and protocol MODULE nodes.
--
-- Detection: MODULE nodes whose name matches "Protocol.Type" pattern
-- (e.g., "String.Chars.MyApp.User") where "String.Chars" is the protocol
-- and "MyApp.User" is the implementing type.
--
-- The analyzer marks defimpl modules with metadata:
--   protocol: "String.Chars"
--   for_type: "MyApp.User"
module BeamProtocolResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map

-- | Module index: module name -> node ID
type ModuleIndex = Map Text Text

-- | Build module index.
buildModuleIndex :: [GraphNode] -> ModuleIndex
buildModuleIndex nodes =
  Map.fromList
    [ (gnName n, gnId n)
    | n <- nodes
    , gnType n == "MODULE"
    ]

-- | Look for defimpl metadata on MODULE nodes.
-- A MODULE with metadata "protocol" and "for_type" is a defimpl.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let moduleIdx = buildModuleIndex nodes
      implModules = filter isDefImpl nodes
  in concatMap (resolveImpl moduleIdx) implModules

-- | Check if a MODULE node represents a defimpl.
isDefImpl :: GraphNode -> Bool
isDefImpl n =
  gnType n == "MODULE" &&
  Map.member "protocol" (gnMetadata n)

-- | Resolve a single defimpl MODULE to IMPLEMENTS edges.
resolveImpl :: ModuleIndex -> GraphNode -> [PluginCommand]
resolveImpl moduleIdx implNode =
  case Map.lookup "protocol" (gnMetadata implNode) of
    Just (MetaText protocolName) ->
      case Map.lookup protocolName moduleIdx of
        Just protocolNodeId ->
          [ EmitEdge GraphEdge
              { geSource   = gnId implNode
              , geTarget   = protocolNodeId
              , geType     = "IMPLEMENTS"
              , geMetadata = Map.fromList
                  [ ("resolvedVia", MetaText "beam-protocols")
                  , ("kind", MetaText "protocol")
                  ]
              }
          ]
        Nothing -> []  -- protocol not in analyzed codebase
    _ -> []

-- | CLI entry point.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)

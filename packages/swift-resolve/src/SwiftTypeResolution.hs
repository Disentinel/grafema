{-# LANGUAGE OverloadedStrings #-}
-- | Swift type resolution plugin.
--
-- Resolves type references in Swift code.
--
-- Produces:
--   - EXTENDS edges: extension/class -> target type (protocol conformance, inheritance)
--
-- == Resolution Algorithm
--
-- Phase 1: Build type index from CLASS and TYPE_ALIAS nodes in Swift files.
-- Phase 2: For each EXTENSION node, resolve to the extended type.
module SwiftTypeResolution
  ( resolveAll
  , run
  ) where

import Data.Text (Text)
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import Data.List (foldl')
import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)
import System.IO (hPutStrLn, stderr)

-- | Resolve type references in Swift code.
--
-- Handles:
-- - Protocol conformance: find where @extension Type: Protocol@ is declared
-- - Inheritance: class/struct extending another type
-- - Type references in generic constraints
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let -- Build type index: name -> nodeId
      typeIndex :: Map Text Text
      typeIndex = foldl' (\acc n ->
        if (gnType n == "CLASS" || gnType n == "TYPE_ALIAS") && hasSwiftLang n
          then Map.insert (gnName n) (gnId n) acc
          else acc
        ) Map.empty nodes

      -- Find EXTENSION nodes in Swift files
      extensionNodes =
        [ n
        | n <- nodes
        , gnType n == "EXTENSION"
        , hasSwiftLang n
        ]

      -- Resolve extensions to their extended types
      extEdges = concatMap (resolveExtension typeIndex) extensionNodes

  hPutStrLn stderr $
    "swift-types: " ++ show (length extEdges) ++ " type edges"

  return extEdges

resolveExtension :: Map Text Text -> GraphNode -> [PluginCommand]
resolveExtension typeIndex extNode =
  let extTypeName = case Map.lookup "extendedType" (gnMetadata extNode) of
        Just (MetaText name) -> name
        _ -> gnName extNode
  in case Map.lookup extTypeName typeIndex of
    Just targetId ->
      [ EmitEdge GraphEdge
          { geSource = gnId extNode
          , geTarget = targetId
          , geType = "EXTENDS"
          , geMetadata = Map.singleton "resolvedVia" (MetaText "swift-type-resolution")
          }
      ]
    Nothing -> []

hasSwiftLang :: GraphNode -> Bool
hasSwiftLang n = case Map.lookup "language" (gnMetadata n) of
  Just (MetaText "swift") -> True
  _ -> False

-- | CLI entry point: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

{-# LANGUAGE OverloadedStrings #-}
-- | Swift import resolution plugin.
--
-- Resolves Swift import statements to their target MODULE nodes.
-- Swift imports are module-level (e.g., @import Foundation@, @import UIKit@).
--
-- == Resolution Algorithm
--
-- Phase 1: Build module index from all MODULE nodes in Swift files.
--   - Module index: module name -> MODULE node ID
--
-- Phase 2: For each IMPORT node in Swift files, look up the target module
--   in the index and emit an IMPORTS_FROM edge.
module SwiftImportResolution
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

-- | Resolve Swift import statements to their target modules.
--
-- For each IMPORT node in Swift files, find the corresponding MODULE node
-- that matches the import path. Swift imports are module-level
-- (e.g., @import Foundation@, @import UIKit@).
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let -- Build index: module name -> MODULE node ID
      moduleIndex :: Map Text Text
      moduleIndex = foldl' (\acc n ->
        if gnType n == "MODULE" && hasSwiftLang n
          then Map.insert (gnName n) (gnId n) acc
          else acc
        ) Map.empty nodes

      -- Find all IMPORT nodes in Swift files
      importNodes = [ n | n <- nodes, gnType n == "IMPORT", hasSwiftLang n ]

      -- Resolve each import
      edges = concatMap (resolveImport moduleIndex) importNodes

  hPutStrLn stderr $
    "swift-imports: " ++ show (length edges) ++ " import edges"

  return edges

resolveImport :: Map Text Text -> GraphNode -> [PluginCommand]
resolveImport moduleIndex importNode =
  let importName = gnName importNode
      -- Try to find a module matching the import name
      -- Swift imports can be full module names or sub-module paths
  in case Map.lookup importName moduleIndex of
    Just targetId ->
      [ EmitEdge GraphEdge
          { geSource = gnId importNode
          , geTarget = targetId
          , geType = "IMPORTS_FROM"
          , geMetadata = Map.singleton "resolvedVia" (MetaText "swift-import-resolution")
          }
      ]
    Nothing -> []  -- Unresolved import (external framework, etc.)

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

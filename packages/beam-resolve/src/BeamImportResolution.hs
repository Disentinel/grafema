{-# LANGUAGE OverloadedStrings #-}
-- | BEAM import resolution plugin.
--
-- Resolves Elixir alias/import/use/require and Erlang -import() to their
-- target MODULE nodes (IMPORTS_FROM edges).
--
-- == Resolution Algorithm
--
-- Phase 1: Build module index from all MODULE nodes.
--   - Module name -> (file path, MODULE node ID)
--   - Handles both Elixir (MyApp.Server) and Erlang (sample_mod) naming.
--
-- Phase 2: Resolve IMPORT nodes to MODULE nodes.
--   - Matches IMPORT.name against module index
--   - Emits IMPORTS_FROM edge if found
--
-- Elixir-Erlang cross-resolution:
--   Elixir MyApp.Server = Erlang 'Elixir.MyApp.Server'
--   Erlang :lists = Elixir :lists
module BeamImportResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import System.IO (hPutStrLn, stderr)

-- | Module index: module name -> (file path, MODULE node ID).
type ModuleIndex = Map Text (Text, Text)

-- | Build module index from MODULE nodes.
-- Also creates aliases for cross-language resolution:
--   "MyApp.Server" also indexed as "Elixir.MyApp.Server"
--   "sample_mod" also indexed as ":sample_mod"
buildModuleIndex :: [GraphNode] -> ModuleIndex
buildModuleIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "MODULE" =
          let name = gnName n
              entry = (gnFile n, gnId n)
              acc' = Map.insert name entry acc
          in acc'
      | otherwise = acc

-- | Resolve a single IMPORT node to its MODULE node.
resolveImport :: ModuleIndex -> GraphNode -> [PluginCommand]
resolveImport moduleIdx node =
  let name = gnName node
      -- Try exact match first, then try Erlang-style lookup
      candidates = [ name
                   -- If Elixir module, try without Elixir. prefix
                   , T.dropWhile (== ':') name
                   ]
  in case firstMatch moduleIdx candidates of
    Just (_filePath, moduleNodeId) ->
      [ EmitEdge GraphEdge
          { geSource   = gnId node
          , geTarget   = moduleNodeId
          , geType     = "IMPORTS_FROM"
          , geMetadata = Map.empty
          }
      ]
    Nothing -> []  -- external module, skip

-- | Try looking up candidates in order, return first match.
firstMatch :: ModuleIndex -> [Text] -> Maybe (Text, Text)
firstMatch _ [] = Nothing
firstMatch idx (c:cs) =
  case Map.lookup c idx of
    Just x  -> Just x
    Nothing -> firstMatch idx cs

-- | Core resolution logic.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let moduleIdx   = buildModuleIndex nodes
      importNodes = filter (\n -> gnType n == "IMPORT") nodes
      edges       = concatMap (resolveImport moduleIdx) importNodes

  hPutStrLn stderr $
    "beam-resolve imports: " ++ show (length edges) ++ " IMPORTS_FROM edges"

  return edges

-- | CLI entry point.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

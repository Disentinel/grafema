{-# LANGUAGE OverloadedStrings #-}
-- | PHP import resolution plugin.
--
-- Resolves PHP @use@ declarations (IMPORT_BINDING nodes) to their target
-- declarations across files.
--
-- == PHP Import Semantics
--
-- @
-- use App\\Models\\User;           -- imports CLASS "User" from namespace "App\\Models"
-- use function App\\Utils\\helper;  -- imports FUNCTION "helper" from namespace "App\\Utils"
-- use const App\\Config\\VERSION;   -- imports CONSTANT "VERSION" from namespace "App\\Config"
-- @
--
-- The PHP analyzer emits IMPORT_BINDING nodes with:
--   - @name@: the leaf name (e.g., "User")
--   - @source@: the full namespace path (e.g., "App\\Models\\User") — this IS the
--     fully-qualified name
--   - @importKind@ metadata (optional): "function" or "constant" — if absent,
--     defaults to class/interface/trait/enum
--
-- == Resolution Algorithm
--
-- For each IMPORT_BINDING node:
--
-- 1. Get @source@ metadata — this is the fully-qualified name to look up
-- 2. Look up in NameIndex
-- 3. Emit IMPORTS_FROM edge if found
module PhpImportResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)
import PhpIndex

import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import System.IO (hPutStrLn, stderr)

-- | Core resolution logic.
--
-- Given all graph nodes from the analyzed project, resolves
-- IMPORT_BINDING nodes to their target declarations via fully-qualified
-- namespace lookup.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let modIdx  = buildModuleIndex nodes
      nameIdx = buildNameIndex nodes modIdx
      bindings = filter (\n -> gnType n == "IMPORT_BINDING") nodes

  let edges = concatMap (resolveBinding nameIdx) bindings

  hPutStrLn stderr $
    "php-import-resolve: " ++ show (length edges) ++ " import edges"

  return edges

-- | Resolve a single IMPORT_BINDING node to its target declaration.
--
-- The @source@ metadata contains the fully-qualified name (e.g.,
-- @App\\Models\\User@). If absent, we cannot resolve.
resolveBinding :: NameIndex -> GraphNode -> [PluginCommand]
resolveBinding nameIdx node =
  case getMetaText "source" node of
    Nothing -> []
    Just fqName ->
      case Map.lookup fqName nameIdx of
        Just (_file, targetId) ->
          [mkEdge (gnId node) targetId "IMPORTS_FROM"]
        Nothing ->
          -- Try with leading backslash stripped
          -- (some analyzers emit "\App\Models\User")
          let stripped = if "\\" `T.isPrefixOf` fqName
                         then T.drop 1 fqName
                         else fqName
          in if stripped == fqName
             then []  -- already tried, no leading backslash
             else case Map.lookup stripped nameIdx of
               Just (_file, targetId) ->
                 [mkEdge (gnId node) targetId "IMPORTS_FROM"]
               Nothing -> []  -- external dependency, skip

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

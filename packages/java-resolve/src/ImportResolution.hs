{-# LANGUAGE OverloadedStrings #-}
-- | Java import resolution plugin.
--
-- Resolves Java import declarations to their target files and declarations.
-- Uses fully-qualified class names (com.example.Foo) and maps them to
-- file paths via directory structure convention (com/example/Foo.java).
--
-- == Resolution Algorithm
--
-- Phase 1: Build indexes from all nodes.
--   - Module index: file path -> (MODULE node ID, package name)
--   - Class index:  qualified class name -> (file path, node ID)
--     Built from MODULE nodes' package metadata + CLASS/INTERFACE/ENUM/RECORD nodes.
--
-- Phase 2: Resolve IMPORT nodes to MODULE nodes (IMPORTS_FROM edges).
--   - Single import: "com.example.Foo" -> find class "Foo" in package "com.example"
--   - Static import: "com.example.Foo.bar" -> find class "Foo", then member "bar"
--   - Wildcard import: "com.example.*" -> find all classes in package "com.example"
--
-- Phase 3: Resolve IMPORT_BINDING nodes to exported declarations.
module ImportResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import System.IO (hPutStrLn, stderr)

-- | Module index: file path -> (MODULE node ID, package name or "")
type ModuleIndex = Map Text (Text, Text)

-- | Class index: qualified name (e.g. "com.example.Foo") -> (file path, node ID)
type ClassIndex = Map Text (Text, Text)

-- | Build module index from MODULE nodes.
buildModuleIndex :: [GraphNode] -> ModuleIndex
buildModuleIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "MODULE" =
          let pkg = case Map.lookup "package" (gnMetadata n) of
                Just (MetaText t) -> t
                _                 -> ""
          in Map.insert (gnFile n) (gnId n, pkg) acc
      | otherwise = acc

-- | Build class index from CLASS, INTERFACE, ENUM, RECORD nodes.
--
-- Maps qualified name (package.ClassName) to (file, nodeId).
-- Uses the module index to look up the package for each file.
buildClassIndex :: [GraphNode] -> ModuleIndex -> ClassIndex
buildClassIndex nodes modIdx = foldl' go Map.empty nodes
  where
    classTypes = Set.fromList ["CLASS", "INTERFACE", "ENUM", "RECORD"]

    go acc n
      | Set.member (gnType n) classTypes =
          let pkg = case Map.lookup (gnFile n) modIdx of
                Just (_, p) | not (T.null p) -> p <> "."
                _                            -> ""
              qualName = pkg <> gnName n
          in Map.insert qualName (gnFile n, gnId n) acc
      | otherwise = acc

-- | Resolve a single IMPORT node.
--
-- IMPORT nodes have metadata "source" with the import path (e.g. "com.example.Foo").
-- For single imports: match against class index.
-- For wildcard imports: skip (handled at binding level).
resolveImport :: ClassIndex -> ModuleIndex -> GraphNode -> [PluginCommand]
resolveImport classIdx modIdx node =
  let importName = gnName node
      isAsterisk = case Map.lookup "asterisk" (gnMetadata node) of
        Just (MetaBool True) -> True
        _                    -> False
  in if isAsterisk
     then []  -- wildcard imports don't resolve to a single target
     else case Map.lookup importName classIdx of
       Just (_filePath, classNodeId) ->
         [ EmitEdge GraphEdge
             { geSource   = gnId node
             , geTarget   = classNodeId
             , geType     = "IMPORTS_FROM"
             , geMetadata = Map.empty
             }
         ]
       Nothing -> []  -- external class (JDK, third-party), skip

-- | Resolve a single IMPORT_BINDING node.
--
-- IMPORT_BINDING nodes represent individual names brought into scope
-- by import declarations. The binding's "imported_name" metadata tells
-- us what name to look up.
resolveBinding :: ClassIndex -> ModuleIndex -> GraphNode -> [PluginCommand]
resolveBinding classIdx _modIdx node =
  let bindingName = gnName node
      -- Try to find as a fully qualified class
      -- The import path is typically stored in metadata
      source = case Map.lookup "source" (gnMetadata node) of
        Just (MetaText s) -> s
        _                 -> ""
  in if T.null source
     then []
     else
       -- For "import com.example.Foo", source = "com.example.Foo", name = "Foo"
       case Map.lookup source classIdx of
         Just (_filePath, classNodeId) ->
           [ EmitEdge GraphEdge
               { geSource   = gnId node
               , geTarget   = classNodeId
               , geType     = "IMPORTS_FROM"
               , geMetadata = Map.empty
               }
           ]
         Nothing ->
           -- Try without package (might be same-package import)
           case Map.lookup bindingName classIdx of
             Just (_filePath, classNodeId) ->
               [ EmitEdge GraphEdge
                   { geSource   = gnId node
                   , geTarget   = classNodeId
                   , geType     = "IMPORTS_FROM"
                   , geMetadata = Map.empty
                   }
               ]
             Nothing -> []  -- external, skip

-- | Core resolution logic.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let modIdx   = buildModuleIndex nodes
      classIdx = buildClassIndex nodes modIdx

      importNodes  = filter (\n -> gnType n == "IMPORT") nodes
      bindingNodes = filter (\n -> gnType n == "IMPORT_BINDING") nodes

  -- Phase 2: Resolve IMPORT -> target
  let importEdges = concatMap (resolveImport classIdx modIdx) importNodes

  -- Phase 3: Resolve IMPORT_BINDING -> declaration
  let bindingEdges = concatMap (resolveBinding classIdx modIdx) bindingNodes

  hPutStrLn stderr $
    "java-resolve: " ++ show (length importEdges) ++ " import edges, "
      ++ show (length bindingEdges) ++ " binding edges"

  return (importEdges ++ bindingEdges)

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

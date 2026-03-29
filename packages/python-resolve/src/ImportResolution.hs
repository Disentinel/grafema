{-# LANGUAGE OverloadedStrings #-}
-- | Python import resolution plugin.
--
-- Resolves Python import declarations to their target files and declarations.
-- Python uses dotted module paths (e.g., "mypackage.utils") mapped from
-- file paths via directory structure convention (mypackage/utils.py).
--
-- == Resolution Algorithm
--
-- Phase 1: Build indexes from all nodes.
--   - Module index: file path -> (MODULE node ID, module dotted path)
--     Built from MODULE nodes, converting file paths to dotted module paths.
--   - Name index:   (module_path, exported_name) -> (file path, node ID)
--     Built from FUNCTION, CLASS, VARIABLE nodes using their file's module path.
--     IMPORT_BINDING nodes are also included as re-exports (lower priority).
--
-- Phase 2: Resolve IMPORT_BINDING nodes to declarations (IMPORTS_FROM edges).
--   - Relative imports (leading dots) are resolved to absolute module paths.
--   - "from foo import bar" → look up (foo, bar) in name index
--   - "from foo import bar" where bar is a submodule → look up "foo.bar" in module index
--   - "import foo" → look up "foo" in module index
--   - "from foo import *" → IMPORTS_FROM to the MODULE node
module ImportResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import System.IO (hPutStrLn, stderr)

-- | Module index: file path -> (MODULE node ID, module dotted path)
type ModuleIndex = Map Text (Text, Text)

-- | Name index: (module_path, exported_name) -> (file, node ID)
type NameIndex = Map (Text, Text) (Text, Text)

-- | Build module index from MODULE nodes.
buildModuleIndex :: [GraphNode] -> ModuleIndex
buildModuleIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "MODULE" =
          let file = gnFile n
              modPath = fileToModulePath file
          in Map.insert file (gnId n, modPath) acc
      | otherwise = acc

-- | Convert file path to Python module path.
-- "src/mypackage/utils.py" -> "mypackage.utils"
-- "src/mypackage/__init__.py" -> "mypackage"
-- "mypackage/utils.pyi" -> "mypackage.utils"
fileToModulePath :: Text -> Text
fileToModulePath file =
  let noExt = if T.isSuffixOf ".pyi" file then T.dropEnd 4 file
              else if T.isSuffixOf ".py" file then T.dropEnd 3 file
              else file
      -- Remove common src prefixes
      stripped = stripSrcPrefix noExt
      -- Replace / with .
      dotted = T.replace "/" "." stripped
  in if T.isSuffixOf ".__init__" dotted
     then T.dropEnd 9 dotted  -- remove ".__init__"
     else dotted

stripSrcPrefix :: Text -> Text
stripSrcPrefix t =
  let prefixes = ["src/", "lib/", "source/"]
  in case filter (`T.isPrefixOf` t) prefixes of
       (p:_) -> T.drop (T.length p) t
       []    -> t

-- | Build name index: maps (module, name) to declarations.
-- Includes FUNCTION, CLASS, VARIABLE nodes directly, plus IMPORT_BINDING
-- nodes as re-exports (so "from .models import BaseModel" where BaseModel
-- is itself imported into models.py still resolves).
buildNameIndex :: [GraphNode] -> ModuleIndex -> NameIndex
buildNameIndex nodes modIdx = foldl' go Map.empty nodes
  where
    go acc n
      | gnType n `elem` ["FUNCTION", "CLASS", "VARIABLE"] =
          case Map.lookup (gnFile n) modIdx of
            Just (_, modPath) ->
              Map.insert (modPath, gnName n) (gnFile n, gnId n) acc
            Nothing -> acc
      -- IMPORT_BINDING acts as a re-export: if module A imports X from
      -- external, and module B does "from A import X", we should resolve
      -- B's binding to A's binding node.
      | gnType n == "IMPORT_BINDING" =
          case Map.lookup (gnFile n) modIdx of
            Just (_, modPath) ->
              -- Only insert if not already present (declarations take priority)
              case Map.lookup (modPath, gnName n) acc of
                Just _  -> acc  -- declaration already registered, skip
                Nothing -> Map.insert (modPath, gnName n) (gnFile n, gnId n) acc
            Nothing -> acc
      | otherwise = acc

-- | Get a text metadata value from a node.
getMetaText :: Text -> GraphNode -> Maybe Text
getMetaText key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaText t) | not (T.null t) -> Just t
    _                                  -> Nothing

-- | Resolve a relative import path to an absolute module path.
--
-- Python relative imports use leading dots:
--   "from ..base import StageBase" in file "pkg/stages/mod_a.py"
--   -> source_module = "..base", relative_level = 2
--   -> importer module = "pkg.stages.mod_a"
--   -> go up 2 levels from "pkg.stages" (parent package) -> "pkg"
--   -> append "base" -> "pkg.base"
--
-- For "from .foo import bar" (1 dot):
--   -> go up 1 level from parent package -> same package
resolveRelativeImport :: ModuleIndex -> Text -> Text -> Text
resolveRelativeImport modIdx importerFile rawSource =
  let (dots, rest) = T.span (== '.') rawSource
      level = T.length dots
  in if level == 0
     then rawSource  -- absolute import, return as-is
     else
       let importerMod = case Map.lookup importerFile modIdx of
             Just (_, mp) -> mp
             Nothing      -> fileToModulePath importerFile
           -- Split importer module path into components
           parts = T.splitOn "." importerMod
           -- Go up from the parent package:
           -- level=1 means current package (drop module name = 1 component)
           -- level=2 means parent package (drop 2 components)
           -- etc.
           dropCount = level
           base = T.intercalate "." (take (max 0 (length parts - dropCount)) parts)
       in if T.null rest
          then base
          else if T.null base
               then rest
               else base <> "." <> rest

-- | Resolve all IMPORT_BINDING nodes and glob IMPORT nodes.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let modIdx  = buildModuleIndex nodes
      nameIdx = buildNameIndex nodes modIdx
      importBindings = filter (\n -> gnType n == "IMPORT_BINDING") nodes
      globImports = filter isGlobImport nodes

  let bindingEdges = concatMap (resolveBinding modIdx nameIdx) importBindings
      globEdges    = concatMap (resolveGlobImport modIdx) globImports
      edges = bindingEdges ++ globEdges

  hPutStrLn stderr $
    "python-resolve: " ++ show (length edges) ++ " import edges"

  return edges

-- | Check if a node is a glob import (from foo import *).
isGlobImport :: GraphNode -> Bool
isGlobImport n =
  gnType n == "IMPORT" &&
  case Map.lookup "glob" (gnMetadata n) of
    Just (MetaBool True) -> True
    _                    -> False

-- | Resolve a glob import to its target module.
-- "from .models import *" -> IMPORTS_FROM edge to the models MODULE node.
resolveGlobImport :: ModuleIndex -> GraphNode -> [PluginCommand]
resolveGlobImport modIdx node =
  let rawPath = gnName node  -- e.g., ".models" or "..utils"
      importerFile = gnFile node
      modPath = resolveRelativeImport modIdx importerFile rawPath
      modMatch = [ (f, mid) | (f, (mid, mp)) <- Map.toList modIdx, mp == modPath ]
  in case modMatch of
       ((_, mid):_) ->
         [ EmitEdge GraphEdge
             { geSource   = gnId node
             , geTarget   = mid
             , geType     = "IMPORTS_FROM"
             , geMetadata = Map.fromList [("glob", MetaBool True)]
             }
         ]
       [] -> []

resolveBinding :: ModuleIndex -> NameIndex -> GraphNode -> [PluginCommand]
resolveBinding modIdx nameIdx binding =
  let importedName = case getMetaText "imported_name" binding of
        Just n  -> n
        Nothing -> gnName binding
      sourcePath = getMetaText "source_module" binding
      importerFile = gnFile binding
  in case sourcePath of
       Just rawModPath ->
         -- Resolve relative imports (leading dots) to absolute module paths
         let modPath = resolveRelativeImport modIdx importerFile rawModPath
         -- from foo import bar -> look up (foo, bar) in name index
         in case Map.lookup (modPath, importedName) nameIdx of
           Just (_file, targetId) ->
             [ EmitEdge GraphEdge
                 { geSource   = gnId binding
                 , geTarget   = targetId
                 , geType     = "IMPORTS_FROM"
                 , geMetadata = Map.empty
                 }
             ]
           Nothing ->
             -- Module-level import: from foo import bar might be importing module foo.bar
             let subModPath = modPath <> "." <> importedName
                 modMatch = [ (f, mid) | (f, (mid, mp)) <- Map.toList modIdx, mp == subModPath ]
             in case modMatch of
                  ((_, mid):_) ->
                    [ EmitEdge GraphEdge
                        { geSource   = gnId binding
                        , geTarget   = mid
                        , geType     = "IMPORTS_FROM"
                        , geMetadata = Map.empty
                        }
                    ]
                  [] -> []  -- unresolved, skip
       Nothing ->
         -- import foo -> look up foo as module path
         let modMatch = [ (f, mid) | (f, (mid, mp)) <- Map.toList modIdx, mp == importedName ]
         in case modMatch of
              ((_, mid):_) ->
                [ EmitEdge GraphEdge
                    { geSource   = gnId binding
                    , geTarget   = mid
                    , geType     = "IMPORTS_FROM"
                    , geMetadata = Map.empty
                    }
                ]
              [] -> []

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

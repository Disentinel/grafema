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
--
-- Phase 2: Resolve IMPORT_BINDING nodes to declarations (IMPORTS_FROM edges).
--   - "from foo import bar" → look up (foo, bar) in name index
--   - "from foo import bar" where bar is a submodule → look up "foo.bar" in module index
--   - "import foo" → look up "foo" in module index
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
buildNameIndex :: [GraphNode] -> ModuleIndex -> NameIndex
buildNameIndex nodes modIdx = foldl' go Map.empty nodes
  where
    go acc n
      | gnType n `elem` ["FUNCTION", "CLASS", "VARIABLE"] =
          case Map.lookup (gnFile n) modIdx of
            Just (_, modPath) ->
              Map.insert (modPath, gnName n) (gnFile n, gnId n) acc
            Nothing -> acc
      | otherwise = acc

-- | Get a text metadata value from a node.
getMetaText :: Text -> GraphNode -> Maybe Text
getMetaText key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaText t) | not (T.null t) -> Just t
    _                                  -> Nothing

-- | Resolve all IMPORT_BINDING nodes.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let modIdx  = buildModuleIndex nodes
      nameIdx = buildNameIndex nodes modIdx
      importBindings = filter (\n -> gnType n == "IMPORT_BINDING") nodes

  let edges = concatMap (resolveBinding modIdx nameIdx) importBindings

  hPutStrLn stderr $
    "python-resolve: " ++ show (length edges) ++ " import edges"

  return edges

resolveBinding :: ModuleIndex -> NameIndex -> GraphNode -> [PluginCommand]
resolveBinding modIdx nameIdx binding =
  let importedName = case getMetaText "imported_name" binding of
        Just n  -> n
        Nothing -> gnName binding
      sourcePath = getMetaText "source_module" binding
  in case sourcePath of
       Just modPath ->
         -- from foo import bar -> look up (foo, bar) in name index
         case Map.lookup (modPath, importedName) nameIdx of
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

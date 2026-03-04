{-# LANGUAGE OverloadedStrings #-}
-- | Rust import resolution plugin.
--
-- Resolves Rust @use@ imports to their target files and declarations.
-- Uses file-based module paths (@crate::foo::bar@) rather than symbolic
-- module names like Haskell.
--
-- == Module System
--
-- Rust modules correspond to files:
--
-- * @src\/lib.rs@ or @src\/main.rs@ -> crate root (@crate@)
-- * @src\/foo.rs@ or @src\/foo\/mod.rs@ -> @crate::foo@
-- * @src\/foo\/bar.rs@ or @src\/foo\/bar\/mod.rs@ -> @crate::foo::bar@
--
-- == Resolution Algorithm
--
-- Phase 1: Build indexes from all nodes.
--   - Module index: file path -> MODULE node ID
--   - Export index: file path -> [ExportEntry] (pub items only)
--   - Module tree: module path (e.g. @crate::foo::bar@) -> file path
--
-- Phase 2: Resolve IMPORT nodes to MODULE nodes (IMPORTS_FROM edges).
--
-- Phase 3: Resolve IMPORT_BINDING nodes to exported declarations
--   (IMPORTS_FROM edges) using the @source@ metadata field.
--
-- External crate imports (@std::*@, third-party crates) are silently skipped.
module RustImportResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import System.IO (hPutStrLn, stderr)

-- | Module index: file path -> MODULE node ID.
type ModuleIndex = Map Text Text

-- | An exported name with its node ID.
data ExportEntry = ExportEntry
  { exName   :: !Text
  , exNodeId :: !Text
  } deriving (Show, Eq)

-- | Export index: file path -> list of exported entries.
type ExportIndex = Map Text [ExportEntry]

-- | Module tree: module path (like @crate::foo::bar@) -> file path.
type ModuleTree = Map Text Text

-- | Build module index from MODULE nodes.
--
-- Scans all nodes for @gnType == "MODULE"@ and maps @gnFile@ to @gnId@.
-- In Rust, each file is a module, so we key by file path (not module name).
buildModuleIndex :: [GraphNode] -> ModuleIndex
buildModuleIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "MODULE" = Map.insert (gnFile n) (gnId n) acc
      | otherwise = acc

-- | Build export index from all nodes.
--
-- In Rust, only @pub@ items are exported. We check @gnExported == True@
-- for declaration node types.
buildExportIndex :: [GraphNode] -> ExportIndex
buildExportIndex nodes =
  let -- Declaration types that can be exported in Rust
      declTypes :: [Text]
      declTypes =
        [ "FUNCTION", "VARIABLE", "STRUCT", "ENUM", "VARIANT"
        , "TRAIT", "IMPL_BLOCK", "TYPE_ALIAS", "DATA_TYPE"
        ]

      -- Only pub items (gnExported == True) are visible outside the module
      exports :: [(Text, ExportEntry)]
      exports =
        [ (gnFile n, ExportEntry (gnName n) (gnId n))
        | n <- nodes
        , gnExported n
        , gnType n `elem` declTypes
        ]

  in Map.fromListWith (++) [ (f, [e]) | (f, e) <- exports ]

-- | Build module tree from MODULE nodes.
--
-- Maps Rust module paths to file paths, e.g.:
--
-- * @\"crate\"@ -> @\"src\/lib.rs\"@
-- * @\"crate::foo\"@ -> @\"src\/foo.rs\"@
-- * @\"crate::foo::bar\"@ -> @\"src\/foo\/bar.rs\"@
buildModuleTree :: [GraphNode] -> ModuleTree
buildModuleTree nodes =
  let moduleNodes = filter (\n -> gnType n == "MODULE") nodes
  in Map.fromList $ concatMap nodeToModulePaths moduleNodes

-- | Generate module path variants for a file.
--
-- @\"src\/foo\/bar.rs\"@ -> @[(\"crate::foo::bar\", \"src\/foo\/bar.rs\")]@
-- @\"src\/foo\/mod.rs\"@ -> @[(\"crate::foo\", \"src\/foo\/mod.rs\")]@
-- @\"src\/lib.rs\"@ -> @[(\"crate\", \"src\/lib.rs\")]@
-- @\"src\/main.rs\"@ -> @[(\"crate\", \"src\/main.rs\")]@
nodeToModulePaths :: GraphNode -> [(Text, Text)]
nodeToModulePaths node =
  let path = gnFile node
      -- Strip src/ prefix if present
      stripped = case T.stripPrefix "src/" path of
        Just rest -> rest
        Nothing   -> path
      -- Convert to module path segments by splitting on /
      segments = T.splitOn "/" stripped
      -- Remove .rs extension from last segment
      withoutExt = case segments of
        [] -> []
        xs -> init xs ++ [T.replace ".rs" "" (last xs)]
      -- Handle special files:
      --   mod.rs -> parent module
      --   lib.rs -> crate root
      --   main.rs -> crate root
      cleanSegments = case withoutExt of
        xs | not (null xs) && last xs == "mod"  -> init xs
        xs | not (null xs) && last xs == "lib"  -> []
        xs | not (null xs) && last xs == "main" -> []
        xs -> xs
      modulePath = "crate" <>
        (if null cleanSegments
         then ""
         else "::" <> T.intercalate "::" cleanSegments)
  in [(modulePath, path)]

-- | Resolve a single IMPORT node to its target MODULE.
--
-- The IMPORT node's @gnName@ contains the full module path
-- (e.g. @\"crate::foo\"@). We look it up in the module tree
-- to find the file, then in the module index to find the MODULE node.
-- External crates (not in the tree) are silently skipped.
resolveImportModule :: ModuleTree -> ModuleIndex -> GraphNode -> [PluginCommand]
resolveImportModule moduleTree moduleIdx node =
  let importPath = gnName node  -- e.g. "crate::foo" or "std::io"
      -- Try to find in module tree, then look up the MODULE node
      targetNodeId = do
        filePath <- Map.lookup importPath moduleTree
        Map.lookup filePath moduleIdx
  in case targetNodeId of
    Just moduleNodeId ->
      [ EmitEdge GraphEdge
          { geSource   = gnId node
          , geTarget   = moduleNodeId
          , geType     = "IMPORTS_FROM"
          , geMetadata = Map.empty
          }
      ]
    Nothing -> []  -- external crate, skip

-- | Resolve a single IMPORT_BINDING node to its exported declaration.
--
-- 1. Read the @source@ metadata field (e.g. @\"crate::foo::Bar\"@).
-- 2. Extract module path by taking all segments except the last.
-- 3. Look up the module path in the module tree to get the file.
-- 4. Look up the binding name in that file's export index.
-- 5. Emit an IMPORTS_FROM edge if found.
resolveBinding :: ModuleTree -> ExportIndex -> GraphNode -> [PluginCommand]
resolveBinding moduleTree exportIdx node =
  let bindingName = gnName node
      -- Extract the source path from metadata
      mSource = case Map.lookup "source" (gnMetadata node) of
        Just (MetaText s) -> Just s
        _                 -> Nothing
      -- Parse the source to get the module path (all but last segment)
      mModulePath = mSource >>= \source ->
        let segments = T.splitOn "::" source
        in if length segments >= 2
           then Just (T.intercalate "::" (init segments))
           else Nothing
  in case mModulePath of
    Just modulePath ->
      case Map.lookup modulePath moduleTree of
        Just filePath ->
          case Map.lookup filePath exportIdx of
            Just exports ->
              case filter (\e -> exName e == bindingName) exports of
                (entry : _) ->
                  [ EmitEdge GraphEdge
                      { geSource   = gnId node
                      , geTarget   = exNodeId entry
                      , geType     = "IMPORTS_FROM"
                      , geMetadata = Map.empty
                      }
                  ]
                [] -> []
            Nothing -> []
        Nothing -> []  -- external crate, skip
    Nothing -> []

-- | Core resolution logic.
--
-- Given all graph nodes from the analyzed project, resolves:
--
-- 1. IMPORT -> MODULE edges (module-level imports)
-- 2. IMPORT_BINDING -> declaration edges (name-level imports)
--
-- Returns a list of 'PluginCommand's (EmitEdge) to be sent to the
-- orchestrator.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let moduleIdx  = buildModuleIndex nodes
      exportIdx  = buildExportIndex nodes
      moduleTree = buildModuleTree nodes

      importNodes    = filter (\n -> gnType n == "IMPORT") nodes
      bindingNodes   = filter (\n -> gnType n == "IMPORT_BINDING") nodes

  -- Phase 2: Resolve IMPORT -> MODULE
  let moduleEdges = concatMap (resolveImportModule moduleTree moduleIdx) importNodes

  -- Phase 3: Resolve IMPORT_BINDING -> declaration
  let bindingEdges = concatMap (resolveBinding moduleTree exportIdx) bindingNodes

  hPutStrLn stderr $
    "rust-resolve: " ++ show (length moduleEdges) ++ " module edges, "
      ++ show (length bindingEdges) ++ " binding edges"

  return (moduleEdges ++ bindingEdges)

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

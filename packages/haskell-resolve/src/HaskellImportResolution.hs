{-# LANGUAGE OverloadedStrings #-}
-- | Haskell import resolution plugin.
--
-- Resolves Haskell module imports to their target files and declarations.
-- Uses module names (Data.Map.Strict) rather than file paths (./data/map).
--
-- == Resolution Algorithm
--
-- Phase 1: Build indexes from all nodes.
--   - Module index: module name -> (file path, MODULE node ID)
--   - Export index: file path -> [ExportEntry]
--     If a file has EXPORT_BINDING nodes, only those are exported.
--     If a file has NO EXPORT_BINDING nodes, all top-level declarations are exported.
--
-- Phase 2: Resolve IMPORT nodes to MODULE nodes (IMPORTS_FROM edges).
--
-- Phase 3: Resolve IMPORT_BINDING nodes to exported declarations (IMPORTS_FROM edges).
module HaskellImportResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Set (Set)
import System.IO (hPutStrLn, stderr)

-- | Module index: module name -> (file path, MODULE node ID).
type ModuleIndex = Map Text (Text, Text)

-- | An exported name with its node ID.
data ExportEntry = ExportEntry
  { exName   :: !Text
  , exNodeId :: !Text
  } deriving (Show, Eq)

-- | Export index: file path -> list of exported entries.
type ExportIndex = Map Text [ExportEntry]

-- | Build module index from MODULE nodes.
--
-- Scans all nodes for @gnType == "MODULE"@ and maps @gnName@ to
-- @(gnFile, gnId)@.
buildModuleIndex :: [GraphNode] -> ModuleIndex
buildModuleIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "MODULE" = Map.insert (gnName n) (gnFile n, gnId n) acc
      | otherwise = acc

-- | Build export index from all nodes.
--
-- Key insight: if a file has ANY EXPORT_BINDING nodes, only those names
-- are exported. If a file has NO EXPORT_BINDING nodes, all top-level
-- declarations are exported (implicit export-all).
buildExportIndex :: [GraphNode] -> ExportIndex
buildExportIndex nodes =
  let -- Collect files that have explicit exports
      filesWithExplicitExports :: Set Text
      filesWithExplicitExports = Set.fromList
        [ gnFile n | n <- nodes, gnType n == "EXPORT_BINDING" ]

      -- Explicit exports: EXPORT_BINDING nodes
      explicitExports :: [(Text, ExportEntry)]
      explicitExports =
        [ (gnFile n, ExportEntry (gnName n) (gnId n))
        | n <- nodes, gnType n == "EXPORT_BINDING"
        ]

      -- Declaration types that can be implicitly exported
      declTypes :: Set Text
      declTypes = Set.fromList
        [ "FUNCTION", "VARIABLE", "DATA_TYPE", "TYPE_CLASS"
        , "TYPE_SYNONYM", "TYPE_FAMILY", "CONSTRUCTOR", "TYPE_SIGNATURE"
        ]

      -- Implicit exports: top-level declarations in files WITHOUT explicit exports
      implicitExports :: [(Text, ExportEntry)]
      implicitExports =
        [ (gnFile n, ExportEntry (gnName n) (gnId n))
        | n <- nodes
        , Set.member (gnType n) declTypes
        , not (Set.member (gnFile n) filesWithExplicitExports)
        ]

      allExports :: [(Text, ExportEntry)]
      allExports = explicitExports ++ implicitExports

  in Map.fromListWith (++) [ (f, [e]) | (f, e) <- allExports ]

-- | Extract module name from an IMPORT_BINDING semantic ID.
--
-- The ID format is:
--
-- > file->IMPORT_BINDING->name[in:ModuleName]
-- > file->IMPORT_BINDING->name[in:ModuleName,h:line:col]
--
-- Returns 'Nothing' if the format doesn't match.
extractModuleFromBinding :: GraphNode -> Maybe Text
extractModuleFromBinding node =
  case T.breakOn "[in:" (gnId node) of
    (_, rest)
      | T.null rest -> Nothing
      | otherwise ->
          let afterPrefix = T.drop 4 rest  -- drop "[in:"
              (beforeClose, _) = T.breakOn "]" afterPrefix
              -- Strip possible ",h:..." suffix
              (cleanParent, _) = T.breakOn ",h:" beforeClose
          in if T.null cleanParent then Nothing else Just cleanParent

-- | Resolve a single IMPORT node to its MODULE node.
--
-- Looks up the module name in the module index. External packages
-- (not in the index) are silently skipped.
resolveImport :: ModuleIndex -> GraphNode -> [PluginCommand]
resolveImport moduleIdx node =
  case Map.lookup (gnName node) moduleIdx of
    Just (_filePath, moduleNodeId) ->
      [ EmitEdge GraphEdge
          { geSource   = gnId node
          , geTarget   = moduleNodeId
          , geType     = "IMPORTS_FROM"
          , geMetadata = Map.empty
          }
      ]
    Nothing -> []  -- external package, skip

-- | Resolve a single IMPORT_BINDING node to its exported declaration.
--
-- 1. Extract parent module name from the binding's semantic ID.
-- 2. Look up module name in module index to get file path.
-- 3. Look up the imported name in that file's export index.
-- 4. Emit IMPORTS_FROM edge if found.
resolveBinding :: ModuleIndex -> ExportIndex -> GraphNode -> IO [PluginCommand]
resolveBinding moduleIdx exportIdx node =
  case extractModuleFromBinding node of
    Nothing -> do
      hPutStrLn stderr $
        "Warning: no module name in IMPORT_BINDING " ++ T.unpack (gnId node)
      return []
    Just moduleName ->
      case Map.lookup moduleName moduleIdx of
        Nothing -> return []  -- external package, skip silently
        Just (filePath, _) ->
          case Map.lookup filePath exportIdx of
            Nothing -> do
              hPutStrLn stderr $
                "Warning: no exports found for " ++ T.unpack filePath
              return []
            Just exports ->
              case filter (\e -> exName e == gnName node) exports of
                (entry : _) ->
                  return
                    [ EmitEdge GraphEdge
                        { geSource   = gnId node
                        , geTarget   = exNodeId entry
                        , geType     = "IMPORTS_FROM"
                        , geMetadata = Map.empty
                        }
                    ]
                [] -> do
                  hPutStrLn stderr $
                    "Warning: no export '" ++ T.unpack (gnName node)
                      ++ "' in " ++ T.unpack filePath
                  return []

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
  let moduleIdx = buildModuleIndex nodes
      exportIdx = buildExportIndex nodes
      importNodes  = filter (\n -> gnType n == "IMPORT") nodes
      bindingNodes = filter (\n -> gnType n == "IMPORT_BINDING") nodes

  -- Phase 2: Resolve IMPORT -> MODULE
  let moduleEdges = concatMap (resolveImport moduleIdx) importNodes

  -- Phase 3: Resolve IMPORT_BINDING -> declaration
  bindingEdges <- concat <$> mapM (resolveBinding moduleIdx exportIdx) bindingNodes

  hPutStrLn stderr $
    "haskell-resolve: " ++ show (length moduleEdges) ++ " module edges, "
      ++ show (length bindingEdges) ++ " binding edges"

  return (moduleEdges ++ bindingEdges)

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

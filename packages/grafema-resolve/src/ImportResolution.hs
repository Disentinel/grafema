{-# LANGUAGE OverloadedStrings #-}
-- | JS/TS import resolution plugin.
--
-- Reads all graph nodes from stdin (NDJSON), matches IMPORT_BINDING nodes
-- to exported declarations by module path + name, and emits IMPORTS_FROM edges.
--
-- The orchestrator pipes all relevant nodes: IMPORT, IMPORT_BINDING,
-- EXPORT, EXPORT_BINDING, and exported declarations (FUNCTION, VARIABLE, etc.).
module ImportResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import Data.List (foldl')
import Data.Maybe (fromMaybe)
import qualified Data.Set as Set
import Data.Set (Set)
import System.IO (hPutStrLn, stderr)

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

-- | An entry in the export index: exported name, node ID, whether it's a
--   re-export (and if so, the source module specifier).
data ExportEntry = ExportEntry
  { eeName      :: !Text    -- ^ exported name (e.g., "foo", "default", "*")
  , eeLocalName :: !Text    -- ^ local/original name to look up in source module for re-exports
  , eeNodeId    :: !Text    -- ^ ID of the node that defines this export
  , eeReExport  :: !(Maybe Text)
    -- ^ If this is a re-export, the source module specifier to follow
  } deriving (Show, Eq)

-- | Export index: file path -> list of export entries for that file.
type ExportIndex = Map Text [ExportEntry]

-- | Maximum depth for re-export chain following.
maxReExportDepth :: Int
maxReExportDepth = 10

-- ---------------------------------------------------------------------------
-- Export index construction
-- ---------------------------------------------------------------------------

-- | Build an export index from all graph nodes.
--
-- Sources of export information:
--
-- 1. EXPORT_BINDING nodes (explicit `export { foo }` or `export { foo as bar }`).
--    These have gnExported=True and metadata.exportedName.
--
-- 2. Nodes with gnExported=True that are EXPORT nodes with gnName="default"
--    indicate default exports. The actual exported value is linked via EXPORTS
--    edges, but since we only have nodes (not edges), we track the EXPORT node
--    itself and resolve via its ID.
--
-- 3. Declarations (FUNCTION, VARIABLE, CONSTANT, CLASS) with gnExported=True
--    are directly exported.
--
-- 4. EXPORT nodes with gnName starting with "*:" are star re-exports
--    (export * from 'source').
buildExportIndex :: [GraphNode] -> ExportIndex
buildExportIndex nodes =
  let entries = concatMap nodeToExportEntries nodes
  in Map.fromListWith (++) entries

-- | Extract export entries from a single node, returning (filePath, [entries]).
nodeToExportEntries :: GraphNode -> [(Text, [ExportEntry])]
nodeToExportEntries node
  -- EXPORT_BINDING: explicit export specifier (export { foo } or export { foo as bar } from './src')
  | gnType node == "EXPORT_BINDING" =
      let exportedName = lookupMetaText "exportedName" (gnMetadata node)
          name = fromMaybe (gnName node) exportedName
          localName = gnName node  -- original name to look up in source module
          reExportSource = lookupMetaText "source" (gnMetadata node)
      in [(gnFile node, [ExportEntry name localName (gnId node) reExportSource])]

  -- EXPORT node with name "default": default export
  | gnType node == "EXPORT" && gnName node == "default" =
      [(gnFile node, [ExportEntry "default" "default" (gnId node) Nothing])]

  -- EXPORT node with name "*:source": star re-export
  | gnType node == "EXPORT" && "*:" `T.isPrefixOf` gnName node =
      let source = T.drop 2 (gnName node)
      in [(gnFile node, [ExportEntry "*" "*" (gnId node) (Just source)])]

  -- EXPORT node with name "named": skip (container node, children carry info)
  | gnType node == "EXPORT" = []

  -- Directly exported declarations (FUNCTION, VARIABLE, CONSTANT, CLASS)
  | gnExported node && gnType node `elem` ["FUNCTION", "VARIABLE", "CONSTANT", "CLASS"] =
      [(gnFile node, [ExportEntry (gnName node) (gnName node) (gnId node) Nothing])]

  | otherwise = []

-- ---------------------------------------------------------------------------
-- Import source extraction
-- ---------------------------------------------------------------------------

-- | Extract the import source specifier from an IMPORT_BINDING node.
--
-- Strategy: parse the semantic ID to extract the [in:parent] suffix,
-- where parent is the import source specifier. The semantic ID format is:
--   file->IMPORT_BINDING->localName[in:source]
--
-- Fallback: look for a "source" metadata field (in case the format changes).
extractImportSource :: GraphNode -> Maybe Text
extractImportSource node =
  case lookupMetaText "source" (gnMetadata node) of
    Just src -> Just src
    Nothing  -> extractParentFromId (gnId node)

-- | Parse the [in:parent] part from a semantic ID.
-- Example: "test.js->IMPORT_BINDING->foo[in:./utils]" -> Just "./utils"
extractParentFromId :: Text -> Maybe Text
extractParentFromId sid =
  case T.breakOn "[in:" sid of
    (_, rest)
      | T.null rest -> Nothing
      | otherwise ->
          let afterPrefix = T.drop 4 rest  -- drop "[in:"
              -- Handle possible ",h:xxxx]" suffix
              (parent, _) = T.breakOn "]" afterPrefix
              -- Strip any ",h:..." suffix
              (cleanParent, _) = T.breakOn ",h:" parent
          in if T.null cleanParent then Nothing else Just cleanParent

-- | Extract the imported name from an IMPORT_BINDING node's metadata.
extractImportedName :: GraphNode -> Maybe Text
extractImportedName node = lookupMetaText "importedName" (gnMetadata node)

-- ---------------------------------------------------------------------------
-- Module path resolution
-- ---------------------------------------------------------------------------

-- | Try to resolve a module specifier to a file path present in the export index.
--
-- For relative imports (starting with "." or ".."):
--   1. Resolve relative to the importing file's directory
--   2. Try the exact path (if already has extension)
--   3. Try with extensions: .js, .ts, .tsx, .jsx
--   4. Try as directory with index: /index.js, /index.ts, /index.tsx, /index.jsx
--
-- For bare specifiers (e.g., "lodash", "react"): skip (future enhancement).
resolveModulePath :: Text -> Text -> ExportIndex -> Maybe Text
resolveModulePath importerFile specifier exportIndex
  -- Skip bare specifiers (no ./  or ../)
  | not (isRelativeSpecifier specifier) = Nothing
  | otherwise =
      let dir = textDirname importerFile
          resolved = resolveRelative dir specifier
          candidates = makeCandidates resolved
      in firstJust (\c -> if Map.member c exportIndex then Just c else Nothing) candidates

-- | Check if a module specifier is relative (starts with "./" or "../").
isRelativeSpecifier :: Text -> Bool
isRelativeSpecifier s = "./" `T.isPrefixOf` s || "../" `T.isPrefixOf` s

-- | Resolve a relative path against a directory.
-- Example: resolveRelative "src/components" "./utils" -> "src/components/utils"
--          resolveRelative "src/components" "../lib" -> "src/lib"
resolveRelative :: Text -> Text -> Text
resolveRelative dir specifier =
  let parts = filter (not . T.null) $ T.splitOn "/" dir
      specParts = filter (not . T.null) $ T.splitOn "/" specifier
      resolved = normalizeParts (parts ++ specParts)
  in T.intercalate "/" resolved

-- | Normalize path parts, resolving "." and "..".
normalizeParts :: [Text] -> [Text]
normalizeParts = go []
  where
    go acc [] = reverse acc
    go acc ("." : rest) = go acc rest
    go (_:acc) (".." : rest) = go acc rest
    go [] (".." : rest) = go [] rest  -- beyond root, drop
    go acc (p : rest) = go (p : acc) rest

-- | Generate candidate file paths for a resolved module path.
-- Tries the exact path, then with extensions, then as index files.
makeCandidates :: Text -> [Text]
makeCandidates resolved =
  let extensions = [".js", ".ts", ".tsx", ".jsx"]
      -- If already has a known extension, try exact first
      exact = [resolved | hasKnownExtension resolved]
      -- Try adding extensions
      withExt = [resolved <> ext | ext <- extensions]
      -- Try as directory with index file
      indexFiles = [resolved <> "/index" <> ext | ext <- extensions]
  in exact ++ withExt ++ indexFiles

-- | Check if a path already has a known JS/TS extension.
hasKnownExtension :: Text -> Bool
hasKnownExtension p = any (`T.isSuffixOf` p)
  [".js", ".ts", ".tsx", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]

-- ---------------------------------------------------------------------------
-- Import resolution
-- ---------------------------------------------------------------------------

-- | Resolve a single IMPORT_BINDING node to its target export.
-- Returns a list of PluginCommands (0 or 1 edges).
resolveImport :: ExportIndex -> Set (Text, Text) -> Int -> GraphNode -> IO [PluginCommand]
resolveImport exportIndex visited depth node
  | depth > maxReExportDepth = do
      hPutStrLn stderr $ "Warning: re-export chain depth exceeded for "
        ++ T.unpack (gnId node)
      return []
  | otherwise = do
      let mSource = extractImportSource node
          mImportedName = extractImportedName node
      case (mSource, mImportedName) of
        (Nothing, _) -> do
          hPutStrLn stderr $ "Warning: no source for IMPORT_BINDING "
            ++ T.unpack (gnId node)
          return []
        (_, Nothing) -> do
          hPutStrLn stderr $ "Warning: no importedName for IMPORT_BINDING "
            ++ T.unpack (gnId node)
          return []
        (Just source, Just importedName) ->
          resolveImportWithSource exportIndex visited depth node source importedName

-- | Resolve an import once we have the source and imported name.
resolveImportWithSource
  :: ExportIndex -> Set (Text, Text) -> Int
  -> GraphNode -> Text -> Text -> IO [PluginCommand]
resolveImportWithSource exportIndex visited depth node source importedName = do
  let importerFile = gnFile node
      mResolvedFile = resolveModulePath importerFile source exportIndex
  case mResolvedFile of
    Nothing -> do
      -- Could be a bare specifier or unresolvable path
      if isRelativeSpecifier source
        then hPutStrLn stderr $ "Warning: cannot resolve module '"
               ++ T.unpack source ++ "' from " ++ T.unpack importerFile
        else return ()  -- bare specifier, silently skip
      return []
    Just resolvedFile
      -- Namespace import (import * as X): resolve to MODULE node
      | importedName == "*" ->
          let moduleId = "MODULE#" <> resolvedFile
          in return [emitImportsFrom (gnId node) moduleId]
      | otherwise ->
          resolveFromFile exportIndex visited depth node resolvedFile importedName

-- | Resolve an import from a specific resolved file.
resolveFromFile
  :: ExportIndex -> Set (Text, Text) -> Int
  -> GraphNode -> Text -> Text -> IO [PluginCommand]
resolveFromFile exportIndex visited depth node resolvedFile importedName = do
  let key = (resolvedFile, importedName)
  if Set.member key visited
    then do
      hPutStrLn stderr $ "Warning: re-export cycle detected at ("
        ++ T.unpack resolvedFile ++ ", " ++ T.unpack importedName ++ ")"
      return []
    else do
      let visited' = Set.insert key visited
          exports = fromMaybe [] (Map.lookup resolvedFile exportIndex)
      case findMatchingExport importedName exports of
        Just entry -> handleExportEntry exportIndex visited' depth node entry
        Nothing ->
          -- Try star re-exports: look for "*" exports that re-export from another module
          case findStarReExports exports of
            [] -> do
              hPutStrLn stderr $ "Warning: no matching export '"
                ++ T.unpack importedName ++ "' in " ++ T.unpack resolvedFile
              return []
            reExports -> tryStarReExports exportIndex visited' depth node importedName reExports

-- | Find a matching export entry by name.
findMatchingExport :: Text -> [ExportEntry] -> Maybe ExportEntry
findMatchingExport name exports =
  case filter (\e -> eeName e == name) exports of
    (e:_) -> Just e
    []    -> Nothing

-- | Find all star re-export entries ("*" exports with a source).
findStarReExports :: [ExportEntry] -> [ExportEntry]
findStarReExports = filter (\e -> eeName e == "*" && eeReExport e /= Nothing)

-- | Handle a matched export entry, possibly following re-export chains.
handleExportEntry
  :: ExportIndex -> Set (Text, Text) -> Int
  -> GraphNode -> ExportEntry -> IO [PluginCommand]
handleExportEntry exportIndex visited depth node entry =
  case eeReExport entry of
    Nothing ->
      -- Direct export: emit the IMPORTS_FROM edge
      return [emitImportsFrom (gnId node) (eeNodeId entry)]
    Just reExportSource ->
      -- Re-export: follow the chain using the LOCAL name (e.g., "default" not "Calc")
      let importerFile = gnFile node
          mResolvedFile = resolveModulePath importerFile reExportSource exportIndex
      in case mResolvedFile of
        Nothing -> do
          hPutStrLn stderr $ "Warning: cannot resolve re-export source '"
            ++ T.unpack reExportSource ++ "'"
          return []
        Just resolvedFile ->
          resolveFromFile exportIndex visited (depth + 1) node resolvedFile (eeLocalName entry)

-- | Try resolving through star re-exports.
tryStarReExports
  :: ExportIndex -> Set (Text, Text) -> Int
  -> GraphNode -> Text -> [ExportEntry] -> IO [PluginCommand]
tryStarReExports _ _ _ _ _ [] = return []
tryStarReExports exportIndex visited depth node importedName (entry:rest) =
  case eeReExport entry of
    Nothing -> tryStarReExports exportIndex visited depth node importedName rest
    Just reExportSource -> do
      let importerFile = gnFile node
          mResolvedFile = resolveModulePath importerFile reExportSource exportIndex
      case mResolvedFile of
        Nothing ->
          tryStarReExports exportIndex visited depth node importedName rest
        Just resolvedFile -> do
          result <- resolveFromFile exportIndex visited (depth + 1) node resolvedFile importedName
          case result of
            [] -> tryStarReExports exportIndex visited depth node importedName rest
            cmds -> return cmds

-- ---------------------------------------------------------------------------
-- Edge emission
-- ---------------------------------------------------------------------------

-- | Create an IMPORTS_FROM edge command.
emitImportsFrom :: Text -> Text -> PluginCommand
emitImportsFrom srcId dstId = EmitEdge GraphEdge
  { geSource   = srcId
  , geTarget   = dstId
  , geType     = "IMPORTS_FROM"
  , geMetadata = Map.empty
  }

-- ---------------------------------------------------------------------------
-- Metadata helpers
-- ---------------------------------------------------------------------------

-- | Look up a text value in metadata.
lookupMetaText :: Text -> Map Text MetaValue -> Maybe Text
lookupMetaText key meta = case Map.lookup key meta of
  Just (MetaText t) -> Just t
  _                 -> Nothing

-- | Get the directory part of a file path (text-based).
-- Example: "src/components/Button.js" -> "src/components"
--          "index.js" -> ""
textDirname :: Text -> Text
textDirname path =
  let parts = T.splitOn "/" path
  in case parts of
    []  -> ""
    [_] -> ""
    _   -> T.intercalate "/" (init parts)

-- | Find the first element that satisfies a predicate, returning the result.
firstJust :: (a -> Maybe b) -> [a] -> Maybe b
firstJust _ [] = Nothing
firstJust f (x:xs) = case f x of
  Just y  -> Just y
  Nothing -> firstJust f xs

-- ---------------------------------------------------------------------------
-- Main entry point
-- ---------------------------------------------------------------------------

-- | Core import resolution logic, operating on a list of nodes.
--
-- Two phases:
-- 1. Per-binding: IMPORT_BINDING → target export (FUNCTION, CONSTANT, etc.)
-- 2. Module-level: IMPORT → MODULE (resolves module specifier to target module)
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let exportIndex = buildExportIndex nodes
      importBindings = filter (\n -> gnType n == "IMPORT_BINDING") nodes
  bindingEdges <- concat <$> mapM (resolveImport exportIndex Set.empty 0) importBindings
  let moduleEdges = resolveModuleImports nodes exportIndex
  return (bindingEdges ++ moduleEdges)

-- ---------------------------------------------------------------------------
-- Module-level import resolution (IMPORT → MODULE)
-- ---------------------------------------------------------------------------

-- | Build a module index: file path → MODULE node ID.
type ModuleIndex = Map Text Text

buildModuleIndex :: [GraphNode] -> ModuleIndex
buildModuleIndex = foldl' addModule Map.empty
  where
    addModule acc n
      | gnType n == "MODULE" = Map.insert (gnFile n) (gnId n) acc
      | otherwise = acc

-- | Resolve IMPORT nodes to their target MODULE nodes.
--
-- For each unique IMPORT node, resolve its source specifier to a file path,
-- look up the MODULE node for that file, and emit an IMPORTS_FROM edge.
resolveModuleImports :: [GraphNode] -> ExportIndex -> [PluginCommand]
resolveModuleImports nodes exportIndex =
  let moduleIndex = buildModuleIndex nodes
      importNodes = filter (\n -> gnType n == "IMPORT") nodes
      -- Deduplicate by node ID (multiple import statements with same source
      -- produce IMPORT nodes with the same semantic ID)
      uniqueImports = Map.elems $ Map.fromList
        [ (gnId n, n) | n <- importNodes ]
  in concatMap (resolveModuleImport moduleIndex exportIndex) uniqueImports

resolveModuleImport :: ModuleIndex -> ExportIndex -> GraphNode -> [PluginCommand]
resolveModuleImport moduleIndex exportIndex node =
  let source = gnName node  -- IMPORT node name is the source specifier
      importerFile = gnFile node
      mResolvedFile = resolveModulePath importerFile source exportIndex
  in case mResolvedFile of
    Nothing -> []
    Just resolvedFile ->
      case Map.lookup resolvedFile moduleIndex of
        Just moduleId ->
          [EmitEdge GraphEdge
            { geSource = gnId node
            , geTarget = moduleId
            , geType   = "IMPORTS_FROM"
            , geMetadata = Map.singleton "resolvedPath" (MetaText resolvedFile)
            }]
        Nothing -> []

-- | Run the import resolution plugin.
--
-- 1. Read all graph nodes from stdin (NDJSON)
-- 2. Build export index from exported nodes
-- 3. For each IMPORT_BINDING node, resolve to its target export
-- 4. Emit IMPORTS_FROM edges to stdout
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

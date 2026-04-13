{-# LANGUAGE OverloadedStrings #-}
-- | Haskell cross-module call resolution.
--
-- Resolves CALL nodes to their target FUNCTION nodes in other files via
-- the import chain. For each unresolved CALL @foo@ in file @F@:
--
-- 1. Find an IMPORT_BINDING with name @foo@ in file @F@
-- 2. Extract the source module name from the binding's semantic ID
-- 3. Look up that module's exports for a declaration named @foo@
-- 4. Emit a CALLS edge from the CALL node to the declaration
--
-- This uses pure graph traversal (no derived metadata) — the receiver
-- type concept doesn't apply to Haskell, but the import binding chain
-- gives us a deterministic resolution path.
module HaskellCrossModuleCalls (run, resolveAll) where

import Grafema.Types (GraphNode(..), gnSemanticId, GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import Data.Set (Set)
import System.IO (hPutStrLn, stderr)

-- ---------------------------------------------------------------------------
-- Indexes (mirroring HaskellImportResolution)
-- ---------------------------------------------------------------------------

-- | Module name → (file, MODULE node ID).
type ModuleIndex = Map Text (Text, Text)

data ExportEntry = ExportEntry
  { exName   :: !Text
  , exNodeId :: !Text
  } deriving (Show, Eq)

-- | File path → list of exported names with target node IDs.
type ExportIndex = Map Text [ExportEntry]

-- | (file, name) → IMPORT_BINDING node. Used to find the source module
-- of a name used in a CALL.
type BindingIndex = Map (Text, Text) GraphNode

buildModuleIndex :: [GraphNode] -> ModuleIndex
buildModuleIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "MODULE" = Map.insert (gnName n) (gnFile n, gnId n) acc
      | otherwise = acc

-- | Same logic as HaskellImportResolution.buildExportIndex.
buildExportIndex :: [GraphNode] -> ExportIndex
buildExportIndex nodes =
  let filesWithExplicitExports :: Set Text
      filesWithExplicitExports = Set.fromList
        [ gnFile n | n <- nodes, gnType n == "EXPORT_BINDING" ]

      explicitExports :: [(Text, ExportEntry)]
      explicitExports =
        [ (gnFile n, ExportEntry (gnName n) (gnId n))
        | n <- nodes, gnType n == "EXPORT_BINDING"
        ]

      declTypes :: Set Text
      declTypes = Set.fromList
        [ "FUNCTION", "VARIABLE", "DATA_TYPE", "TYPE_CLASS"
        , "TYPE_SYNONYM", "TYPE_FAMILY", "CONSTRUCTOR", "TYPE_SIGNATURE"
        ]

      implicitExports :: [(Text, ExportEntry)]
      implicitExports =
        [ (gnFile n, ExportEntry (gnName n) (gnId n))
        | n <- nodes
        , Set.member (gnType n) declTypes
        , not (Set.member (gnFile n) filesWithExplicitExports)
        ]

      allExports = explicitExports ++ implicitExports
  in Map.fromListWith (++) [ (f, [e]) | (f, e) <- allExports ]

buildBindingIndex :: [GraphNode] -> BindingIndex
buildBindingIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), n)
    | n <- nodes
    , gnType n == "IMPORT_BINDING"
    , not (T.null (gnName n))
    ]

-- | Extract module name from IMPORT_BINDING semantic ID.
-- Format: @file->IMPORT_BINDING->name[in:ModuleName]@ (legacy)
-- or       @file->IMPORT_BINDING->name[in:ModuleName,h:line:col]@
--
-- Both URL-encoded and plain forms supported.
extractModuleFromBinding :: GraphNode -> Maybe Text
extractModuleFromBinding node =
  let sid = gnSemanticId node
      tryMarker marker stopMarker = case T.breakOn marker sid of
        (_, rest)
          | T.null rest -> Nothing
          | otherwise ->
              let after = T.drop (T.length marker) rest
                  (before, _) = T.breakOn stopMarker after
                  -- Strip ",h:..." suffix if present
                  (clean, _) = T.breakOn ",h:" before
              in if T.null clean then Nothing else Just clean
  -- Real format from URI semantic IDs uses `%5Bin:` ... `%5D`
  -- Fall back to plain `[in:` ... `]` for legacy IDs.
  in case tryMarker "%5Bin:" "%5D" of
       Just t  -> Just t
       Nothing -> tryMarker "[in:" "]"

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

-- | Look up the target declaration for an imported name in a file.
lookupExportTarget :: ModuleIndex -> ExportIndex -> GraphNode -> Maybe Text
lookupExportTarget moduleIdx exportIdx binding = do
  modName <- extractModuleFromBinding binding
  (filePath, _) <- Map.lookup modName moduleIdx
  exports <- Map.lookup filePath exportIdx
  case filter (\e -> exName e == gnName binding) exports of
    (entry : _) -> Just (exNodeId entry)
    []          -> Nothing

-- | Try to resolve a single CALL to a cross-module declaration.
resolveOne :: ModuleIndex -> ExportIndex -> BindingIndex -> GraphNode -> [PluginCommand]
resolveOne moduleIdx exportIdx bindingIdx callNode =
  let file = gnFile callNode
      name = gnName callNode
      -- Strip qualified prefix: "Map.lookup" → "lookup"
      bareName = case T.breakOnEnd "." name of
        ("", n)   -> n
        (_, n)    -> n
  in case Map.lookup (file, bareName) bindingIdx of
       Nothing -> []
       Just binding ->
         case lookupExportTarget moduleIdx exportIdx binding of
           Nothing -> []
           Just targetId ->
             [ EmitEdge GraphEdge
                 { geSource   = gnId callNode
                 , geTarget   = targetId
                 , geType     = "CALLS"
                 , geMetadata = Map.singleton "resolvedVia" (MetaText "haskell-cross-module")
                 }
             ]

-- | Check if a node is an unresolved Haskell CALL.
-- We resolve CALL nodes (not REFERENCE) since Haskell function applications
-- become CALL nodes in the analyzer.
isHaskellCall :: GraphNode -> Bool
isHaskellCall n = gnType n == "CALL" && ".hs" `T.isSuffixOf` gnFile n

resolveAll :: [GraphNode] -> [GraphEdge] -> IO [PluginCommand]
resolveAll nodes _edges = do
  let moduleIdx  = buildModuleIndex nodes
      exportIdx  = buildExportIndex nodes
      bindingIdx = buildBindingIndex nodes
      callNodes  = filter isHaskellCall nodes
      results = concatMap (resolveOne moduleIdx exportIdx bindingIdx) callNodes
  hPutStrLn stderr $ "[haskell-cross-module] modules=" ++ show (Map.size moduleIdx)
    ++ " exports=" ++ show (Map.size exportIdx)
    ++ " bindings=" ++ show (Map.size bindingIdx)
    ++ " calls=" ++ show (length callNodes)
    ++ " resolved=" ++ show (length results)
  return results

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  results <- resolveAll nodes []
  writeCommandsToStdout results

{-# LANGUAGE OverloadedStrings #-}
-- | Go call resolution: resolves CALL nodes to their FUNCTION targets.
--
-- Three resolution strategies:
--   1. Package-qualified calls (e.g., @fmt.Println@, @utils.DoStuff@)
--      — receiver matches an import alias, resolve via import path + FunctionIndex
--   2. Same-package calls (e.g., @myFunc()@)
--      — no receiver, look up by caller's directory + function name
--   3. Same-package method calls (e.g., @s.Method()@)
--      — receiver doesn't match import alias, look up in MethodIndex
--
-- Node types consumed: CALL, FUNCTION, IMPORT, MODULE
-- Edge types emitted: CALLS
module GoCallResolution
  ( resolveAll
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import Data.Maybe (mapMaybe)

-- ── Helper functions ──────────────────────────────────────────────────────

-- | Look up a text metadata value from a node.
lookupMetaText :: Text -> GraphNode -> Maybe Text
lookupMetaText key node = case Map.lookup key (gnMetadata node) of
  Just (MetaText t) -> Just t
  _                 -> Nothing

-- | Extract the directory portion of a file path.
-- @dirOfFile "pkg/utils/helper.go" == "pkg/utils"@
-- @dirOfFile "main.go" == ""@
dirOfFile :: Text -> Text
dirOfFile f = case T.breakOnEnd "/" f of
  ("", _) -> ""
  (d, _)  -> T.dropEnd 1 d

-- | Check whether an import path refers to the Go standard library.
-- Standard library packages have no dots in their first path segment
-- (e.g., "fmt", "net/http"), while third-party packages start with a
-- domain name (e.g., "github.com/...").
isStdLib :: Text -> Bool
isStdLib path = not (T.any (== '.') firstSegment)
  where firstSegment = case T.splitOn "/" path of
          []    -> ""
          (x:_) -> x

-- | Extract the method/function name from a CALL node's gnName.
-- For @"fmt.Println"@ returns @"Println"@, for @"myFunc"@ returns @"myFunc"@.
extractCallName :: Text -> Text
extractCallName name = case T.breakOnEnd "." name of
  ("", n) -> n
  (_, n)  -> n

-- ── Index types ───────────────────────────────────────────────────────────

-- | Import local name -> import path.
-- Built from IMPORT nodes: local_name metadata -> path metadata.
type ImportAliasIndex = Map Text Text

-- | (directory, function name) -> FUNCTION node ID.
-- Built from FUNCTION nodes where kind = "function".
type FunctionIndex = Map (Text, Text) Text

-- | (receiver type, method name) -> FUNCTION node ID.
-- Built from FUNCTION nodes where kind = "method" and has receiver metadata.
type MethodIndex = Map (Text, Text) Text

-- | Import path -> directory (relative path within the module).
-- Built from MODULE nodes + module path.
type PackageIndex = Map Text Text

-- ── Index builders ────────────────────────────────────────────────────────

-- | Build ImportAliasIndex from IMPORT nodes in a given file.
buildImportAliasIndex :: Text -> [GraphNode] -> ImportAliasIndex
buildImportAliasIndex file nodes =
  Map.fromList $ mapMaybe extractAlias $ filter isImportInFile nodes
  where
    isImportInFile n = gnType n == "IMPORT" && gnFile n == file
    extractAlias n = do
      localName <- lookupMetaText "local_name" n
      path      <- lookupMetaText "path" n
      return (localName, path)

-- | Build FunctionIndex from FUNCTION nodes with kind = "function".
buildFunctionIndex :: [GraphNode] -> FunctionIndex
buildFunctionIndex nodes =
  Map.fromList $ mapMaybe extractFunc $ filter isFunctionNode nodes
  where
    isFunctionNode n =
      gnType n == "FUNCTION"
        && lookupMetaText "kind" n == Just "function"
    extractFunc n =
      let dir = dirOfFile (gnFile n)
      in Just ((dir, gnName n), gnId n)

-- | Build MethodIndex from FUNCTION nodes with kind = "method".
buildMethodIndex :: [GraphNode] -> MethodIndex
buildMethodIndex nodes =
  Map.fromList $ mapMaybe extractMethod $ filter isMethodNode nodes
  where
    isMethodNode n =
      gnType n == "FUNCTION"
        && lookupMetaText "kind" n == Just "method"
    extractMethod n = do
      recv <- lookupMetaText "receiver" n
      return ((recv, gnName n), gnId n)

-- | Build PackageIndex mapping import paths to directories.
-- For each MODULE node, extracts the directory from its file path and maps
-- @modulePath <> "/" <> directory@ to @directory@.
-- Also maps bare directory to itself for same-module lookups.
buildPackageIndex :: Text -> [GraphNode] -> PackageIndex
buildPackageIndex modPath nodes =
  let moduleNodes = filter (\n -> gnType n == "MODULE") nodes
      dirs = map (dirOfFile . gnFile) moduleNodes
      uniqueDirs = Map.elems $ Map.fromList [(d, d) | d <- dirs]
      withModPath
        | T.null modPath = []
        | otherwise = [(modPath <> "/" <> d, d) | d <- uniqueDirs, not (T.null d)]
                   ++ [(modPath, "") | "" `elem` uniqueDirs]
      sameMod = [(d, d) | d <- uniqueDirs]
  in Map.fromList (withModPath ++ sameMod)

-- ── Resolution logic ──────────────────────────────────────────────────────

-- | Resolve all CALL nodes in the graph to their FUNCTION targets.
--
-- Parameters:
--   * @nodes@ — all nodes from the Go project graph
--   * @modPath@ — the Go module path (e.g., @"github.com/user/myproject"@),
--     empty if not available
--
-- Returns a list of 'EmitEdge' commands with CALLS edges.
resolveAll :: [GraphNode] -> Text -> [PluginCommand]
resolveAll nodes modPath =
  let funcIdx    = buildFunctionIndex nodes
      methodIdx  = buildMethodIndex nodes
      pkgIdx     = buildPackageIndex modPath nodes
      callNodes  = filter (\n -> gnType n == "CALL") nodes
  in concatMap (resolveCall funcIdx methodIdx pkgIdx modPath nodes) callNodes

-- | Resolve a single CALL node using three strategies in order.
resolveCall
  :: FunctionIndex
  -> MethodIndex
  -> PackageIndex
  -> Text
  -> [GraphNode]
  -> GraphNode
  -> [PluginCommand]
resolveCall funcIdx methodIdx pkgIdx modPath nodes callNode =
  let callName     = extractCallName (gnName callNode)
      callerDir    = dirOfFile (gnFile callNode)
      callerFile   = gnFile callNode
      mReceiver    = lookupMetaText "receiver" callNode
      importIdx    = buildImportAliasIndex callerFile nodes
  in case mReceiver of
    -- Strategy 1: Package-qualified call (receiver matches an import alias)
    Just recv | Map.member recv importIdx ->
      resolvePackageCall funcIdx pkgIdx importIdx modPath callNode recv callName

    -- Strategy 3: Same-package method call (receiver doesn't match any import)
    Just recv ->
      resolveMethodCall methodIdx callNode recv callName

    -- Strategy 2: Same-package call (no receiver)
    Nothing ->
      resolveSamePackageCall funcIdx callNode callerDir callName

-- | Strategy 1: Resolve a package-qualified call.
-- Look up the import path from the alias, then find the function
-- in the target package's directory.
resolvePackageCall
  :: FunctionIndex
  -> PackageIndex
  -> ImportAliasIndex
  -> Text
  -> GraphNode
  -> Text        -- ^ receiver (import alias)
  -> Text        -- ^ function name
  -> [PluginCommand]
resolvePackageCall funcIdx pkgIdx importIdx modPath callNode recv callName =
  case Map.lookup recv importIdx of
    Nothing -> []
    Just importPath
      -- Skip standard library imports — we don't have their source
      | isStdLib importPath -> []
      | otherwise ->
          let -- Try to find the target directory for this import path
              mDir = Map.lookup importPath pkgIdx
                  -- Also try stripping module path prefix
                  <|> (if not (T.null modPath) && (modPath <> "/") `T.isPrefixOf` importPath
                       then let rel = T.drop (T.length modPath + 1) importPath
                            in Map.lookup rel pkgIdx
                       else Nothing)
          in case mDir of
            Nothing  -> []
            Just dir -> case Map.lookup (dir, callName) funcIdx of
              Nothing       -> []
              Just targetId -> [emitCallsEdge callNode targetId]
  where
    (<|>) :: Maybe a -> Maybe a -> Maybe a
    (<|>) (Just x) _ = Just x
    (<|>) Nothing  y = y

-- | Strategy 2: Resolve a same-package call (no receiver).
resolveSamePackageCall
  :: FunctionIndex
  -> GraphNode
  -> Text        -- ^ caller's directory
  -> Text        -- ^ function name
  -> [PluginCommand]
resolveSamePackageCall funcIdx callNode callerDir callName =
  case Map.lookup (callerDir, callName) funcIdx of
    Nothing       -> []
    Just targetId -> [emitCallsEdge callNode targetId]

-- | Strategy 3: Resolve a same-package method call.
-- The receiver doesn't match any import alias, so look up in MethodIndex
-- by (receiver type name, method name).
resolveMethodCall
  :: MethodIndex
  -> GraphNode
  -> Text        -- ^ receiver name
  -> Text        -- ^ method name
  -> [PluginCommand]
resolveMethodCall methodIdx callNode recv callName =
  case Map.lookup (recv, callName) methodIdx of
    Nothing       -> []
    Just targetId -> [emitCallsEdge callNode targetId]

-- ── Edge emission ─────────────────────────────────────────────────────────

-- | Emit a CALLS edge from a CALL node to a target FUNCTION node.
emitCallsEdge :: GraphNode -> Text -> PluginCommand
emitCallsEdge callNode targetId =
  EmitEdge GraphEdge
    { geSource   = gnId callNode
    , geTarget   = targetId
    , geType     = "CALLS"
    , geMetadata = Map.empty
    }

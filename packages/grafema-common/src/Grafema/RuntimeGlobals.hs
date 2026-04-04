{-# LANGUAGE OverloadedStrings #-}
-- | Generic runtime globals resolution engine.
--
-- Parameterized by 'NameStrategy' (language-specific behavior) and
-- 'SymbolDB' (symbols loaded from effects-db YAML files).
-- Replaces the three language-specific RuntimeGlobals modules with a
-- single reusable engine.
--
-- == Algorithm
--
-- 1. Build a function index from all FUNCTION nodes (for FilterCalls mode).
-- 2. For each matching node (CALL or REFERENCE depending on 'nsFilter'):
--    a. Skip if locally resolved.
--    b. Generate candidate names using 'allSuffixes' with 'nsSeparator'.
--    c. Try each candidate against 'SymbolDB'.
--    d. If match found: emit GLOBAL_DEFINITION node (deduplicated) + edge.
-- 3. GLOBAL_DEFINITION nodes carry effects in metadata.
module Grafema.RuntimeGlobals
  ( NameStrategy(..)
  , NodeFilter(..)
  , SymbolDB
  , SymbolEntry(..)
  , loadSymbolDB
  , resolveAll
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)
import System.Directory (listDirectory, doesDirectoryExist)
import System.FilePath ((</>), takeExtension)

import qualified Data.Yaml as Y
import Data.Aeson (Value(..))
import qualified Data.Aeson.KeyMap as KM
import qualified Data.Aeson.Key as K
import qualified Data.Vector as V

-- | How to filter graph nodes for resolution.
data NodeFilter
  = FilterCalls       -- ^ Match CALL nodes, use function index for skip (Rust, Haskell)
  | FilterReferences  -- ^ Match REFERENCE nodes with resolved=False (JS)
  deriving (Show, Eq)

-- | Language-specific resolution strategy.
data NameStrategy = NameStrategy
  { nsSeparator :: !Text   -- ^ "::" for Rust, "." for Haskell\/JS
  , nsPrefix    :: !Text   -- ^ "RUST_GLOBAL::", "HASKELL_GLOBAL::", "GLOBAL::"
  , nsCategory  :: !Text   -- ^ "rust-stdlib", "haskell-stdlib", "ecmascript"
  , nsFilter    :: !NodeFilter
  , nsEdgeType  :: !Text   -- ^ "CALLS" or "READS_FROM"
  , nsVirtualFile :: !Text -- ^ Virtual file for GLOBAL_DEFINITION nodes (must be unique per language)
  }

-- | A single symbol entry from the effects database.
data SymbolEntry = SymbolEntry
  { seName    :: !Text
  , seEffects :: ![Text]
  , seSince   :: !(Maybe Text)  -- ^ Version when API was introduced (v3 format)
  } deriving (Show, Eq)

-- | Symbol database keyed by symbol name (both bare and qualified).
newtype SymbolDB = SymbolDB (Map Text SymbolEntry)
  deriving (Show, Eq)

-- ---------------------------------------------------------------------
-- YAML loading
-- ---------------------------------------------------------------------

-- | Load a 'SymbolDB' from an effects-db directory.
--
-- Reads all @*.yaml@ files from @runtimes/@ and @packages/@ subdirectories,
-- parses them, and flattens into a symbol map.
loadSymbolDB :: FilePath -> IO SymbolDB
loadSymbolDB dir = do
  runtimeEntries <- loadFromSubdir (dir </> "runtimes")
  packageEntries <- loadFromSubdir (dir </> "packages")
  return (SymbolDB (Map.union runtimeEntries packageEntries))

-- | Load all YAML files from a subdirectory and merge into one map.
loadFromSubdir :: FilePath -> IO (Map Text SymbolEntry)
loadFromSubdir subdir = do
  exists <- doesDirectoryExist subdir
  if not exists
    then return Map.empty
    else do
      files <- listDirectory subdir
      let yamlFiles = [subdir </> f | f <- files, takeExtension f == ".yaml"]
      maps <- mapM parseYamlFile yamlFiles
      return (Map.unions maps)

-- | Parse a single YAML file into symbol entries.
-- Silently returns empty map on parse errors.
parseYamlFile :: FilePath -> IO (Map Text SymbolEntry)
parseYamlFile path = do
  result <- Y.decodeFileEither path
  case result of
    Left _err -> return Map.empty
    Right val -> return (flattenValue val)

-- | Flatten a YAML value (top-level object of modules, each containing symbols)
-- into a flat map of symbol entries.
--
-- For each module key (e.g., @"node:fs"@) and function @"readFile"@:
--
--   * Store bare name: @"readFile"@ -> entry
--   * Store qualified: @"fs.readFile"@ -> entry (using dot separator)
--   * For module keys with @:@ prefix (e.g., @"node:fs"@), use last segment as module
flattenValue :: Value -> Map Text SymbolEntry
flattenValue (Object topLevel) = Map.unions
  [ flattenModule modKey modVal
  | (k, modVal) <- KM.toList topLevel
  , let modKey = K.toText k
  ]
flattenValue _ = Map.empty

-- | Flatten a single module's symbols into entries.
flattenModule :: Text -> Value -> Map Text SymbolEntry
flattenModule modKey (Object symbols) =
  let modName = extractModuleName modKey
  in Map.unions
      [ mkEntries modName fnName fnVal
      | (k, fnVal) <- KM.toList symbols
      , let fnName = K.toText k
      ]
flattenModule _ _ = Map.empty

-- | Extract module name from a key like @"node:fs"@ -> @"fs"@.
-- For keys without @:@, returns as-is.
extractModuleName :: Text -> Text
extractModuleName key =
  case T.splitOn ":" key of
    []   -> key
    [x]  -> x
    segs -> last segs

-- | Create entries for a function: bare name and qualified name.
mkEntries :: Text -> Text -> Value -> Map Text SymbolEntry
mkEntries modName fnName fnVal =
  let entry = parseEntry fnName fnVal
      bare = Map.singleton fnName entry
      qualified = Map.singleton (modName <> "." <> fnName) entry
  in Map.union qualified bare

-- | Parse a function value as either:
--
--   * v2: array of strings -> effects
--   * v3: object with @effects@ key and optional @since@
parseEntry :: Text -> Value -> SymbolEntry
parseEntry name (Array arr) =
  let effects = [t | String t <- V.toList arr]
  in SymbolEntry name effects Nothing
parseEntry name (Object obj) =
  let effects = case KM.lookup "effects" obj of
        Just (Array arr) -> [t | String t <- V.toList arr]
        _                -> []
      since = case KM.lookup "since" obj of
        Just (String t) -> Just t
        _               -> Nothing
  in SymbolEntry name effects since
parseEntry name _ = SymbolEntry name [] Nothing

-- ---------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------

-- | Function index: @(file, name) -> nodeId@.
type FuncIndex = Map (Text, Text) Text

-- | Build function index from FUNCTION nodes.
buildFuncIndex :: [GraphNode] -> FuncIndex
buildFuncIndex nodes =
  Map.fromList
    [ ((gnFile n, gnName n), gnId n)
    | n <- nodes
    , gnType n == "FUNCTION"
    , not (T.null (gnName n))
    ]

-- | Extract the last segment of a name split by the given separator.
lastSegment :: Text -> Text -> Text
lastSegment sep t =
  case T.splitOn sep t of
    [] -> t
    xs -> last xs

-- | Generate all suffixes of a qualified name, split by separator.
--
-- @allSuffixes "::" "std::time::Instant::now"@
--   -> @["std::time::Instant::now", "time::Instant::now", "Instant::now", "now"]@
allSuffixes :: Text -> Text -> [Text]
allSuffixes sep name =
  let parts = T.splitOn sep name
  in [T.intercalate sep (drop n parts) | n <- [0..length parts - 1]]

-- | Check whether a CALL node is locally resolved (same-file FUNCTION match).
isLocallyResolved :: Text -> FuncIndex -> GraphNode -> Bool
isLocallyResolved sep funcIdx node =
  let name = gnName node
      seg  = lastSegment sep name
  in Map.member (gnFile node, name) funcIdx
     || (seg /= name && Map.member (gnFile node, seg) funcIdx)

-- | Check if a node is an unresolved reference.
isUnresolved :: GraphNode -> Bool
isUnresolved n =
  gnType n == "REFERENCE" &&
  Map.lookup "resolved" (gnMetadata n) == Just (MetaBool False)

-- | Find the first matching 'SymbolEntry' from a list of candidate names.
-- Also tries replacing "::" with "." and vice versa for cross-language
-- compatibility (Rust calls use "::", effects-db keys use ".").
firstMatch :: SymbolDB -> [Text] -> Maybe SymbolEntry
firstMatch _ [] = Nothing
firstMatch db@(SymbolDB m) (x:xs) =
  case Map.lookup x m of
    Just entry -> Just entry
    Nothing ->
      -- Try with separator normalized: "::" → "." and "." → "::"
      let dotVariant   = T.replace "::" "." x
          colonVariant = T.replace "." "::" x
          alt = if dotVariant /= x then Map.lookup dotVariant m
                else if colonVariant /= x then Map.lookup colonVariant m
                else Nothing
      in case alt of
        Just entry -> Just entry
        Nothing    -> firstMatch db xs

-- | Build a virtual GLOBAL_DEFINITION node for a matched symbol.
mkGlobalNode :: NameStrategy -> SymbolEntry -> GraphNode
mkGlobalNode strat entry = GraphNode
  { gnId        = nsPrefix strat <> seName entry
  , gnType      = "GLOBAL_DEFINITION"
  , gnName      = seName entry
  , gnFile      = nsVirtualFile strat
  , gnLine      = 0
  , gnColumn    = 0
  , gnEndLine   = 0
  , gnEndColumn = 0
  , gnExported  = True
  , gnMetadata  = Map.fromList $
      [ ("category", MetaText (nsCategory strat))
      , ("source",   MetaText "effects-db")
      ] ++ effectsMeta
  }
  where
    effectsMeta
      | null (seEffects entry) = []
      | otherwise = [("effects", MetaList (map MetaText (seEffects entry)))]

-- | Build an edge from a source node to a global definition.
mkEdge :: NameStrategy -> GraphNode -> SymbolEntry -> GraphEdge
mkEdge strat srcNode entry = GraphEdge
  { geSource   = gnId srcNode
  , geTarget   = nsPrefix strat <> seName entry
  , geType     = nsEdgeType strat
  , geMetadata = Map.fromList
      [ ("resolvedVia",    MetaText "runtime-globals")
      , ("globalCategory", MetaText (nsCategory strat))
      ]
  }

-- | Accumulator for the fold: emitted global nodes, emitted edges, and
-- the set of global names already seen (for deduplication).
type ResolveAcc = ([GraphNode], [GraphEdge], Set Text)

-- | Try to resolve a single node against the symbol database.
resolveOne :: NameStrategy -> SymbolDB -> ResolveAcc -> GraphNode -> ResolveAcc
resolveOne strat db (nodes, edges, seen) srcNode =
  let name       = gnName srcNode
      candidates = allSuffixes (nsSeparator strat) name
      mEntry     = firstMatch db candidates
  in case mEntry of
    Nothing    -> (nodes, edges, seen)
    Just entry ->
      let eName  = seName entry
          edge   = mkEdge strat srcNode entry
          (nodes', seen') =
            if Set.member eName seen
              then (nodes, seen)
              else (nodes ++ [mkGlobalNode strat entry], Set.insert eName seen)
      in (nodes', edges ++ [edge], seen')

-- | Core resolution engine.
--
-- Filters graph nodes according to 'nsFilter', then matches each against
-- the 'SymbolDB'. Returns 'PluginCommand's for all emitted nodes and edges.
resolveAll :: NameStrategy -> SymbolDB -> [GraphNode] -> [PluginCommand]
resolveAll strat db nodes =
  let matching = case nsFilter strat of
        FilterCalls ->
          let funcIdx = buildFuncIndex nodes
              callNodes = filter (\n -> gnType n == "CALL") nodes
          in filter (not . isLocallyResolved (nsSeparator strat) funcIdx) callNodes
        FilterReferences ->
          filter isUnresolved nodes
      (globalNodes, edges, _seen) = foldl (resolveOne strat db) ([], [], Set.empty) matching
  in map EmitNode globalNodes ++ map EmitEdge edges

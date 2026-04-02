{-# LANGUAGE OverloadedStrings #-}
-- | Rust standard library globals resolution plugin.
--
-- Resolves unresolved CALL nodes against a static database of known
-- Rust standard library functions. For each match, emits a virtual
-- GLOBAL_DEFINITION node and a CALLS edge.
--
-- This covers stdlib functions that are used everywhere:
-- unwrap, to_string, clone, push, len, collect, iter, etc.
--
-- == Algorithm
--
-- 1. Build a function index from all FUNCTION nodes (same as 'RustCallResolution').
-- 2. For each CALL node, skip if 'RustCallResolution' would have resolved it
--    (i.e., there's a same-file FUNCTION with a matching name).
-- 3. For remaining CALL nodes, match against the globals database.
-- 4. Emit a GLOBAL_DEFINITION node (deduplicated) and a CALLS edge.
module RustRuntimeGlobals (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)
import System.IO (hPutStrLn, stderr)

-- | Category of a Rust standard library global.
data StdCategory
  = CoreOption
  | CoreResult
  | CoreIterator
  | CoreConvert
  | StdVec
  | StdHashMap
  | StdHashSet
  | StdString
  | StdStr
  | StdPath
  | StdFs
  | StdIo
  | StdFmt
  | StdSync
  | StdTime
  | StdProcess
  | StdThread
  | StdEnv
  | CoreNumeric
  | CoreChar
  | ExternalCrate
  deriving (Show, Eq)

-- | Definition of a known Rust stdlib global.
data GlobalDef = GlobalDef
  { gdName     :: !Text
  , gdCategory :: !StdCategory
  , gdKind     :: !Text  -- "function" | "method" | "constructor" | "macro"
  }

-- | Render a category as a stable text identifier.
showCategory :: StdCategory -> Text
showCategory CoreOption   = "core::option"
showCategory CoreResult   = "core::result"
showCategory CoreIterator = "core::iter"
showCategory CoreConvert  = "core::convert"
showCategory StdVec       = "std::vec"
showCategory StdHashMap   = "std::collections::HashMap"
showCategory StdHashSet   = "std::collections::HashSet"
showCategory StdString    = "std::string"
showCategory StdStr       = "std::str"
showCategory StdPath      = "std::path"
showCategory StdFs        = "std::fs"
showCategory StdIo        = "std::io"
showCategory StdFmt       = "std::fmt"
showCategory StdSync      = "std::sync"
showCategory StdTime      = "std::time"
showCategory StdProcess   = "std::process"
showCategory StdThread    = "std::thread"
showCategory StdEnv       = "std::env"
showCategory CoreNumeric  = "core::numeric"
showCategory CoreChar     = "core::char"
showCategory ExternalCrate = "external-crate"

-- | Build a GlobalDef helper.
mkGlobal :: Text -> StdCategory -> Text -> (Text, GlobalDef)
mkGlobal name cat kind = (name, GlobalDef name cat kind)

-- | Static database of known Rust stdlib globals, keyed by name.
--
-- Frequencies from real-world codebase ISSUE analysis are noted where available.
globalsDb :: Map Text GlobalDef
globalsDb = Map.fromList $ concat
  [ optionGlobals
  , resultGlobals
  , iteratorGlobals
  , convertGlobals
  , vecGlobals
  , hashMapGlobals
  , hashSetGlobals
  , stringGlobals
  , strGlobals
  , pathGlobals
  , fsGlobals
  , ioGlobals
  , fmtGlobals
  , syncGlobals
  , timeGlobals
  , processGlobals
  , threadGlobals
  , envGlobals
  , numericGlobals
  , charGlobals
  , qualifiedPathGlobals
  , serdeJsonGlobals
  , rmpSerdeGlobals
  , blake3Globals
  , tokioGlobals
  , anyhowGlobals
  , tracingGlobals
  ]
  where
    optionGlobals =
      [ mkGlobal "unwrap"             CoreOption "method"      -- 1555x
      , mkGlobal "expect"             CoreOption "method"
      , mkGlobal "unwrap_or"          CoreOption "method"      -- 208x
      , mkGlobal "unwrap_or_default"  CoreOption "method"
      , mkGlobal "unwrap_or_else"     CoreOption "method"
      , mkGlobal "map"                CoreOption "method"
      , mkGlobal "map_or"             CoreOption "method"
      , mkGlobal "map_or_else"        CoreOption "method"
      , mkGlobal "and_then"           CoreOption "method"
      , mkGlobal "or_else"            CoreOption "method"
      , mkGlobal "filter"             CoreOption "method"
      , mkGlobal "is_some"            CoreOption "method"
      , mkGlobal "is_none"            CoreOption "method"
      , mkGlobal "ok_or"              CoreOption "method"
      , mkGlobal "as_ref"             CoreOption "method"
      , mkGlobal "as_deref"           CoreOption "method"      -- 121x
      , mkGlobal "cloned"             CoreOption "method"
      , mkGlobal "copied"             CoreOption "method"
      , mkGlobal "Some"               CoreOption "constructor" -- 752x
      , mkGlobal "None"               CoreOption "constructor"
      ]

    resultGlobals =
      [ mkGlobal "map_err"            CoreResult "method"
      , mkGlobal "is_ok"              CoreResult "method"
      , mkGlobal "is_err"             CoreResult "method"
      , mkGlobal "ok"                 CoreResult "method"
      , mkGlobal "err"                CoreResult "method"
      , mkGlobal "unwrap_err"         CoreResult "method"
      , mkGlobal "with_context"       CoreResult "method"      -- 179x
      , mkGlobal "context"            CoreResult "method"
      , mkGlobal "Ok"                 CoreResult "constructor"  -- 295x
      , mkGlobal "Err"                CoreResult "constructor"
      ]

    iteratorGlobals =
      [ mkGlobal "iter"               CoreIterator "method"
      , mkGlobal "into_iter"          CoreIterator "method"
      , mkGlobal "collect"            CoreIterator "method"    -- 575x
      , mkGlobal "flat_map"           CoreIterator "method"
      , mkGlobal "any"                CoreIterator "method"
      , mkGlobal "all"                CoreIterator "method"
      , mkGlobal "find"               CoreIterator "method"
      , mkGlobal "position"           CoreIterator "method"
      , mkGlobal "count"              CoreIterator "method"
      , mkGlobal "sum"                CoreIterator "method"
      , mkGlobal "product"            CoreIterator "method"
      , mkGlobal "min"                CoreIterator "method"
      , mkGlobal "max"                CoreIterator "method"
      , mkGlobal "enumerate"          CoreIterator "method"
      , mkGlobal "zip"                CoreIterator "method"
      , mkGlobal "chain"              CoreIterator "method"
      , mkGlobal "take"               CoreIterator "method"
      , mkGlobal "skip"               CoreIterator "method"
      , mkGlobal "for_each"           CoreIterator "method"
      , mkGlobal "fold"               CoreIterator "method"
      , mkGlobal "reduce"             CoreIterator "method"
      , mkGlobal "nth"                CoreIterator "method"
      , mkGlobal "last"               CoreIterator "method"
      , mkGlobal "next"               CoreIterator "method"
      , mkGlobal "peekable"           CoreIterator "method"
      , mkGlobal "filter_map"         CoreIterator "method"
      ]

    convertGlobals =
      [ mkGlobal "into"               CoreConvert "method"
      , mkGlobal "from"               CoreConvert "method"
      , mkGlobal "try_into"           CoreConvert "method"
      , mkGlobal "try_from"           CoreConvert "method"
      , mkGlobal "to_string"          CoreConvert "method"     -- 1428x
      , mkGlobal "to_str"             CoreConvert "method"
      , mkGlobal "to_owned"           CoreConvert "method"
      , mkGlobal "clone"              CoreConvert "method"     -- 949x
      , mkGlobal "default"            CoreConvert "function"
      , mkGlobal "or_default"         CoreConvert "method"
      , mkGlobal "swap"               CoreConvert "function"
      , mkGlobal "as_ptr"             CoreConvert "method"
      ]

    vecGlobals =
      [ mkGlobal "Vec::new"           StdVec "function"        -- 191x
      , mkGlobal "with_capacity"      StdVec "function"
      , mkGlobal "push"               StdVec "method"          -- 599x
      , mkGlobal "pop"                StdVec "method"
      , mkGlobal "insert"             StdVec "method"          -- 237x
      , mkGlobal "remove"             StdVec "method"
      , mkGlobal "clear"              StdVec "method"
      , mkGlobal "len"                StdVec "method"          -- 584x
      , mkGlobal "is_empty"           StdVec "method"          -- 211x
      , mkGlobal "contains"           StdVec "method"          -- 183x
      , mkGlobal "get"                StdVec "method"
      , mkGlobal "extend"             StdVec "method"
      , mkGlobal "sort"               StdVec "method"
      , mkGlobal "sort_by"            StdVec "method"
      , mkGlobal "retain"             StdVec "method"
      , mkGlobal "dedup"              StdVec "method"
      , mkGlobal "drain"              StdVec "method"
      , mkGlobal "truncate"           StdVec "method"
      , mkGlobal "split_off"          StdVec "method"
      , mkGlobal "extend_from_slice"  StdVec "method"
      , mkGlobal "as_slice"           StdVec "method"
      , mkGlobal "capacity"           StdVec "method"
      , mkGlobal "reserve"            StdVec "method"
      , mkGlobal "resize"             StdVec "method"
      , mkGlobal "to_vec"             StdVec "method"
      , mkGlobal "windows"            StdVec "method"
      , mkGlobal "chunks"             StdVec "method"
      , mkGlobal "VecDeque::new"      StdVec "function"
      ]

    hashMapGlobals =
      [ mkGlobal "HashMap::new"       StdHashMap "function"    -- 133x
      , mkGlobal "HashMap::with_capacity" StdHashMap "function"
      , mkGlobal "BTreeMap::new"      StdHashMap "function"
      , mkGlobal "get_mut"            StdHashMap "method"
      , mkGlobal "contains_key"       StdHashMap "method"
      , mkGlobal "entry"              StdHashMap "method"
      , mkGlobal "keys"               StdHashMap "method"
      , mkGlobal "values"             StdHashMap "method"
      ]

    hashSetGlobals =
      [ mkGlobal "HashSet::new"       StdHashSet "function"
      , mkGlobal "HashSet::with_capacity" StdHashSet "function"
      ]

    stringGlobals =
      [ mkGlobal "String::new"        StdString "function"
      , mkGlobal "String::from"       StdString "function"
      , mkGlobal "String::from_utf8"  StdString "function"
      , mkGlobal "String::from_utf8_lossy" StdString "function"
      , mkGlobal "String::with_capacity"   StdString "function"
      , mkGlobal "push_str"           StdString "method"
      , mkGlobal "as_str"             StdString "method"       -- 200x
      , mkGlobal "as_bytes"           StdString "method"
      , mkGlobal "into_bytes"         StdString "method"
      , mkGlobal "to_uppercase"       StdString "method"
      , mkGlobal "to_lowercase"       StdString "method"
      ]

    strGlobals =
      [ mkGlobal "from_utf8"          StdStr "function"
      , mkGlobal "from_utf8_unchecked" StdStr "function"
      , mkGlobal "starts_with"        StdStr "method"
      , mkGlobal "ends_with"          StdStr "method"
      , mkGlobal "split"              StdStr "method"
      , mkGlobal "trim"               StdStr "method"
      , mkGlobal "replace"            StdStr "method"
      , mkGlobal "parse"              StdStr "method"
      , mkGlobal "chars"              StdStr "method"
      , mkGlobal "as_bytes"           StdStr "method"
      ]

    pathGlobals =
      [ mkGlobal "Path::new"          StdPath "function"
      , mkGlobal "join"               StdPath "method"         -- 201x
      , mkGlobal "extension"          StdPath "method"
      , mkGlobal "file_name"          StdPath "method"
      , mkGlobal "parent"             StdPath "method"
      , mkGlobal "is_absolute"        StdPath "method"
      , mkGlobal "to_path_buf"        StdPath "method"
      , mkGlobal "exists"             StdPath "method"
      , mkGlobal "is_file"            StdPath "method"
      , mkGlobal "is_dir"             StdPath "method"
      , mkGlobal "display"            StdPath "method"
      , mkGlobal "PathBuf::new"       StdPath "function"       -- 22x
      ]

    fsGlobals =
      [ mkGlobal "read"               StdFs "function"
      , mkGlobal "read_to_string"     StdFs "function"
      , mkGlobal "write"              StdFs "function"
      , mkGlobal "create_dir"         StdFs "function"
      , mkGlobal "create_dir_all"     StdFs "function"
      , mkGlobal "remove_file"        StdFs "function"
      , mkGlobal "remove_dir"         StdFs "function"
      , mkGlobal "remove_dir_all"     StdFs "function"
      , mkGlobal "rename"             StdFs "function"
      , mkGlobal "copy"               StdFs "function"
      , mkGlobal "metadata"           StdFs "function"
      , mkGlobal "read_dir"           StdFs "function"
      , mkGlobal "canonicalize"       StdFs "function"
      ]

    ioGlobals =
      [ mkGlobal "write_all"          StdIo "method"
      , mkGlobal "flush"              StdIo "method"
      , mkGlobal "read_to_end"        StdIo "method"
      , mkGlobal "read_line"          StdIo "method"
      , mkGlobal "Cursor::new"        StdIo "function"
      , mkGlobal "stdin"              StdIo "function"
      , mkGlobal "stdout"             StdIo "function"
      , mkGlobal "stderr"             StdIo "function"
      ]

    fmtGlobals =
      [ mkGlobal "format"             StdFmt "macro"
      , mkGlobal "println"            StdFmt "macro"
      , mkGlobal "eprintln"           StdFmt "macro"
      , mkGlobal "print"              StdFmt "macro"
      , mkGlobal "eprint"             StdFmt "macro"
      , mkGlobal "dbg"                StdFmt "macro"
      ]

    syncGlobals =
      [ mkGlobal "Mutex::new"         StdSync "function"
      , mkGlobal "lock"               StdSync "method"
      , mkGlobal "RwLock::new"        StdSync "function"
      , mkGlobal "Arc::new"           StdSync "function"
      , mkGlobal "Arc::clone"         StdSync "function"
      , mkGlobal "Rc::new"            StdSync "function"
      , mkGlobal "Rc::clone"          StdSync "function"
      , mkGlobal "Box::new"           StdSync "function"       -- 79x
      , mkGlobal "acquire"            StdSync "method"
      , mkGlobal "Semaphore::new"    StdSync "function"       -- 23x (tokio::sync)
      ]

    timeGlobals =
      [ mkGlobal "Instant::now"       StdTime "function"
      , mkGlobal "elapsed"            StdTime "method"         -- 144x
      , mkGlobal "Duration::from_secs"   StdTime "function"
      , mkGlobal "Duration::from_millis" StdTime "function"
      , mkGlobal "as_secs"            StdTime "method"
      , mkGlobal "as_millis"          StdTime "method"         -- 133x
      , mkGlobal "as_nanos"           StdTime "method"
      , mkGlobal "SystemTime::now"    StdTime "function"
      ]

    processGlobals =
      [ mkGlobal "Command::new"       StdProcess "function"
      , mkGlobal "arg"                StdProcess "method"
      , mkGlobal "args"               StdProcess "method"
      , mkGlobal "spawn"              StdProcess "method"
      , mkGlobal "output"             StdProcess "method"
      , mkGlobal "status"             StdProcess "method"
      , mkGlobal "exit"               StdProcess "function"
      , mkGlobal "abort"              StdProcess "function"
      , mkGlobal "Stdio::piped"       StdProcess "function"
      , mkGlobal "Stdio::null"        StdProcess "function"
      , mkGlobal "Stdio::inherit"     StdProcess "function"
      ]

    threadGlobals =
      [ mkGlobal "sleep"              StdThread "function"
      , mkGlobal "current"            StdThread "function"
      ]

    envGlobals =
      [ mkGlobal "var"                StdEnv "function"
      , mkGlobal "set_var"            StdEnv "function"
      , mkGlobal "remove_var"         StdEnv "function"
      , mkGlobal "current_dir"        StdEnv "function"
      ]

    numericGlobals =
      [ mkGlobal "from_le_bytes"      CoreNumeric "method"
      , mkGlobal "to_le_bytes"        CoreNumeric "method"
      , mkGlobal "from_be_bytes"      CoreNumeric "method"
      , mkGlobal "to_be_bytes"        CoreNumeric "method"
      , mkGlobal "wrapping_add"       CoreNumeric "method"
      , mkGlobal "wrapping_mul"       CoreNumeric "method"
      , mkGlobal "wrapping_sub"       CoreNumeric "method"
      , mkGlobal "saturating_add"     CoreNumeric "method"
      , mkGlobal "saturating_sub"     CoreNumeric "method"
      , mkGlobal "checked_add"        CoreNumeric "method"
      , mkGlobal "checked_sub"        CoreNumeric "method"
      , mkGlobal "checked_mul"        CoreNumeric "method"
      , mkGlobal "clamp"              CoreNumeric "method"
      ]

    charGlobals =
      [ mkGlobal "is_uppercase"       CoreChar "method"
      , mkGlobal "is_lowercase"       CoreChar "method"
      , mkGlobal "is_alphabetic"      CoreChar "method"
      , mkGlobal "is_numeric"         CoreChar "method"
      , mkGlobal "is_alphanumeric"    CoreChar "method"
      , mkGlobal "is_whitespace"      CoreChar "method"
      ]

    -- std:: qualified paths (frequently used with full path)
    qualifiedPathGlobals =
      [ mkGlobal "std::time::Instant::now"          StdTime     "function"
      , mkGlobal "std::process::Stdio::piped"       StdProcess  "function"
      , mkGlobal "std::process::Stdio::null"        StdProcess  "function"
      , mkGlobal "std::process::Stdio::inherit"     StdProcess  "function"
      , mkGlobal "std::collections::HashMap::new"   StdHashMap  "function"
      , mkGlobal "std::collections::HashSet::new"   StdHashSet  "function"
      , mkGlobal "std::path::Path::new"             StdPath     "function"
      , mkGlobal "std::env::temp_dir"               StdEnv      "function"
      , mkGlobal "std::str::from_utf8"              StdStr      "function"
      , mkGlobal "std::fs::remove_file"             StdFs       "function"
      , mkGlobal "std::fs::read_to_string"          StdFs       "function"
      , mkGlobal "std::fs::write"                   StdFs       "function"
      , mkGlobal "std::fs::create_dir_all"          StdFs       "function"
      , mkGlobal "std::fs::remove_dir_all"          StdFs       "function"
      ]

    -- serde_json crate
    serdeJsonGlobals =
      [ mkGlobal "serde_json::from_str"        ExternalCrate "function"
      , mkGlobal "serde_json::from_slice"      ExternalCrate "function"
      , mkGlobal "serde_json::to_string"       ExternalCrate "function"
      , mkGlobal "serde_json::to_value"        ExternalCrate "function"
      , mkGlobal "serde_json::to_vec"          ExternalCrate "function"
      , mkGlobal "serde_json::json"            ExternalCrate "macro"
      , mkGlobal "serde_json::Value::String"   ExternalCrate "constructor"
      , mkGlobal "serde_json::Value::Bool"     ExternalCrate "constructor"
      , mkGlobal "serde_json::Value::Array"    ExternalCrate "constructor"
      , mkGlobal "serde_json::Value::Null"     ExternalCrate "constructor"
      ]

    -- rmp_serde crate
    rmpSerdeGlobals =
      [ mkGlobal "rmp_serde::to_vec_named"     ExternalCrate "function"
      , mkGlobal "rmp_serde::from_slice"       ExternalCrate "function"
      , mkGlobal "rmp_serde::to_vec"           ExternalCrate "function"
      ]

    -- blake3 crate
    blake3Globals =
      [ mkGlobal "blake3::hash"                ExternalCrate "function"
      , mkGlobal "blake3::Hasher::new"         ExternalCrate "function"
      ]

    -- tokio crate
    tokioGlobals =
      [ mkGlobal "tokio::task::spawn_blocking"        ExternalCrate "function"
      , mkGlobal "tokio::time::timeout"               ExternalCrate "function"
      , mkGlobal "tokio::process::Command::new"       ExternalCrate "function"
      , mkGlobal "tokio::io::duplex"                  ExternalCrate "function"
      , mkGlobal "tokio::runtime::Handle::try_current" ExternalCrate "function"
      , mkGlobal "tokio::sync::Semaphore::new"        ExternalCrate "function"
      ]

    -- anyhow crate
    anyhowGlobals =
      [ mkGlobal "anyhow::Context"             ExternalCrate "trait"
      , mkGlobal "anyhow::bail"                ExternalCrate "macro"
      , mkGlobal "anyhow::anyhow"              ExternalCrate "macro"
      ]

    -- tracing crate
    tracingGlobals =
      [ mkGlobal "tracing::info"               ExternalCrate "macro"
      , mkGlobal "tracing::warn"               ExternalCrate "macro"
      , mkGlobal "tracing::error"              ExternalCrate "macro"
      , mkGlobal "tracing::debug"              ExternalCrate "macro"
      , mkGlobal "tracing::trace"              ExternalCrate "macro"
      , mkGlobal "tracing::info_span"          ExternalCrate "macro"
      ]

-- | Function index: (file, name) -> node ID.
-- Replicates the same index that 'RustCallResolution' builds, so we can
-- skip CALL nodes that it would have already resolved.
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

-- | Extract the last segment of a Rust path.
--
-- @"crate::module::foo"@ -> @"foo"@
-- @"foo"@                -> @"foo"@
lastSegment :: Text -> Text
lastSegment t =
  case T.splitOn "::" t of
    [] -> t
    xs -> last xs

-- | Check whether 'RustCallResolution' would have resolved this CALL node.
-- If a same-file FUNCTION matches by name or last segment, the call plugin
-- already created a CALLS edge for it.
isResolvedByCallPlugin :: FuncIndex -> GraphNode -> Bool
isResolvedByCallPlugin idx n =
  let file = gnFile n
      name = gnName n
      seg  = lastSegment name
  in Map.member (file, name) idx
     || (seg /= name && Map.member (file, seg) idx)

-- | Build a virtual GLOBAL_DEFINITION node for a matched Rust stdlib global.
mkGlobalNode :: GlobalDef -> GraphNode
mkGlobalNode def = GraphNode
  { gnId        = "RUST_GLOBAL::" <> gdName def
  , gnType      = "GLOBAL_DEFINITION"
  , gnName      = gdName def
  , gnFile      = "<rust-stdlib>"
  , gnLine      = 0
  , gnColumn    = 0
  , gnEndLine   = 0
  , gnEndColumn = 0
  , gnExported  = True
  , gnMetadata  = Map.fromList
      [ ("category", MetaText (showCategory (gdCategory def)))
      , ("kind",     MetaText (gdKind def))
      ]
  }

-- | Build a CALLS edge from a call node to a global definition.
mkCallsEdge :: GraphNode -> GlobalDef -> GraphEdge
mkCallsEdge callNode def = GraphEdge
  { geSource   = gnId callNode
  , geTarget   = "RUST_GLOBAL::" <> gdName def
  , geType     = "CALLS"
  , geMetadata = Map.fromList
      [ ("resolvedVia",    MetaText "rust-globals")
      , ("globalCategory", MetaText (showCategory (gdCategory def)))
      ]
  }

-- | Accumulator for the fold: emitted global nodes, emitted edges, and
-- the set of global names already seen (for deduplication).
type ResolveAcc = ([GraphNode], [GraphEdge], Set Text)

-- | Generate all @::@ suffixes of a qualified name.
--
-- @"std::time::Instant::now"@ -> @["std::time::Instant::now", "time::Instant::now", "Instant::now", "now"]@
allSuffixes :: Text -> [Text]
allSuffixes t =
  let segs = T.splitOn "::" t
      suffixes = [T.intercalate "::" (drop n segs) | n <- [0..length segs - 1]]
  in suffixes

-- | Find the first matching 'GlobalDef' from a list of candidate names.
firstMatch :: [Text] -> Maybe GlobalDef
firstMatch [] = Nothing
firstMatch (x:xs) = case Map.lookup x globalsDb of
  Just def -> Just def
  Nothing  -> firstMatch xs

-- | Try to match a single CALL node against the globals database.
--
-- Matching strategy (tries multiple prefixes for qualified paths):
--   1. Exact match: @"std::time::Instant::now"@
--   2. Drop first segment: @"time::Instant::now"@
--   3. Last two segments: @"Instant::now"@
--   4. Last segment: @"now"@
--
-- If matched, emit the GLOBAL_DEFINITION node (deduplicated) and a CALLS edge.
resolveCall :: ResolveAcc -> GraphNode -> ResolveAcc
resolveCall (nodes, edges, seen) callNode =
  let name       = gnName callNode
      candidates = allSuffixes name
      mDef       = firstMatch candidates
  in case mDef of
    Nothing  -> (nodes, edges, seen)
    Just def ->
      let gname  = gdName def
          edge   = mkCallsEdge callNode def
          -- Only emit the global node once per unique global name
          (nodes', seen') =
            if Set.member gname seen
              then (nodes, seen)
              else (nodes ++ [mkGlobalNode def], Set.insert gname seen)
      in (nodes', edges ++ [edge], seen')

-- | Core runtime globals resolution, operating on a list of nodes.
--
-- Filters CALL nodes to only those that 'RustCallResolution' did NOT resolve
-- (no same-file FUNCTION match), then matches against the stdlib database.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let funcIdx    = buildFuncIndex nodes
      callNodes  = filter (\n -> gnType n == "CALL") nodes
      unresolved = filter (not . isResolvedByCallPlugin funcIdx) callNodes
      (globalNodes, edges, _seen) = foldl resolveCall ([], [], Set.empty) unresolved

  hPutStrLn stderr $
    "rust-globals: " ++ show (length globalNodes) ++ " globals, "
      ++ show (length edges) ++ " CALLS edges from "
      ++ show (length unresolved) ++ " unresolved calls (of "
      ++ show (length callNodes) ++ " total)"

  return $ map EmitNode globalNodes ++ map EmitEdge edges

-- | Entry point: read nodes from stdin, resolve unresolved calls
-- against the Rust stdlib database, and emit results.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

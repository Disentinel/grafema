{-# LANGUAGE OverloadedStrings #-}
-- | Haskell standard library globals resolution plugin.
--
-- Resolves unresolved CALL nodes against a static database of known
-- Haskell standard library and common library functions. For each match,
-- emits a virtual GLOBAL_DEFINITION node and a CALLS edge.
--
-- This covers stdlib functions that are used everywhere:
-- mapM_, show, return, pure, fromList, length, filter, etc.
--
-- == Algorithm
--
-- 1. Build a function index from all FUNCTION nodes (same as 'HaskellLocalRefs').
-- 2. For each CALL node, skip if a same-file FUNCTION matches by name
--    (i.e., HaskellLocalRefs or HaskellImportResolution would handle it).
-- 3. For remaining CALL nodes, match against the globals database.
-- 4. Emit a GLOBAL_DEFINITION node (deduplicated) and a CALLS edge.
module HaskellRuntimeGlobals (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)

-- | Category of a Haskell standard library global.
data StdCategory
  = Prelude
  | DataText
  | DataMap
  | DataSet
  | DataByteString
  | SystemIO
  | ControlMonad
  | ControlException
  | SystemExit
  | DataIntMap
  | DataHashMap
  | MTL
  deriving (Show, Eq)

-- | Definition of a known Haskell stdlib global.
data GlobalDef = GlobalDef
  { gdName     :: !Text
  , gdCategory :: !StdCategory
  , gdKind     :: !Text  -- "function" | "constructor" | "operator" | "constant"
  }

-- | Render a category as a stable text identifier.
showCategory :: StdCategory -> Text
showCategory Prelude          = "prelude"
showCategory DataText         = "Data.Text"
showCategory DataMap          = "Data.Map"
showCategory DataSet          = "Data.Set"
showCategory DataByteString   = "Data.ByteString"
showCategory SystemIO         = "System.IO"
showCategory ControlMonad     = "Control.Monad"
showCategory ControlException = "Control.Exception"
showCategory SystemExit       = "System.Exit"
showCategory DataIntMap       = "Data.IntMap"
showCategory DataHashMap      = "Data.HashMap"
showCategory MTL              = "mtl"

-- | Build a GlobalDef helper.
mkGlobal :: Text -> StdCategory -> Text -> (Text, GlobalDef)
mkGlobal name cat kind = (name, GlobalDef name cat kind)

-- | Static database of known Haskell stdlib globals, keyed by name.
--
-- Frequencies from real-world codebase ISSUE analysis are noted where available.
globalsDb :: Map Text GlobalDef
globalsDb = Map.fromList $ concat
  [ preludeGlobals
  , operatorGlobals
  , ioGlobals
  , monadGlobals
  , exceptionGlobals
  , exitGlobals
  , dataTextGlobals
  , dataMapGlobals
  , dataSetGlobals
  , dataIntMapGlobals
  , dataHashMapGlobals
  , dataByteStringGlobals
  , mtlGlobals
  ]
  where
    preludeGlobals =
      [ -- Data constructors
        mkGlobal "Just"            Prelude "constructor"   -- 662x
      , mkGlobal "Nothing"         Prelude "constructor"
      , mkGlobal "Left"            Prelude "constructor"
      , mkGlobal "Right"           Prelude "constructor"
      , mkGlobal "True"            Prelude "constructor"
      , mkGlobal "False"           Prelude "constructor"
      , mkGlobal "IO"              Prelude "constructor"
      , mkGlobal "Either"          Prelude "constructor"
      -- Common functions
      , mkGlobal "return"          Prelude "function"      -- 440x
      , mkGlobal "pure"            Prelude "function"      -- 352x
      , mkGlobal "show"            Prelude "function"      -- 260x
      , mkGlobal "maybe"           Prelude "function"      -- 174x
      , mkGlobal "null"            Prelude "function"      -- 119x
      , mkGlobal "length"          Prelude "function"      -- 104x
      , mkGlobal "concatMap"       Prelude "function"      -- 131x
      , mkGlobal "mapM_"          Prelude "function"      -- 627x
      , mkGlobal "filter"          Prelude "function"      -- 87x
      , mkGlobal "foldl'"          Prelude "function"      -- 97x
      , mkGlobal "fromList"        Prelude "function"      -- 80x
      , mkGlobal "map"             Prelude "function"
      , mkGlobal "foldr"           Prelude "function"
      , mkGlobal "foldl"           Prelude "function"
      , mkGlobal "zip"             Prelude "function"
      , mkGlobal "unzip"           Prelude "function"
      , mkGlobal "head"            Prelude "function"
      , mkGlobal "tail"            Prelude "function"
      , mkGlobal "init"            Prelude "function"
      , mkGlobal "last"            Prelude "function"
      , mkGlobal "take"            Prelude "function"
      , mkGlobal "drop"            Prelude "function"
      , mkGlobal "reverse"         Prelude "function"
      , mkGlobal "elem"            Prelude "function"
      , mkGlobal "notElem"         Prelude "function"
      , mkGlobal "any"             Prelude "function"
      , mkGlobal "all"             Prelude "function"
      , mkGlobal "minimum"         Prelude "function"
      , mkGlobal "maximum"         Prelude "function"
      , mkGlobal "sum"             Prelude "function"
      , mkGlobal "product"         Prelude "function"
      , mkGlobal "replicate"       Prelude "function"
      , mkGlobal "words"           Prelude "function"
      , mkGlobal "unwords"         Prelude "function"
      , mkGlobal "lines"           Prelude "function"
      , mkGlobal "unlines"         Prelude "function"
      , mkGlobal "concat"          Prelude "function"
      -- Numeric
      , mkGlobal "fromIntegral"    Prelude "function"
      , mkGlobal "toInteger"       Prelude "function"
      , mkGlobal "fromInteger"     Prelude "function"
      , mkGlobal "realToFrac"      Prelude "function"
      , mkGlobal "mod"             Prelude "function"
      , mkGlobal "div"             Prelude "function"
      , mkGlobal "abs"             Prelude "function"
      , mkGlobal "negate"          Prelude "function"
      -- Utility
      , mkGlobal "not"             Prelude "function"
      , mkGlobal "error"           Prelude "function"
      , mkGlobal "undefined"       Prelude "function"
      , mkGlobal "otherwise"       Prelude "constant"
      , mkGlobal "id"              Prelude "function"
      , mkGlobal "const"           Prelude "function"
      , mkGlobal "flip"            Prelude "function"
      , mkGlobal "seq"             Prelude "function"
      -- Functor / Applicative / Traversable
      , mkGlobal "fmap"            Prelude "function"
      , mkGlobal "traverse"        Prelude "function"
      , mkGlobal "traverse_"       Prelude "function"
      , mkGlobal "for_"            Prelude "function"
      -- Monoid
      , mkGlobal "mempty"          Prelude "function"
      , mkGlobal "mconcat"         Prelude "function"
      , mkGlobal "mappend"         Prelude "function"
      -- Tuples
      , mkGlobal "fst"             Prelude "function"
      , mkGlobal "snd"             Prelude "function"
      , mkGlobal "uncurry"         Prelude "function"
      , mkGlobal "curry"           Prelude "function"
      ]

    operatorGlobals =
      [ mkGlobal "$"               Prelude "operator"      -- 308x
      , mkGlobal ">>"              Prelude "operator"      -- 173x
      , mkGlobal ">>="             Prelude "operator"      -- 102x
      , mkGlobal "<>"              Prelude "operator"      -- 159x
      , mkGlobal "++"              Prelude "operator"      -- 181x
      , mkGlobal "=="              Prelude "operator"      -- 188x
      , mkGlobal "/="              Prelude "operator"
      , mkGlobal "&&"              Prelude "operator"
      , mkGlobal "||"              Prelude "operator"
      , mkGlobal "<"               Prelude "operator"
      , mkGlobal ">"               Prelude "operator"
      , mkGlobal "<="              Prelude "operator"
      , mkGlobal ">="              Prelude "operator"
      , mkGlobal "+"               Prelude "operator"
      , mkGlobal "-"               Prelude "operator"
      , mkGlobal "*"               Prelude "operator"
      , mkGlobal "/"               Prelude "operator"
      , mkGlobal "<$>"             Prelude "operator"
      , mkGlobal "<*>"             Prelude "operator"
      ]

    ioGlobals =
      [ mkGlobal "print"           SystemIO "function"
      , mkGlobal "putStrLn"        SystemIO "function"
      , mkGlobal "putStr"          SystemIO "function"
      , mkGlobal "getLine"         SystemIO "function"
      , mkGlobal "interact"        SystemIO "function"
      , mkGlobal "hPutStrLn"       SystemIO "function"     -- 101x
      , mkGlobal "hPutStr"         SystemIO "function"
      , mkGlobal "hFlush"          SystemIO "function"
      , mkGlobal "hSetBuffering"   SystemIO "function"
      , mkGlobal "stderr"          SystemIO "constant"
      , mkGlobal "stdout"          SystemIO "constant"
      , mkGlobal "stdin"           SystemIO "constant"
      , mkGlobal "readFile"        SystemIO "function"
      , mkGlobal "writeFile"       SystemIO "function"
      , mkGlobal "appendFile"      SystemIO "function"
      , mkGlobal "getArgs"         SystemIO "function"
      ]

    monadGlobals =
      [ mkGlobal "void"            ControlMonad "function"
      , mkGlobal "when"            ControlMonad "function"
      , mkGlobal "unless"          ControlMonad "function"
      , mkGlobal "forM"            ControlMonad "function"
      , mkGlobal "forM_"           ControlMonad "function"
      , mkGlobal "mapM"            ControlMonad "function"
      , mkGlobal "sequence"        ControlMonad "function"
      , mkGlobal "sequence_"       ControlMonad "function"
      ]

    exceptionGlobals =
      [ mkGlobal "throwIO"         ControlException "function"
      , mkGlobal "catch"           ControlException "function"
      , mkGlobal "bracket"         ControlException "function"
      , mkGlobal "try"             ControlException "function"
      , mkGlobal "finally"         ControlException "function"
      , mkGlobal "handle"          ControlException "function"
      , mkGlobal "onException"     ControlException "function"
      , mkGlobal "throw"           ControlException "function"
      ]

    exitGlobals =
      [ mkGlobal "exitWith"        SystemExit "function"
      , mkGlobal "exitSuccess"     SystemExit "function"
      , mkGlobal "exitFailure"     SystemExit "constant"
      ]

    dataTextGlobals =
      [ mkGlobal "T.pack"          DataText "function"
      , mkGlobal "T.unpack"        DataText "function"
      , mkGlobal "T.length"        DataText "function"
      , mkGlobal "T.null"          DataText "function"
      , mkGlobal "T.empty"         DataText "constant"
      , mkGlobal "T.concat"        DataText "function"
      , mkGlobal "T.intercalate"   DataText "function"
      , mkGlobal "T.splitOn"       DataText "function"
      , mkGlobal "T.isPrefixOf"    DataText "function"
      , mkGlobal "T.isSuffixOf"    DataText "function"
      , mkGlobal "T.strip"         DataText "function"
      , mkGlobal "T.toLower"       DataText "function"
      , mkGlobal "T.toUpper"       DataText "function"
      , mkGlobal "T.take"          DataText "function"
      , mkGlobal "T.drop"          DataText "function"
      , mkGlobal "T.append"        DataText "function"
      , mkGlobal "T.replace"       DataText "function"
      , mkGlobal "T.words"         DataText "function"
      , mkGlobal "T.unwords"       DataText "function"
      , mkGlobal "T.lines"         DataText "function"
      , mkGlobal "T.unlines"       DataText "function"
      , mkGlobal "T.singleton"     DataText "function"
      , mkGlobal "T.cons"          DataText "function"
      , mkGlobal "T.snoc"          DataText "function"
      , mkGlobal "T.head"          DataText "function"
      , mkGlobal "T.tail"          DataText "function"
      , mkGlobal "T.last"          DataText "function"
      , mkGlobal "T.init"          DataText "function"
      , mkGlobal "T.map"           DataText "function"
      , mkGlobal "T.filter"        DataText "function"
      , mkGlobal "T.any"           DataText "function"
      , mkGlobal "T.all"           DataText "function"
      , mkGlobal "T.find"          DataText "function"
      , mkGlobal "T.breakOn"       DataText "function"
      , mkGlobal "T.stripPrefix"   DataText "function"
      , mkGlobal "T.stripSuffix"   DataText "function"
      -- Bare forms (unqualified imports)
      , mkGlobal "pack"            DataText "function"
      , mkGlobal "unpack"          DataText "function"
      , mkGlobal "Text"            DataText "constructor"
      ]

    dataMapGlobals =
      [ mkGlobal "Map.empty"           DataMap "constant"
      , mkGlobal "Map.singleton"       DataMap "function"
      , mkGlobal "Map.insert"          DataMap "function"
      , mkGlobal "Map.delete"          DataMap "function"
      , mkGlobal "Map.lookup"          DataMap "function"
      , mkGlobal "Map.member"          DataMap "function"
      , mkGlobal "Map.notMember"       DataMap "function"
      , mkGlobal "Map.findWithDefault" DataMap "function"
      , mkGlobal "Map.fromList"        DataMap "function"
      , mkGlobal "Map.toList"          DataMap "function"
      , mkGlobal "Map.keys"            DataMap "function"
      , mkGlobal "Map.elems"           DataMap "function"
      , mkGlobal "Map.size"            DataMap "function"
      , mkGlobal "Map.null"            DataMap "function"
      , mkGlobal "Map.union"           DataMap "function"
      , mkGlobal "Map.unionWith"       DataMap "function"
      , mkGlobal "Map.intersection"    DataMap "function"
      , mkGlobal "Map.difference"      DataMap "function"
      , mkGlobal "Map.map"             DataMap "function"
      , mkGlobal "Map.mapWithKey"      DataMap "function"
      , mkGlobal "Map.filter"          DataMap "function"
      , mkGlobal "Map.filterWithKey"   DataMap "function"
      , mkGlobal "Map.foldlWithKey"    DataMap "function"
      , mkGlobal "Map.foldrWithKey'"   DataMap "function"
      , mkGlobal "Map.adjust"          DataMap "function"
      , mkGlobal "Map.alter"           DataMap "function"
      , mkGlobal "Map.mapKeys"         DataMap "function"
      ]

    dataSetGlobals =
      [ mkGlobal "Set.empty"           DataSet "constant"
      , mkGlobal "Set.singleton"       DataSet "function"
      , mkGlobal "Set.insert"          DataSet "function"
      , mkGlobal "Set.delete"          DataSet "function"
      , mkGlobal "Set.member"          DataSet "function"
      , mkGlobal "Set.notMember"       DataSet "function"
      , mkGlobal "Set.fromList"        DataSet "function"
      , mkGlobal "Set.toList"          DataSet "function"
      , mkGlobal "Set.size"            DataSet "function"
      , mkGlobal "Set.null"            DataSet "function"
      , mkGlobal "Set.union"           DataSet "function"
      , mkGlobal "Set.intersection"    DataSet "function"
      , mkGlobal "Set.difference"      DataSet "function"
      , mkGlobal "Set.map"             DataSet "function"
      , mkGlobal "Set.filter"          DataSet "function"
      , mkGlobal "Set.fold"            DataSet "function"
      ]

    dataIntMapGlobals =
      [ mkGlobal "IntMap.empty"        DataIntMap "constant"
      , mkGlobal "IntMap.insert"       DataIntMap "function"
      , mkGlobal "IntMap.lookup"       DataIntMap "function"
      , mkGlobal "IntMap.fromList"     DataIntMap "function"
      ]

    dataHashMapGlobals =
      [ mkGlobal "HashMap.empty"       DataHashMap "constant"
      , mkGlobal "HashMap.insert"      DataHashMap "function"
      , mkGlobal "HashMap.lookup"      DataHashMap "function"
      , mkGlobal "HashMap.fromList"    DataHashMap "function"
      ]

    dataByteStringGlobals =
      [ mkGlobal "BS.pack"            DataByteString "function"
      , mkGlobal "BS.unpack"          DataByteString "function"
      , mkGlobal "BS.length"          DataByteString "function"
      , mkGlobal "BS.null"            DataByteString "function"
      , mkGlobal "BS.empty"           DataByteString "constant"
      , mkGlobal "BS.readFile"        DataByteString "function"
      , mkGlobal "BS.writeFile"       DataByteString "function"
      , mkGlobal "BS.hPut"            DataByteString "function"
      , mkGlobal "BS.hGet"            DataByteString "function"
      , mkGlobal "BSL.pack"           DataByteString "function"
      , mkGlobal "BSL.unpack"         DataByteString "function"
      , mkGlobal "BSL.readFile"       DataByteString "function"
      , mkGlobal "BSL.writeFile"      DataByteString "function"
      ]

    mtlGlobals =
      [ mkGlobal "asks"            MTL "function"          -- 107x
      , mkGlobal "liftIO"          MTL "function"
      , mkGlobal "lift"            MTL "function"
      ]

-- | Function index: (file, name) -> node ID.
-- Replicates the same index that 'HaskellLocalRefs' builds, so we can
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

-- | Extract the last segment of a Haskell qualified name.
--
-- @"Map.insert"@ -> @"insert"@
-- @"T.pack"@     -> @"pack"@
-- @"foo"@        -> @"foo"@
lastSegment :: Text -> Text
lastSegment t =
  case T.splitOn "." t of
    [] -> t
    xs -> Prelude.last xs

-- | Check whether a local-file FUNCTION matches this CALL node.
-- If a same-file FUNCTION matches by name or last dot-segment, the call
-- is already resolvable by other plugins.
isResolvedByLocalFunction :: FuncIndex -> GraphNode -> Bool
isResolvedByLocalFunction idx n =
  let file = gnFile n
      name = gnName n
      seg  = lastSegment name
  in Map.member (file, name) idx
     || (seg /= name && Map.member (file, seg) idx)

-- | Build a virtual GLOBAL_DEFINITION node for a matched Haskell stdlib global.
mkGlobalNode :: GlobalDef -> GraphNode
mkGlobalNode def = GraphNode
  { gnId        = "HASKELL_GLOBAL::" <> gdName def
  , gnType      = "GLOBAL_DEFINITION"
  , gnName      = gdName def
  , gnFile      = "<haskell-stdlib>"
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
  , geTarget   = "HASKELL_GLOBAL::" <> gdName def
  , geType     = "CALLS"
  , geMetadata = Map.fromList
      [ ("resolvedVia",    MetaText "haskell-globals")
      , ("globalCategory", MetaText (showCategory (gdCategory def)))
      ]
  }

-- | Accumulator for the fold: emitted global nodes, emitted edges, and
-- the set of global names already seen (for deduplication).
type ResolveAcc = ([GraphNode], [GraphEdge], Set Text)

-- | Try to match a single CALL node against the globals database.
--
-- Matching strategy:
--   1. Exact name match (e.g., @"Map.insert"@ -> @"Map.insert"@)
--   2. Last @.@-segment match (e.g., @"Data.Map.insert"@ -> @"insert"@)
--
-- If matched, emit the GLOBAL_DEFINITION node (deduplicated) and a CALLS edge.
resolveCall :: ResolveAcc -> GraphNode -> ResolveAcc
resolveCall (nodes, edges, seen) callNode =
  let name = gnName callNode
      seg  = lastSegment name
      -- Try exact match first, then last-segment match
      mDef = case Map.lookup name globalsDb of
        Just d  -> Just d
        Nothing
          | seg /= name -> Map.lookup seg globalsDb
          | otherwise    -> Nothing
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
-- Filters CALL nodes to only those that no local FUNCTION matches
-- (no same-file FUNCTION match), then matches against the stdlib database.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let funcIdx    = buildFuncIndex nodes
      callNodes  = filter (\n -> gnType n == "CALL") nodes
      unresolved = filter (not . isResolvedByLocalFunction funcIdx) callNodes
      (globalNodes, edges, _seen) = foldl resolveCall ([], [], Set.empty) unresolved
  in Prelude.map EmitNode globalNodes ++ Prelude.map EmitEdge edges

-- | Entry point: read nodes from stdin, resolve unresolved calls
-- against the Haskell stdlib database, and emit results.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)

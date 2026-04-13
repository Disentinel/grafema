{-# LANGUAGE OverloadedStrings #-}
-- | BEAM public-API wrapper call resolution (REG-1098 W6).
--
-- The beam-analyzer W5 pass marks single-expression wrapper @def@s (e.g.
-- @def emit(a, b), do: GenServer.cast(__MODULE__, {:emit, a, b})@) with a
-- @wraps@ metadata sub-object on the FUNCTION node describing the side
-- effect the wrapper hides:
--
-- > { kind: "cast"
-- > , target: "module_self" | "literal" | "var"
-- > , target_hint: "Elixir.Ichi.EventBus" | null
-- > , message_shape: [...]   -- opaque shape tree, copied verbatim
-- > , topic: "events" | null -- only for sub/broadcast
-- > }
--
-- This resolver walks the graph, finds every CALL that can be resolved
-- to a wrapper FUNCTION (using the same indices as BeamLocalRefs), and
-- emits one virtual side-effect edge per call whose target depends on
-- the wrapper kind:
--
--   * call / cast / send / send_after  ->  SENDS_TO the wrapper's target PROCESS
--   * sub                              ->  SUBSCRIBES_TO the PUBSUB_TOPIC (from caller MODULE)
--   * broadcast                        ->  BROADCASTS_TO the PUBSUB_TOPIC
--
-- For @target = "var"@ the resolver cannot know the target at static
-- time, so it silently skips. For missing PUBSUB_TOPIC nodes the
-- resolver falls back to the PUBSUB_TOPIC that shares the wrapper's
-- file, and finally to a synthetic topic node.
--
-- NOTE: W5 does not record which pubsub *server* a subscribe/broadcast
-- wrapper targets; the resolver picks the only matching topic name if
-- unique, else the one colocated with the wrapper. This is a known
-- gap (see README for the W5 follow-up).
module BeamWrapperResolution (run, resolveAll, readWrapInfo, WrapInfo(..), WrapKind(..), WrapTarget(..)) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..), gnSemanticId)
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import Data.Maybe (listToMaybe, fromMaybe)
import Text.Read (readMaybe)

-- ---------------------------------------------------------------------
-- WrapInfo parsing
-- ---------------------------------------------------------------------

data WrapKind
  = WKCall
  | WKCast
  | WKSend
  | WKSendAfter
  | WKSub
  | WKBroadcast
  deriving (Eq, Show)

data WrapTarget
  = WTModuleSelf
  | WTLiteral !Text
  | WTVar
  deriving (Eq, Show)

data WrapInfo = WrapInfo
  { wiKind         :: !WrapKind
  , wiTarget       :: !WrapTarget
  , wiMessageShape :: !(Maybe MetaValue)
  , wiTopic        :: !(Maybe Text)
  } deriving (Eq, Show)

-- | Read and parse the @wraps@ field from a FUNCTION node's metadata.
-- Returns Nothing if the field is absent, malformed, or of an
-- unrecognised kind.
readWrapInfo :: GraphNode -> Maybe WrapInfo
readWrapInfo node = do
  wrapsVal <- Map.lookup "wraps" (gnMetadata node)
  fields <- case wrapsVal of
    MetaMap m -> Just m
    _         -> Nothing
  kindText <- extractText "kind" fields
  kind <- parseKind kindText
  let target = parseTarget fields
      messageShape = Map.lookup "message_shape" fields
      topic = extractText "topic" fields
  pure $ WrapInfo kind target messageShape topic

extractText :: Text -> Map Text MetaValue -> Maybe Text
extractText k m = case Map.lookup k m of
  Just (MetaText t) -> Just t
  _                 -> Nothing

parseKind :: Text -> Maybe WrapKind
parseKind t = case t of
  "call"       -> Just WKCall
  "cast"       -> Just WKCast
  "send"       -> Just WKSend
  "send_after" -> Just WKSendAfter
  "sub"        -> Just WKSub
  "broadcast"  -> Just WKBroadcast
  _            -> Nothing

parseTarget :: Map Text MetaValue -> WrapTarget
parseTarget fields =
  case extractText "target" fields of
    Just "module_self" -> WTModuleSelf
    Just "literal"     -> WTLiteral (fromMaybe "" (extractText "target_hint" fields))
    Just "var"         -> WTVar
    _                  -> WTVar

-- ---------------------------------------------------------------------
-- CALL resolution (minimal replay of BeamLocalRefs logic)
-- ---------------------------------------------------------------------

-- | @(file, name-with-arity) -> FUNCTION node id@ for same-file lookups.
type LocalIdx = Map (Text, Text) Text

-- | @(file, baseName) -> FUNCTION node id@ (arity-agnostic fallback).
type LocalBaseIdx = Map (Text, Text) Text

-- | @(module, baseName, arity) -> FUNCTION id@ for cross-file lookups.
type QualIdx = Map (Text, Text, Int) Text

-- | @(module, baseName) -> FUNCTION id@ fallback.
type QualBaseIdx = Map (Text, Text) Text

-- | Maps every dot-suffix of a module name to the full module name(s).
type SuffixIdx = Map Text [Text]

buildLocalIdx :: [GraphNode] -> LocalIdx
buildLocalIdx ns = Map.fromList
  [ ((gnFile n, gnName n), gnId n)
  | n <- ns, gnType n == "FUNCTION", not (T.null (gnName n))
  ]

buildLocalBaseIdx :: [GraphNode] -> LocalBaseIdx
buildLocalBaseIdx ns = Map.fromList
  [ ((gnFile n, extractBaseName (gnName n)), gnId n)
  | n <- ns, gnType n == "FUNCTION", not (T.null (gnName n))
  ]

buildQualIdx :: [GraphNode] -> (QualIdx, QualBaseIdx, SuffixIdx)
buildQualIdx ns =
  let moduleNames = [ gnName n | n <- ns, gnType n == "MODULE", not (T.null (gnName n)) ]
      sufIdx = foldl addSuffixes Map.empty moduleNames
      entries =
        [ (modName, extractBaseName (gnName n), extractArity (gnName n), gnId n)
        | n <- ns
        , gnType n == "FUNCTION"
        , not (T.null (gnName n))
        , Just modName <- [extractModuleFromId (gnSemanticId n)]
        ]
      qIdx = Map.fromList
        [ ((m, b, a), nid) | (m, b, Just a, nid) <- entries ]
      qBase = Map.fromList
        [ ((m, b), nid) | (m, b, _, nid) <- entries ]
  in (qIdx, qBase, sufIdx)

addSuffixes :: SuffixIdx -> Text -> SuffixIdx
addSuffixes idx modName =
  foldl (\acc s -> Map.insertWith (++) s [modName] acc) idx (dotSuffixes modName)

dotSuffixes :: Text -> [Text]
dotSuffixes t
  | T.null t  = []
  | otherwise = t : case T.breakOn "." t of
      (_, rest)
        | T.null rest -> []
        | otherwise   -> dotSuffixes (T.drop 1 rest)

extractBaseName :: Text -> Text
extractBaseName t = fst (T.breakOn "/" t)

extractArity :: Text -> Maybe Int
extractArity t = case T.breakOn "/" t of
  (_, rest)
    | T.null rest -> Nothing
    | otherwise   -> readMaybe (T.unpack (T.drop 1 rest))

-- | Extract "[in:ModuleName]" marker (handles URI-encoded form too).
extractModuleFromId :: Text -> Maybe Text
extractModuleFromId nid =
  tryMarker "[in:" "]" nid <|.> tryMarker "%5Bin:" "%5D" nid
  where
    Just x  <|.> _ = Just x
    Nothing <|.> y = y

    tryMarker open close s =
      case T.breakOn open s of
        (_, rest) | T.null rest -> Nothing
                  | otherwise ->
            let afterPrefix = T.drop (T.length open) rest
            in case T.breakOn close afterPrefix of
              (m, suffix) | T.null suffix -> Nothing
                          | otherwise     -> Just m

callArity :: GraphNode -> Maybe Int
callArity n = case Map.lookup "arity" (gnMetadata n) of
  Just (MetaInt i) -> Just i
  _                -> Nothing

isQualified :: Text -> Bool
isQualified = T.any (== '.')

splitQualified :: Text -> (Text, Text)
splitQualified name =
  let parts = T.splitOn "." name
  in (T.intercalate "." (init parts), last parts)

-- | Resolve a CALL node to a same- or cross-file FUNCTION id.
resolveCallTarget
  :: LocalIdx -> LocalBaseIdx
  -> QualIdx -> QualBaseIdx -> SuffixIdx
  -> GraphNode
  -> Maybe Text
resolveCallTarget lIdx lBase qIdx qBase sIdx callNode =
  let file = gnFile callNode
      name = gnName callNode
      base = extractBaseName name
  in case Map.lookup (file, name) lIdx of
    Just t -> Just t
    Nothing -> case Map.lookup (file, base) lBase of
      Just t -> Just t
      Nothing
        | isQualified base ->
            let (modAlias, funcName) = splitQualified base
                mArity = callArity callNode
            in lookupQualified qIdx qBase sIdx modAlias funcName mArity
        | otherwise -> Nothing

lookupQualified
  :: QualIdx -> QualBaseIdx -> SuffixIdx
  -> Text -> Text -> Maybe Int
  -> Maybe Text
lookupQualified qIdx qBase sIdx modAlias funcName mArity =
  let tryExact fullMod = case mArity of
        Just a -> case Map.lookup (fullMod, funcName, a) qIdx of
          Just t -> Just t
          Nothing -> Map.lookup (fullMod, funcName) qBase
        Nothing -> Map.lookup (fullMod, funcName) qBase
  in case tryExact modAlias of
    Just t  -> Just t
    Nothing -> case Map.lookup modAlias sIdx of
      Just fms -> listToMaybe [ t | fm <- fms, Just t <- [tryExact fm] ]
      Nothing  -> Nothing

-- ---------------------------------------------------------------------
-- Side-effect indices
-- ---------------------------------------------------------------------

-- | file -> PROCESS node id. A file usually contains at most one PROCESS
-- for `module_self` wrappers.
type FileProcessIdx = Map Text Text

-- | module-name -> PROCESS node id. Built from PROCESS nodes whose name
-- matches a module name (the beam-analyzer emits PROCESS nodes named
-- after the host GenServer module).
type ModuleProcessIdx = Map Text Text

-- | file -> MODULE node id. One MODULE per file in Elixir (typical).
type FileModuleIdx = Map Text Text

-- | topic -> [PUBSUB_TOPIC id]. Matched by @name@/@topic@ metadata.
type TopicIdx = Map Text [GraphNode]

buildFileProcessIdx :: [GraphNode] -> FileProcessIdx
buildFileProcessIdx ns = Map.fromList
  [ (gnFile n, gnId n) | n <- ns, gnType n == "PROCESS" ]

-- | Build @modName -> PROCESS id@. Two strategies, in order of
-- precision:
--   1. If the PROCESS node has @metadata.module@, use that.
--   2. Otherwise, use the PROCESS node's @name@.
-- Ambiguity is resolved by @Map.fromList@ keeping the last entry; for
-- real graphs, module-name-to-PROCESS is effectively unique.
buildModuleProcessIdx :: [GraphNode] -> ModuleProcessIdx
buildModuleProcessIdx ns = Map.fromList
  [ (key, gnId n)
  | n <- ns
  , gnType n == "PROCESS"
  , let key = case Map.lookup "module" (gnMetadata n) of
          Just (MetaText t) -> t
          _ -> gnName n
  , not (T.null key)
  ]

buildFileModuleIdx :: [GraphNode] -> FileModuleIdx
buildFileModuleIdx ns = Map.fromList
  [ (gnFile n, gnId n) | n <- ns, gnType n == "MODULE" ]

buildTopicIdx :: [GraphNode] -> TopicIdx
buildTopicIdx ns =
  let pairs =
        [ (topicName, n)
        | n <- ns
        , gnType n == "PUBSUB_TOPIC"
        , Just topicName <- [topicFor n]
        ]
  in foldr (\(t, n) acc -> Map.insertWith (++) t [n] acc) Map.empty pairs
  where
    topicFor n = case Map.lookup "topic" (gnMetadata n) of
      Just (MetaText t) -> Just t
      _ -> let nm = gnName n in if T.null nm then Nothing else Just nm

-- ---------------------------------------------------------------------
-- Main resolution
-- ---------------------------------------------------------------------

-- | Core entry: take all nodes, return PluginCommand list with virtual
-- edges (and occasionally a synthetic PUBSUB_TOPIC node).
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let lIdx = buildLocalIdx nodes
      lBase = buildLocalBaseIdx nodes
      (qIdx, qBase, sIdx) = buildQualIdx nodes
      fileProc = buildFileProcessIdx nodes
      modProc = buildModuleProcessIdx nodes
      fileMod = buildFileModuleIdx nodes
      topicIdx = buildTopicIdx nodes
      funcById = Map.fromList [ (gnId n, n) | n <- nodes, gnType n == "FUNCTION" ]
      calls = filter ((== "CALL") . gnType) nodes
      emits = concatMap (processCall lIdx lBase qIdx qBase sIdx
                                     fileProc modProc fileMod topicIdx funcById)
                        calls
  in emits

processCall
  :: LocalIdx -> LocalBaseIdx
  -> QualIdx -> QualBaseIdx -> SuffixIdx
  -> FileProcessIdx -> ModuleProcessIdx -> FileModuleIdx -> TopicIdx
  -> Map Text GraphNode
  -> GraphNode
  -> [PluginCommand]
processCall lIdx lBase qIdx qBase sIdx fileProc modProc fileMod topicIdx funcById callNode =
  case resolveCallTarget lIdx lBase qIdx qBase sIdx callNode of
    Nothing -> []
    Just targetFnId ->
      case Map.lookup targetFnId funcById of
        Nothing -> []
        Just fnNode -> case readWrapInfo fnNode of
          Nothing -> []
          Just wi -> emitForWrapper fileProc modProc fileMod topicIdx callNode fnNode wi

-- | Produce commands for a single resolved wrapper CALL.
emitForWrapper
  :: FileProcessIdx -> ModuleProcessIdx -> FileModuleIdx -> TopicIdx
  -> GraphNode      -- ^ caller CALL node
  -> GraphNode      -- ^ wrapper FUNCTION node
  -> WrapInfo
  -> [PluginCommand]
emitForWrapper fileProc modProc fileMod topicIdx callNode fnNode wi =
  let wrapperLabel = wrapperLabelOf fnNode
      baseMeta viaPrefix =
        let viaText = viaPrefix <> " (wrapper: " <> wrapperLabel <> ")"
            withShape m = case wiMessageShape wi of
              Just s  -> Map.insert "message_shape" s m
              Nothing -> m
        in withShape (Map.singleton "via" (MetaText viaText))
  in case wiKind wi of
    WKCast -> sendsToProcess fileProc modProc callNode fnNode wi (baseMeta "GenServer.cast")
    WKCall -> sendsToProcess fileProc modProc callNode fnNode wi (baseMeta "GenServer.call")
    WKSend -> sendsToProcess fileProc modProc callNode fnNode wi (baseMeta "Process.send")
    WKSendAfter -> sendsToProcess fileProc modProc callNode fnNode wi (baseMeta "Process.send_after")
    WKSub ->
      case Map.lookup (gnFile callNode) fileMod of
        Nothing -> []
        Just callerModId ->
          topicEmits topicIdx fnNode wi $ \topicNode topicCmds ->
            let edge = GraphEdge
                  { geSource   = callerModId
                  , geTarget   = gnId topicNode
                  , geType     = "SUBSCRIBES_TO"
                  , geMetadata = baseMeta "Phoenix.PubSub.subscribe"
                  }
            in EmitEdge edge : topicCmds
    WKBroadcast ->
      topicEmits topicIdx fnNode wi $ \topicNode topicCmds ->
        let edge = GraphEdge
              { geSource   = gnId callNode
              , geTarget   = gnId topicNode
              , geType     = "BROADCASTS_TO"
              , geMetadata = baseMeta "Phoenix.PubSub.broadcast"
              }
        in EmitEdge edge : topicCmds

-- | Resolve the PROCESS target for call/cast/send wrappers and emit
-- the SENDS_TO edge if found.
sendsToProcess
  :: FileProcessIdx -> ModuleProcessIdx
  -> GraphNode      -- caller CALL
  -> GraphNode      -- wrapper FUNCTION
  -> WrapInfo
  -> Map Text MetaValue
  -> [PluginCommand]
sendsToProcess fileProc modProc callNode fnNode wi edgeMeta =
  case wiTarget wi of
    WTVar -> []
    WTModuleSelf ->
      case Map.lookup (gnFile fnNode) fileProc of
        Just pid -> [mkSendsTo callNode pid edgeMeta]
        Nothing  -> []
    WTLiteral hint ->
      let modName = stripElixirPrefix hint
      in case Map.lookup modName modProc of
        Just pid -> [mkSendsTo callNode pid edgeMeta]
        Nothing  ->
          -- Fall back to any PROCESS in the hint module's file, if we
          -- can find a MODULE with the same name. Keeps us honest on
          -- literal targets whose PROCESS lacks the metadata.module
          -- annotation.
          []

mkSendsTo :: GraphNode -> Text -> Map Text MetaValue -> PluginCommand
mkSendsTo callNode pid meta = EmitEdge GraphEdge
  { geSource   = gnId callNode
  , geTarget   = pid
  , geType     = "SENDS_TO"
  , geMetadata = meta
  }

stripElixirPrefix :: Text -> Text
stripElixirPrefix t
  | "Elixir." `T.isPrefixOf` t = T.drop 7 t
  | otherwise                  = t

-- | Resolve the PUBSUB_TOPIC for a sub/broadcast wrapper. If the graph
-- has a matching topic node, pass it to the continuation. If not,
-- synthesise one and include the EmitNode command ahead of whatever
-- the continuation produces.
topicEmits
  :: TopicIdx
  -> GraphNode -- wrapper FUNCTION (used to locate file-local topic)
  -> WrapInfo
  -> (GraphNode -> [PluginCommand] -> [PluginCommand])
  -> [PluginCommand]
topicEmits topicIdx fnNode wi k =
  case wiTopic wi of
    Nothing -> []
    Just topic ->
      let candidates = fromMaybe [] (Map.lookup topic topicIdx)
          picked = case candidates of
            []     -> Nothing
            [only] -> Just (only, [])
            (first:_) ->
              -- Prefer a topic node in the wrapper's own file when
              -- multiple candidates share the same topic name.
              case filter ((== gnFile fnNode) . gnFile) candidates of
                (n:_) -> Just (n, [])
                []    -> Just (first, [])
      in case picked of
        Just (node, extra) -> k node extra
        Nothing ->
          let synthId = "PUBSUB_TOPIC::<unknown>::" <> topic
              synthNode = GraphNode
                { gnId        = synthId
                , gnType      = "PUBSUB_TOPIC"
                , gnName      = topic
                , gnFile      = ""
                , gnLine      = 0
                , gnColumn    = 0
                , gnEndLine   = 0
                , gnEndColumn = 0
                , gnExported  = False
                , gnMetadata  = Map.fromList
                    [ ("topic", MetaText topic)
                    , ("pubsub", MetaText "<unknown>")
                    , ("source", MetaText "beam-wrapper-resolve")
                    ]
                }
          in k synthNode [EmitNode synthNode]

-- | Format a wrapper label like @"Mod.fn/N"@ for via-metadata.
wrapperLabelOf :: GraphNode -> Text
wrapperLabelOf n =
  let modPart = fromMaybe "?" (extractModuleFromId (gnSemanticId n))
  in modPart <> "." <> gnName n

-- | CLI entry point.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)

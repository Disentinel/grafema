{-# LANGUAGE OverloadedStrings #-}
-- | BEAM MessageFlow findings pass (REG-1098 W9).
--
-- Consumes the graph produced by W1..W8 (MESSAGE_TYPE / PROCESS /
-- PUBSUB_TOPIC nodes, SENDS_TO / SUBSCRIBES_TO / BROADCASTS_TO edges)
-- and emits ISSUE nodes for six kinds of message-flow findings:
--
--   1. silent_handler         -- non-trivial handler whose body has no effects
--   2. catchall_sink          -- handle_info(_, state) -> state
--   3. unreachable_handler    -- pattern that can never be matched by any static sender
--   4. orphan_send            -- send of a shape no handler can receive
--   5. topic_mismatch         -- PUBSUB_TOPIC with broadcasts but no subs (or vice-versa)
--   6. heterogeneous_key_type -- same map key used with incompatible literal kinds (Mamori bug)
--
-- Each finding is a single ISSUE GraphNode with @finding_kind@,
-- @severity@, @source@, @description@, and a structured @context@ map
-- in its metadata, plus a CONTAINS edge from the containing MODULE.
module BeamMessageFindings
  ( runFindings
  , run
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import Data.Maybe (fromMaybe)
import Data.List (sort, nub)
import Data.Char (intToDigit)
import Data.Bits (shiftR, (.&.))

import BeamShape

-- ---------------------------------------------------------------------
-- Entry point
-- ---------------------------------------------------------------------

-- | Core entry: consume the graph, emit ISSUE nodes and CONTAINS edges.
runFindings :: [GraphNode] -> [GraphEdge] -> [PluginCommand]
runFindings nodes edges =
  let fileModIdx   = buildFileModuleIdx nodes
      msgTypes     = [ n | n <- nodes, gnType n == "MESSAGE_TYPE" ]
      processNodes = [ n | n <- nodes, gnType n == "PROCESS" ]
      topicNodes   = [ n | n <- nodes, gnType n == "PUBSUB_TOPIC" ]
      sendsEdges   = [ e | e <- edges, geType e == "SENDS_TO" ]
      subEdges     = [ e | e <- edges, geType e == "SUBSCRIBES_TO" ]
      bcastEdges   = [ e | e <- edges, geType e == "BROADCASTS_TO" ]
      -- index: PROCESS id -> [MESSAGE_TYPE] belonging to that process.
      -- Linkage: MESSAGE_TYPE.file == PROCESS.file (one PROCESS per file).
      processByFile = Map.fromList [ (gnFile p, p) | p <- processNodes ]
      msgsForProcess p =
        [ m | m <- msgTypes, gnFile m == gnFile p ]

      findings =
        concatMap (silentHandler fileModIdx) msgTypes
        ++ concatMap (catchallSink fileModIdx) msgTypes
        ++ concatMap (unreachableHandler fileModIdx sendsEdges processByFile msgsForProcess) msgTypes
        ++ concatMap (orphanSend fileModIdx processNodes msgsForProcess) sendsEdges
        ++ concatMap (topicMismatch subEdges bcastEdges fileModIdx) topicNodes
        ++ heterogeneousKeyType fileModIdx msgTypes

  in concatMap toCommands findings

-- | Stdin/stdout CLI entry. In CLI mode we only see nodes (existing
-- protocol) — we read edges from those nodes' metadata bundle is not
-- available, so for the CLI variant we collect only nodes and call
-- 'runFindings' with an empty edge list. For full power use the daemon
-- dispatch or extend the protocol later.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (runFindings nodes [])

-- ---------------------------------------------------------------------
-- Finding representation
-- ---------------------------------------------------------------------

data Finding = Finding
  { fKind        :: !Text
  , fSeverity    :: !Text
  , fDescription :: !Text
  , fFile        :: !Text
  , fLine        :: !Int
  , fColumn      :: !Int
  , fContext     :: !(Map Text MetaValue)
  , fModuleId    :: !(Maybe Text)   -- containing MODULE id
  , fDedupeKey   :: !Text           -- stable seed for the ID hash
  }

toCommands :: Finding -> [PluginCommand]
toCommands f =
  let shortHash = hashShort (fDedupeKey f)
      issueId   = "<issue>->ISSUE->" <> fKind f <> "-" <> shortHash
      meta = Map.fromList
        [ ("finding_kind", MetaText (fKind f))
        , ("severity",     MetaText (fSeverity f))
        , ("source",       MetaText "beam-message-findings")
        , ("description",  MetaText (fDescription f))
        , ("context",      MetaMap (fContext f))
        ]
      issueNode = GraphNode
        { gnId        = issueId
        , gnType      = "ISSUE"
        , gnName      = fKind f <> ": " <> firstLine (fDescription f)
        , gnFile      = fFile f
        , gnLine      = fLine f
        , gnColumn    = fColumn f
        , gnEndLine   = 0
        , gnEndColumn = 0
        , gnExported  = False
        , gnMetadata  = meta
        }
      containsEdge = case fModuleId f of
        Just modId ->
          [ EmitEdge GraphEdge
              { geSource   = modId
              , geTarget   = issueId
              , geType     = "CONTAINS"
              , geMetadata = Map.empty
              }
          ]
        Nothing -> []
  in EmitNode issueNode : containsEdge

firstLine :: Text -> Text
firstLine = T.take 120 . T.takeWhile (/= '\n')

-- | Tiny, deterministic 8-hex hash — stable per dedupe-key, good enough
-- to make ISSUE ids unique per finding without pulling cryptonite.
hashShort :: Text -> Text
hashShort t =
  let h = T.foldl' step 2166136261 t
      step :: Int -> Char -> Int
      step acc c = ((acc `xor'` fromEnum c) * 16777619) .&. 0xFFFFFFFF
      xor' :: Int -> Int -> Int
      xor' a b = a + b - 2 * (a .&. b)
  in T.pack (hex8 h)
  where
    hex8 n = [ intToDigit (fromIntegral ((n `shiftR` s) .&. 0xF)) | s <- [28,24,20,16,12,8,4,0] ]

-- ---------------------------------------------------------------------
-- Shared indices / helpers
-- ---------------------------------------------------------------------

type FileModuleIdx = Map Text GraphNode

buildFileModuleIdx :: [GraphNode] -> FileModuleIdx
buildFileModuleIdx ns = Map.fromList
  [ (gnFile n, n) | n <- ns, gnType n == "MODULE" ]

moduleForFile :: FileModuleIdx -> Text -> Maybe GraphNode
moduleForFile idx f = Map.lookup f idx

moduleIdForFile :: FileModuleIdx -> Text -> Maybe Text
moduleIdForFile idx f = gnId <$> moduleForFile idx f

moduleNameForFile :: FileModuleIdx -> Text -> Text
moduleNameForFile idx f = maybe "<unknown>" gnName (moduleForFile idx f)

-- | Read an Int-ish metadata field, tolerating it being stored as
-- MetaInt or MetaText.
metaInt :: Text -> GraphNode -> Maybe Int
metaInt k n = case Map.lookup k (gnMetadata n) of
  Just (MetaInt i) -> Just i
  Just (MetaText t) -> case reads (T.unpack t) of
    [(x, "")] -> Just x
    _         -> Nothing
  _ -> Nothing

metaBool :: Text -> GraphNode -> Maybe Bool
metaBool k n = case Map.lookup k (gnMetadata n) of
  Just (MetaBool b) -> Just b
  _ -> Nothing

metaShape :: Text -> Map Text MetaValue -> Maybe Shape
metaShape k m = parseShape <$> Map.lookup k m

handlerShape :: GraphNode -> Maybe Shape
handlerShape n = metaShape "pattern_shape" (gnMetadata n)

sendShape :: GraphEdge -> Maybe Shape
sendShape e = metaShape "message_shape" (geMetadata e)

sendVia :: GraphEdge -> Text
sendVia e = case Map.lookup "via" (geMetadata e) of
  Just (MetaText t) -> t
  _ -> ""

-- ---------------------------------------------------------------------
-- 1. silent_handler
-- ---------------------------------------------------------------------

silentHandler :: FileModuleIdx -> GraphNode -> [Finding]
silentHandler fileMod n
  | gnType n /= "MESSAGE_TYPE" = []
  | gnName n `notElem` ["cast", "info"] = []  -- call replies are an effect channel
  | fromMaybe False (metaBool "catchall" n)  = []
  | fromMaybe 1 (metaInt "body_total_calls" n) /= 0 = []
  | isTrivialPattern shape = []
  | otherwise =
      let line = fromMaybe (gnLine n) (metaInt "handler_line" n)
          desc = "handle_" <> gnName n <> "/2 clause at line "
                 <> T.pack (show line)
                 <> " has no side effects in body — non-trivial tagged message may be silently dropped"
          ctx = Map.fromList
            [ ("handler_kind", MetaText (gnName n))
            , ("handler_line", MetaInt line)
            , ("handler_function",
                maybe MetaNull MetaText (lookupMetaText "handler_function" (gnMetadata n)))
            , ("pattern_shape",
                fromMaybe MetaNull (Map.lookup "pattern_shape" (gnMetadata n)))
            , ("module", MetaText (moduleNameForFile fileMod (gnFile n)))
            ]
      in [Finding
           { fKind = "silent_handler"
           , fSeverity = "warning"
           , fDescription = desc
           , fFile = gnFile n
           , fLine = line
           , fColumn = gnColumn n
           , fContext = ctx
           , fModuleId = moduleIdForFile fileMod (gnFile n)
           , fDedupeKey = "silent|" <> gnId n
           }]
  where
    shape = handlerShape n

-- | A pattern is "trivial" (= uninteresting for the silent-handler
-- finding) if it is:
--   * a bare atom literal (timer-style @:tick@, @:poll@, …)
--   * a catch-rest tuple @{:tag, _, _, ...}@ whose trailing elements are
--     all wildcards
--   * parse-failed (SUnknown) — not actionable
isTrivialPattern :: Maybe Shape -> Bool
isTrivialPattern Nothing          = True
isTrivialPattern (Just SUnknown)  = True
isTrivialPattern (Just (SAtom _)) = True  -- bare :tick / :poll
isTrivialPattern (Just (STuple (SAtom _ : rest)))
  | all isWild rest = True
  where
    isWild SAny = True
    isWild _    = False
isTrivialPattern _ = False

lookupMetaText :: Text -> Map Text MetaValue -> Maybe Text
lookupMetaText k m = case Map.lookup k m of
  Just (MetaText t) -> Just t
  _ -> Nothing

-- ---------------------------------------------------------------------
-- 2. catchall_sink
-- ---------------------------------------------------------------------

catchallSink :: FileModuleIdx -> GraphNode -> [Finding]
catchallSink fileMod n
  | gnType n /= "MESSAGE_TYPE" = []
  | gnName n /= "info" = []
  | not (fromMaybe False (metaBool "catchall" n)) = []
  | fromMaybe 1 (metaInt "body_total_calls" n) /= 0 = []
  | otherwise =
      let line = fromMaybe (gnLine n) (metaInt "handler_line" n)
          desc = "handle_info(_, state) at line " <> T.pack (show line)
                 <> " silently absorbs unmatched messages"
          ctx = Map.fromList
            [ ("module", MetaText (moduleNameForFile fileMod (gnFile n)))
            , ("handler_line", MetaInt line)
            ]
      in [Finding
           { fKind = "catchall_sink"
           , fSeverity = "info"
           , fDescription = desc
           , fFile = gnFile n
           , fLine = line
           , fColumn = gnColumn n
           , fContext = ctx
           , fModuleId = moduleIdForFile fileMod (gnFile n)
           , fDedupeKey = "catchall|" <> gnId n
           }]

-- ---------------------------------------------------------------------
-- 3. unreachable_handler
-- ---------------------------------------------------------------------

-- | A handler is unreachable if:
--
--   * it is not a catch-all,
--   * its parent PROCESS receives at least one static cross-module send
--     of the matching kind (so we are not falsely flagging modules that
--     are only addressed dynamically by pid),
--   * AND no such send's message_shape unifies with this handler's
--     pattern_shape.
unreachableHandler
  :: FileModuleIdx
  -> [GraphEdge]              -- all SENDS_TO edges
  -> Map Text GraphNode       -- file -> PROCESS
  -> (GraphNode -> [GraphNode])
  -> GraphNode
  -> [Finding]
unreachableHandler fileMod sends processByFile _ n
  | gnType n /= "MESSAGE_TYPE" = []
  | fromMaybe False (metaBool "catchall" n) = []
  | otherwise =
      case (Map.lookup (gnFile n) processByFile, handlerShape n) of
        (Just proc, Just hShape) ->
          let relevantSends =
                [ e | e <- sends
                    , geTarget e == gnId proc
                    , kindMatches (gnName n) (sendVia e)
                    ]
          in if null relevantSends
               then []  -- no static senders at all; can't prove unreachable
               else
                 let anyMatch = any (maybe False (unify hShape) . sendShape) relevantSends
                 in if anyMatch
                      then []
                      else
                        let line = fromMaybe (gnLine n) (metaInt "handler_line" n)
                            desc = "handle_" <> gnName n <> " clause at line "
                                   <> T.pack (show line)
                                   <> " has no matching sender — pattern is unreachable"
                            ctx = Map.fromList
                              [ ("module", MetaText (moduleNameForFile fileMod (gnFile n)))
                              , ("handler_line", MetaInt line)
                              , ("handler_kind", MetaText (gnName n))
                              , ("pattern_shape",
                                  fromMaybe MetaNull
                                    (Map.lookup "pattern_shape" (gnMetadata n)))
                              , ("process_id", MetaText (gnId proc))
                              , ("candidate_senders", MetaInt (length relevantSends))
                              ]
                        in [Finding
                             { fKind = "unreachable_handler"
                             , fSeverity = "warning"
                             , fDescription = desc
                             , fFile = gnFile n
                             , fLine = line
                             , fColumn = gnColumn n
                             , fContext = ctx
                             , fModuleId = moduleIdForFile fileMod (gnFile n)
                             , fDedupeKey = "unreach|" <> gnId n
                             }]
        _ -> []

-- | Map a handler kind (@call@/@cast@/@info@) to the SENDS_TO via
-- substring(s) that can legally deliver to it.
kindMatches :: Text -> Text -> Bool
kindMatches "call" via = "GenServer.call" `T.isInfixOf` via
kindMatches "cast" via = "GenServer.cast" `T.isInfixOf` via
kindMatches "info" via =
     "send" `T.isInfixOf` via
  || "Process.send_after" `T.isInfixOf` via
  || "PubSub" `T.isInfixOf` via
kindMatches _ _ = False

-- ---------------------------------------------------------------------
-- 4. orphan_send
-- ---------------------------------------------------------------------

orphanSend
  :: FileModuleIdx
  -> [GraphNode]               -- PROCESS nodes
  -> (GraphNode -> [GraphNode])
  -> GraphEdge
  -> [Finding]
orphanSend fileMod processes msgsFor e =
  case (findProc, sendShape e) of
    (Just proc, Just shp) ->
      let handlers = msgsFor proc
      in if null handlers
           then []  -- no handler of any kind, skip
           else
             let matching =
                   [ h | h <- handlers
                       , maybe False (unify shp) (handlerShape h)
                       ]
             in if not (null matching)
                  then []
                  else
                    let callerFile = senderFile
                        desc = "Message sent via " <> sendVia e
                               <> " to " <> gnName proc
                               <> " has no matching handler"
                        ctx = Map.fromList
                          [ ("target_process", MetaText (gnId proc))
                          , ("target_module",
                              MetaText (moduleNameForFile fileMod (gnFile proc)))
                          , ("caller_file", MetaText callerFile)
                          , ("via", MetaText (sendVia e))
                          , ("message_shape",
                              fromMaybe MetaNull
                                (Map.lookup "message_shape" (geMetadata e)))
                          ]
                    in [Finding
                         { fKind = "orphan_send"
                         , fSeverity = "warning"
                         , fDescription = desc
                         , fFile = callerFile
                         , fLine = 0
                         , fColumn = 0
                         , fContext = ctx
                         , fModuleId = moduleIdForFile fileMod callerFile
                         , fDedupeKey = "orphan|" <> geSource e <> "|" <> geTarget e
                         }]
    _ -> []
  where
    findProc = lookup (geTarget e) [ (gnId p, p) | p <- processes ]
    -- best-effort caller file: the sender id often starts with a file
    -- path; otherwise we fall back to the target process file.
    senderFile =
      let s = geSource e
      in if "->" `T.isInfixOf` s
           then T.takeWhile (/= '-') s
           else maybe "" gnFile findProc

-- ---------------------------------------------------------------------
-- 5. topic_mismatch
-- ---------------------------------------------------------------------

topicMismatch
  :: [GraphEdge]  -- SUBSCRIBES_TO
  -> [GraphEdge]  -- BROADCASTS_TO
  -> FileModuleIdx
  -> GraphNode    -- PUBSUB_TOPIC node
  -> [Finding]
topicMismatch subs bcasts fileMod topic =
  let tid      = gnId topic
      subCount = length [ e | e <- subs,   geTarget e == tid ]
      bcCount  = length [ e | e <- bcasts, geTarget e == tid ]
      topicName = case Map.lookup "topic" (gnMetadata topic) of
        Just (MetaText t) -> t
        _ -> gnName topic
      pubsub = case Map.lookup "pubsub" (gnMetadata topic) of
        Just (MetaText t) -> t
        _ -> "<unknown>"
      modId = moduleIdForFile fileMod (gnFile topic)
      mk severity kind desc =
        Finding
          { fKind = "topic_mismatch"
          , fSeverity = severity
          , fDescription = desc
          , fFile = gnFile topic
          , fLine = gnLine topic
          , fColumn = gnColumn topic
          , fContext = Map.fromList
              [ ("topic", MetaText topicName)
              , ("pubsub", MetaText pubsub)
              , ("subscribers", MetaInt subCount)
              , ("broadcasters", MetaInt bcCount)
              , ("direction", MetaText kind)
              ]
          , fModuleId = modId
          , fDedupeKey = "topic|" <> kind <> "|" <> tid
          }
  in case (subCount, bcCount) of
       (0, n) | n > 0 ->
         [ mk "info" "broadcasts_only"
             ("PUBSUB_TOPIC " <> pubsub <> ":" <> topicName
              <> " has broadcasts but no subscribers") ]
       (n, 0) | n > 0 ->
         [ mk "info" "subscribers_only"
             ("PUBSUB_TOPIC " <> pubsub <> ":" <> topicName
              <> " has subscribers but no broadcasters") ]
       _ -> []

-- ---------------------------------------------------------------------
-- 6. heterogeneous_key_type  (THE MAMORI BUG DETECTOR)
-- ---------------------------------------------------------------------

-- | Per-handler: for each top-level map in the pattern, collect the
-- @(key, literalKind)@ pairs. Literal kinds are:
--
--   "atom"   — SAtom
--   "str"    — SStr
--   "number" — SNumber
--   "other"  — anything else (wildcards / non-literal)
--
-- Then, grouped by module, we look for any single key that two or more
-- handlers use with *different* literal kinds. That is the kami
-- Mamori:83/90 pattern: clauses matching @%{type: :enqueued}@ and
-- @%{type: "task_completed"}@ — same key, @atom@ vs @str@, one set is
-- dead.
heterogeneousKeyType :: FileModuleIdx -> [GraphNode] -> [Finding]
heterogeneousKeyType fileMod msgTypes =
  let byMod :: Map Text [GraphNode]
      byMod = foldr ins Map.empty msgTypes
      ins n acc =
        let mname = moduleNameForFile fileMod (gnFile n)
        in Map.insertWith (++) mname [n] acc
      groups = Map.toList byMod
  in concatMap perModule groups
  where
    perModule (modName, handlers) =
      let entries =
            [ (key, kind, gnLine n, fromMaybe (gnLine n) (metaInt "handler_line" n), n)
            | n <- handlers
            , Just shp <- [handlerShape n]
            , (key, vShape) <- topLevelMapKV shp
            , let kind = literalKind vShape
            , kind /= "other"
            , not (T.null key)
            ]
          byKey :: Map Text [(Text, Int, Int, GraphNode)]
          byKey = foldr (\(k, kd, l, hl, n) -> Map.insertWith (++) k [(kd, l, hl, n)]) Map.empty entries
          collisions =
            [ (key, sort (nub (map (\(kd,_,_,_) -> kd) rows)), rows)
            | (key, rows) <- Map.toList byKey
            , length (nub (map (\(kd,_,_,_) -> kd) rows)) >= 2
            ]
      in map (mkFinding modName) collisions

    mkFinding modName (key, kinds, rows) =
      let kindStr = T.intercalate " vs " kinds
          lines_ = sort (nub [ hl | (_, _, hl, _) <- rows ])
          desc = "Handler clauses in " <> modName <> " use heterogeneous types for key :"
                 <> key <> " (" <> kindStr
                 <> ") — one set of clauses may be dead code"
          byKind = Map.fromList
            [ (k, MetaList [ MetaInt hl | (kd, _, hl, _) <- rows, kd == k ])
            | k <- kinds
            ]
          ctx = Map.fromList
            [ ("module", MetaText modName)
            , ("key", MetaText key)
            , ("kinds", MetaList (map MetaText kinds))
            , ("lines", MetaList (map MetaInt lines_))
            , ("lines_by_kind", MetaMap byKind)
            ]
          -- Use first handler row for file + module linkage.
          anyNode = case rows of
            ((_, _, _, n):_) -> n
            []               -> error "heterogeneousKeyType: empty rows (unreachable)"
      in Finding
           { fKind = "heterogeneous_key_type"
           , fSeverity = "warning"
           , fDescription = desc
           , fFile = gnFile anyNode
           , fLine = fromMaybe (gnLine anyNode) (metaInt "handler_line" anyNode)
           , fColumn = gnColumn anyNode
           , fContext = ctx
           , fModuleId = moduleIdForFile fileMod (gnFile anyNode)
           , fDedupeKey = "hetkey|" <> modName <> "|" <> key <> "|" <> T.intercalate "," kinds
           }

literalKind :: Shape -> Text
literalKind (SAtom _) = "atom"
literalKind (SStr _)  = "str"
literalKind SNumber   = "number"
literalKind _         = "other"


{-# LANGUAGE OverloadedStrings #-}
-- | BEAM message-type resolution (REG-1098 W6.5).
--
-- Upgrades the coarse CALL → PROCESS @SENDS_TO@ edges produced by the
-- analyzer into precise CALL → MESSAGE_TYPE edges, using shape
-- unification.
--
-- The analyzer enriches every message-sender CALL node with:
--
-- > sender_base    -- "GenServer.call" | "GenServer.cast" |
-- >                  "send" | "Process.send" | "Process.send_after"
-- > sender_via     -- "call" | "cast" | "info"
-- > message_shape  -- serialized shape of the 2nd argument
-- > target_is_self -- True when target is self() / __MODULE__ / literal
-- >                  alias matching the current module
-- > target_hint    -- fully-qualified target module when known statically
--
-- This resolver emits two edge types:
--
--   * @SELF_SCHEDULE@ — @CALL@ → @MESSAGE_TYPE@. Specifically for
--     @Process.send_after(self(), ..., _)@. Enables liveness / tick-loop
--     detection (a MESSAGE_TYPE reachable only via SELF_SCHEDULE is a
--     self-timer, not an externally-driven state).
--
--   * @SENDS_MESSAGE@ — @CALL@ → @MESSAGE_TYPE@. All other matches —
--     intra-file self-sends, cross-file sends to a known target, etc.
--     A single CALL may emit multiple edges if several handler clauses
--     can match the send shape (reflecting real non-determinism of
--     pattern match).
--
-- Conservative: if no MESSAGE_TYPE unifies (or the target isn't
-- statically knowable), no new edge is emitted and the original
-- SENDS_TO → PROCESS stays authoritative.
module BeamMessageTypeResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.GraphTraversal (lookupMetaText, lookupMetaBool)
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import Data.Maybe (fromMaybe, mapMaybe)

import BeamShape (Shape, parseShape, unify)

-- ---------------------------------------------------------------------
-- Indices
-- ---------------------------------------------------------------------

-- | MESSAGE_TYPE nodes grouped by the file they live in. One file owns
-- one PROCESS (by analyzer invariant), and that PROCESS's MESSAGE_TYPEs
-- sit in the same file.
type MessageTypesByFile = Map Text [GraphNode]

-- | File path keyed by the module name of the PROCESS that owns it.
-- Populated from PROCESS nodes so a cross-file target hint can be
-- turned into the matching MESSAGE_TYPE's file.
type ProcessFileByName = Map Text Text

buildIndices :: [GraphNode] -> (MessageTypesByFile, ProcessFileByName)
buildIndices nodes =
  let msgTypes   = filter ((== "MESSAGE_TYPE") . gnType) nodes
      processes  = filter ((== "PROCESS")      . gnType) nodes

      msgByFile  = foldr (\n acc -> Map.insertWith (++) (gnFile n) [n] acc) Map.empty msgTypes
      procByName = Map.fromList [ (gnName p, gnFile p) | p <- processes ]
  in (msgByFile, procByName)

-- ---------------------------------------------------------------------
-- Send-site view
-- ---------------------------------------------------------------------

-- | All the information we need from a single send-site CALL node.
data SendSite = SendSite
  { ssCallId       :: !Text
  , ssSenderVia    :: !Text        -- "call" | "cast" | "info"
  , ssSenderBase   :: !Text        -- "Process.send_after" | ...
  , ssShape        :: !Shape
  , ssTargetIsSelf :: !Bool
  , ssTargetHint   :: !(Maybe Text)
  , ssCallFile     :: !Text
  }

toSendSite :: GraphNode -> Maybe SendSite
toSendSite n
  | gnType n /= "CALL" = Nothing
  | otherwise = do
      via   <- lookupMetaText "sender_via"  n
      base  <- lookupMetaText "sender_base" n
      shape <- Map.lookup "message_shape" (gnMetadata n)
      let isSelf = fromMaybe False (lookupMetaBool "target_is_self" n)
          hint   = lookupMetaText "target_hint" n
      pure SendSite
        { ssCallId       = gnId n
        , ssSenderVia    = via
        , ssSenderBase   = base
        , ssShape        = parseShape shape
        , ssTargetIsSelf = isSelf
        , ssTargetHint   = hint
        , ssCallFile     = gnFile n
        }

-- ---------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------

-- | Pick the set of MESSAGE_TYPE candidates a send-site can possibly
-- reach. Intra-file self-sends look in the caller's own file;
-- cross-file sends with a target hint look up the PROCESS by name and
-- use that file.
candidateMessageTypes
  :: MessageTypesByFile
  -> ProcessFileByName
  -> SendSite
  -> [GraphNode]
candidateMessageTypes msgByFile procByName ss
  | ssTargetIsSelf ss =
      lookupDefault (ssCallFile ss) msgByFile
  | Just hint <- ssTargetHint ss
  , Just targetFile <- Map.lookup hint procByName =
      lookupDefault targetFile msgByFile
  | otherwise = []

lookupDefault :: Ord k => k -> Map k [v] -> [v]
lookupDefault k m = fromMaybe [] (Map.lookup k m)

-- | Filter candidates to those whose @handler_type@ matches the sender
-- (call→call, cast→cast, send/send_after→info) AND whose pattern_shape
-- unifies with the sent shape.
matchingHandlers :: SendSite -> [GraphNode] -> [GraphNode]
matchingHandlers ss candidates =
  [ m
  | m <- candidates
  , lookupMetaText "handler_type" m == Just (ssSenderVia ss)
  , let clauseShape = case Map.lookup "pattern_shape" (gnMetadata m) of
          Just v  -> parseShape v
          Nothing -> parseShape (MetaList [MetaText "unknown"])
  , unify (ssShape ss) clauseShape
  ]

-- | Choose the edge type for a (send-site, matching message-type) pair.
-- Process.send_after(self(), ...) is the only self-scheduling shape.
edgeTypeFor :: SendSite -> Text
edgeTypeFor ss
  | ssTargetIsSelf ss && ssSenderBase ss == "Process.send_after" = "SELF_SCHEDULE"
  | otherwise                                                    = "SENDS_MESSAGE"

emitEdges :: SendSite -> [GraphNode] -> [PluginCommand]
emitEdges ss matches =
  let eType = edgeTypeFor ss
  in [ EmitEdge GraphEdge
         { geSource   = ssCallId ss
         , geTarget   = gnId m
         , geType     = eType
         , geMetadata = Map.fromList
             [ ("resolvedVia", MetaText "beam-message-type-resolution")
             , ("via",         MetaText (ssSenderBase ss))
             ]
         }
     | m <- matches
     ]

-- | Entry point: produce all CALL→MESSAGE_TYPE edges for the graph.
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let (msgByFile, procByName) = buildIndices nodes
      sendSites               = mapMaybe toSendSite nodes
      emit ss =
        case matchingHandlers ss (candidateMessageTypes msgByFile procByName ss) of
          []      -> []
          matches -> emitEdges ss matches
  in concatMap emit sendSites

-- | CLI entry point.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)

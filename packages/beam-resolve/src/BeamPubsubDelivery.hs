{-# LANGUAGE OverloadedStrings #-}
-- | BEAM PubSub delivery resolution (GAP-C follow-up to REG-1098 W7).
--
-- Closes the loop in Phoenix.PubSub topologies. The analyzer already
-- emits:
--
--   * PUBSUB_TOPIC nodes  (server + literal topic)
--   * BROADCASTS_TO edges (CALL → TOPIC, with message_shape)
--   * SUBSCRIBES_TO edges (MODULE → TOPIC)
--
-- What was missing: broadcast CALLs had no direct link to the
-- @handle_info@ clauses that actually receive them. From the
-- dead-state detector's point of view, every @info:event/*@ handler
-- looked unreachable because nothing pointed at it via SENDS_MESSAGE
-- or SELF_SCHEDULE.
--
-- This resolver closes that gap with a third precise edge type:
--
--   * @PUBLISHES@ — CALL → MESSAGE_TYPE. Emitted per (broadcast site,
--     subscriber handler) pair whose shape unifies. Distinct from
--     SENDS_MESSAGE because the delivery mechanism is one-to-many
--     topic fanout, not a direct send. A dead-state rule can now
--     consult three complementary precise edges:
--
--         reachable(M) :- incoming(M, _, "SENDS_MESSAGE").
--         reachable(M) :- incoming(M, _, "SELF_SCHEDULE").
--         reachable(M) :- incoming(M, _, "PUBLISHES").
--         unreachable(M) :- node(M, "MESSAGE_TYPE"), !reachable(M).
--
-- Analyzer-enriched CALL metadata used here:
--   * pubsub_op     : "broadcast" | "subscribe"
--   * pubsub_topic  : literal topic string
--   * pubsub_server : fully qualified PubSub server module
--   * message_shape : present on broadcast CALLs only
module BeamPubsubDelivery (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.GraphTraversal (lookupMetaText)
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.Text (Text)
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import Data.Maybe (fromMaybe, mapMaybe)

import BeamShape (Shape, parseShape, unify)

-- ---------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------

-- | A Phoenix.PubSub.broadcast* call site, with everything the
-- resolver needs to emit a PUBLISHES edge.
data BroadcastSite = BroadcastSite
  { bsCallId :: !Text
  , bsServer :: !Text  -- ^ fully-qualified PubSub server module
  , bsTopic  :: !Text
  , bsShape  :: !Shape
  }

-- | A Phoenix.PubSub.subscribe call site — its file is the subscriber
-- module's file, which is where the matching handle_info clauses
-- live.
data SubscribeSite = SubscribeSite
  { ssServer :: !Text
  , ssTopic  :: !Text
  , ssFile   :: !Text
  }

toBroadcast :: GraphNode -> Maybe BroadcastSite
toBroadcast n = do
  guardCall n
  op <- lookupMetaText "pubsub_op" n
  case op of
    "broadcast" -> do
      topic  <- lookupMetaText "pubsub_topic"  n
      server <- lookupMetaText "pubsub_server" n
      shape  <- Map.lookup "message_shape" (gnMetadata n)
      pure BroadcastSite
        { bsCallId = gnId n
        , bsServer = server
        , bsTopic  = topic
        , bsShape  = parseShape shape
        }
    _ -> Nothing

toSubscribe :: GraphNode -> Maybe SubscribeSite
toSubscribe n = do
  guardCall n
  op <- lookupMetaText "pubsub_op" n
  case op of
    "subscribe" -> do
      topic  <- lookupMetaText "pubsub_topic"  n
      server <- lookupMetaText "pubsub_server" n
      pure SubscribeSite
        { ssServer = server
        , ssTopic  = topic
        , ssFile   = gnFile n
        }
    _ -> Nothing

guardCall :: GraphNode -> Maybe ()
guardCall n = if gnType n == "CALL" then Just () else Nothing

-- ---------------------------------------------------------------------
-- Indices
-- ---------------------------------------------------------------------

-- | Subscriber files keyed by (server, topic). Multiple subscribers per
-- topic are normal — each keeps its own entry in the list.
type SubscribersByTopic = Map (Text, Text) [Text]

-- | handle_info MESSAGE_TYPE nodes grouped by their containing file.
type InfoHandlersByFile = Map Text [GraphNode]

buildIndices
  :: [GraphNode]
  -> (SubscribersByTopic, InfoHandlersByFile)
buildIndices nodes =
  let subscribers = mapMaybe toSubscribe nodes
      infoHandlers =
        [ n
        | n <- nodes
        , gnType n == "MESSAGE_TYPE"
        , lookupMetaText "handler_type" n == Just "info"
        ]

      subsByTopic =
        foldr
          (\s acc -> Map.insertWith (++) (ssServer s, ssTopic s) [ssFile s] acc)
          Map.empty
          subscribers

      handlersByFile =
        foldr
          (\n acc -> Map.insertWith (++) (gnFile n) [n] acc)
          Map.empty
          infoHandlers
  in (subsByTopic, handlersByFile)

-- ---------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------

resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let (subsByTopic, handlersByFile) = buildIndices nodes
      broadcasts = mapMaybe toBroadcast nodes
  in concatMap (emitFor subsByTopic handlersByFile) broadcasts

emitFor
  :: SubscribersByTopic
  -> InfoHandlersByFile
  -> BroadcastSite
  -> [PluginCommand]
emitFor subsByTopic handlersByFile bs =
  let subscriberFiles =
        fromMaybe [] (Map.lookup (bsServer bs, bsTopic bs) subsByTopic)
      candidateHandlers = concatMap (lookupDefault handlersByFile) subscriberFiles
      matches = filter (handlerUnifies (bsShape bs)) candidateHandlers
  in map (mkPublishes bs) matches

lookupDefault :: Ord k => Map k [v] -> k -> [v]
lookupDefault m k = fromMaybe [] (Map.lookup k m)

handlerUnifies :: Shape -> GraphNode -> Bool
handlerUnifies sent handler =
  let clauseShape = case Map.lookup "pattern_shape" (gnMetadata handler) of
        Just v  -> parseShape v
        Nothing -> parseShape (MetaList [MetaText "unknown"])
  in unify sent clauseShape

mkPublishes :: BroadcastSite -> GraphNode -> PluginCommand
mkPublishes bs handler = EmitEdge GraphEdge
  { geSource   = bsCallId bs
  , geTarget   = gnId handler
  , geType     = "PUBLISHES"
  , geMetadata = Map.fromList
      [ ("resolvedVia", MetaText "beam-pubsub-delivery")
      , ("topic",       MetaText (bsTopic bs))
      , ("server",      MetaText (bsServer bs))
      ]
  }

-- ---------------------------------------------------------------------
-- CLI entry point
-- ---------------------------------------------------------------------

run :: IO ()
run = do
  nodes <- readNodesFromStdin
  writeCommandsToStdout (resolveAll nodes)

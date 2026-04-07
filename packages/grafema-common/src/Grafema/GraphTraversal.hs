{-# LANGUAGE OverloadedStrings #-}
-- | Generic graph traversal primitives shared by all language resolvers.
--
-- These utilities enable resolvers to do principled graph traversal
-- (instead of storing derived metadata) by composing small, language-agnostic
-- building blocks:
--
--   * Index nodes by arbitrary keys ('buildIndexBy')
--   * Build adjacency maps from edges ('buildAdjacency')
--   * Follow edges by type ('followEdge', 'followEdges')
--   * Parse markers from semantic IDs ('extractByMarker')
--   * Read typed metadata fields ('lookupMetaText', 'lookupMetaBool')
--
-- Each language-specific resolver composes these into its own resolution
-- pattern (type-based dispatch, module-qualified imports, etc.).
module Grafema.GraphTraversal
  ( -- * Indexes
    NodeIndex
  , Adjacency
  , buildNodeIndex
  , buildIndexBy
  , buildAdjacency
    -- * Traversal
  , followEdge
  , followEdges
  , followEdgeChain
    -- * Semantic ID parsing
  , extractByMarker
    -- * Metadata accessors
  , lookupMetaText
  , lookupMetaBool
  , lookupMetaInt
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)

-- ---------------------------------------------------------------------------
-- Index types
-- ---------------------------------------------------------------------------

-- | Index of nodes by their @gnId@.
type NodeIndex = Map Text GraphNode

-- | Adjacency: source node ID → list of (edge type, dest node ID).
type Adjacency = Map Text [(Text, Text)]

-- ---------------------------------------------------------------------------
-- Building indexes
-- ---------------------------------------------------------------------------

-- | Build a node index keyed by node ID.
buildNodeIndex :: [GraphNode] -> NodeIndex
buildNodeIndex nodes = Map.fromList [(gnId n, n) | n <- nodes]

-- | Build an index of nodes by an arbitrary key extractor.
-- Nodes that don't yield a key (extractor returns 'Nothing') are skipped.
-- When multiple nodes share a key, the last one wins (Map.fromList semantics).
buildIndexBy :: Ord k => (GraphNode -> Maybe k) -> [GraphNode] -> Map k GraphNode
buildIndexBy keyFn nodes =
  Map.fromList [(k, n) | n <- nodes, Just k <- [keyFn n]]

-- | Build adjacency map from a list of edges.
-- For each source ID, accumulates @(edgeType, destId)@ tuples.
buildAdjacency :: [GraphEdge] -> Adjacency
buildAdjacency edges =
  Map.fromListWith (++)
    [ (geSource e, [(geType e, geTarget e)])
    | e <- edges
    ]

-- ---------------------------------------------------------------------------
-- Traversal
-- ---------------------------------------------------------------------------

-- | Follow a single edge of the given type from a node ID.
-- Returns the first matching destination node, or Nothing if no such edge
-- exists or the destination isn't in the node index.
followEdge :: Text -> NodeIndex -> Adjacency -> Text -> Maybe GraphNode
followEdge edgeType nodeIdx adj nodeId = do
  targets <- Map.lookup nodeId adj
  let matching = [tid | (et, tid) <- targets, et == edgeType]
  case matching of
    []      -> Nothing
    (tid:_) -> Map.lookup tid nodeIdx

-- | Follow ALL edges of the given type from a node ID.
followEdges :: Text -> NodeIndex -> Adjacency -> Text -> [GraphNode]
followEdges edgeType nodeIdx adj nodeId =
  case Map.lookup nodeId adj of
    Nothing -> []
    Just targets ->
      [n | (et, tid) <- targets, et == edgeType, Just n <- [Map.lookup tid nodeIdx]]

-- | Follow a chain of edge types in sequence: @[A, B, C]@ means follow A,
-- then from result follow B, then from that follow C.
-- Returns the final node or Nothing if any step fails.
followEdgeChain :: [Text] -> NodeIndex -> Adjacency -> Text -> Maybe GraphNode
followEdgeChain []       _       _   _      = Nothing
followEdgeChain [et]     nodeIdx adj nodeId = followEdge et nodeIdx adj nodeId
followEdgeChain (et:ets) nodeIdx adj nodeId = do
  next <- followEdge et nodeIdx adj nodeId
  followEdgeChain ets nodeIdx adj (gnId next)

-- ---------------------------------------------------------------------------
-- Semantic ID parsing
-- ---------------------------------------------------------------------------

-- | Extract a name following a marker like @"IMPL_BLOCK->"@ from a semantic ID.
-- Tries both URL-encoded (@-%3E@, @%5B@, @%5D@) and plain (@->@, @[@, @]@) forms.
-- Stops at @]@, @[@, @%@, or @#@.
--
-- Examples:
--   @extractByMarker "...IMPL_BLOCK-%3EShard..." "IMPL_BLOCK->" == Just "Shard"@
--   @extractByMarker "...STRUCT->Foo[in:..." "STRUCT->" == Just "Foo"@
extractByMarker :: Text -> Text -> Maybe Text
extractByMarker sid marker =
  let stopChars = [']', '[', '%', '#']
      tryM m = case T.breakOn m sid of
        (_, rest)
          | T.null rest -> Nothing
          | otherwise ->
              let after = T.drop (T.length m) rest
                  name = T.takeWhile (\c -> c `notElem` stopChars) after
              in if T.null name then Nothing else Just name
      urlEncoded = T.replace "->" "-%3E" marker
  in case tryM urlEncoded of
       Just t  -> Just t
       Nothing -> tryM marker

-- ---------------------------------------------------------------------------
-- Metadata accessors
-- ---------------------------------------------------------------------------

lookupMetaText :: Text -> GraphNode -> Maybe Text
lookupMetaText key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaText t) -> Just t
    _                 -> Nothing

lookupMetaBool :: Text -> GraphNode -> Maybe Bool
lookupMetaBool key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaBool b) -> Just b
    _                 -> Nothing

lookupMetaInt :: Text -> GraphNode -> Maybe Int
lookupMetaInt key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaInt i) -> Just i
    _                -> Nothing

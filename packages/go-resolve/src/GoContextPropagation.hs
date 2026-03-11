{-# LANGUAGE OverloadedStrings #-}
-- | Go context propagation: detects context.Context flow through call chains.
--
-- Consumes:
--   * FUNCTION nodes with @accepts_context=true@ metadata (from analyzer)
--   * CALL nodes with optional @goroutine@ / @deferred@ metadata
--   * CALLS edges (from GoCallResolution) as @(source, target)@ pairs
--
-- Emits:
--   * PROPAGATES_CONTEXT: FUNCTION -> FUNCTION (context flows from caller to callee)
--   * SPAWNS_WITH_CONTEXT: CALL -> FUNCTION (goroutine launched with context)
--   * DEFERS_WITH_CONTEXT: CALL -> FUNCTION (deferred call with context)
module GoContextPropagation
  ( resolveAll
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)
import Data.Maybe (mapMaybe)

-- ── Helper functions ──────────────────────────────────────────────────────

-- | Look up a text metadata value from a node.
lookupMetaText :: Text -> GraphNode -> Maybe Text
lookupMetaText key node = case Map.lookup key (gnMetadata node) of
  Just (MetaText t) -> Just t
  _                 -> Nothing

-- | Look up a boolean metadata value from a node.
lookupMetaBool :: Text -> GraphNode -> Maybe Bool
lookupMetaBool key node = case Map.lookup key (gnMetadata node) of
  Just (MetaBool b) -> Just b
  _                 -> Nothing

-- | Extract the directory portion of a file path.
dirOfFile :: Text -> Text
dirOfFile f = case T.breakOnEnd "/" f of
  ("", _) -> ""
  (d, _)  -> T.dropEnd 1 d

-- | Extract the enclosing function name from a CALL node's semantic ID.
-- Semantic IDs follow the pattern: @file->TYPE->name[in:parent]@
-- We extract the @parent@ from the @[in:parent]@ suffix.
extractEnclosingName :: Text -> Maybe Text
extractEnclosingName sid =
  case T.breakOn "[in:" sid of
    (_, rest) | T.null rest -> Nothing
    (_, rest) ->
      let afterPrefix = T.drop 4 rest  -- drop "[in:"
      in case T.breakOn "]" afterPrefix of
        (name, _) | T.null name -> Nothing
        (name, _) -> Just name

-- ── Index types ───────────────────────────────────────────────────────────

-- | Set of FUNCTION node IDs that certainly accept context.Context.
type ContextFunctions = Set Text

-- | Set of FUNCTION node IDs that possibly accept context.Context
-- (aliased import, dot import — unresolved).
type PossibleContextFunctions = Set Text

-- | CALL node ID -> GraphNode.
type CallNodeIndex = Map Text GraphNode

-- | (file directory, function name) -> FUNCTION node ID.
type FunctionByDirAndName = Map (Text, Text) Text

-- ── Index builders ────────────────────────────────────────────────────────

-- | Build set of FUNCTION node IDs with accepts_context=true metadata.
buildContextFunctions :: [GraphNode] -> ContextFunctions
buildContextFunctions nodes = Set.fromList
  [ gnId n
  | n <- nodes
  , gnType n == "FUNCTION"
  , lookupMetaBool "accepts_context" n == Just True
  ]

-- | Build set of FUNCTION node IDs with possible_context=true metadata.
buildPossibleContextFunctions :: [GraphNode] -> PossibleContextFunctions
buildPossibleContextFunctions nodes = Set.fromList
  [ gnId n
  | n <- nodes
  , gnType n == "FUNCTION"
  , lookupMetaBool "possible_context" n == Just True
  ]

-- | Build index of CALL node ID -> GraphNode.
buildCallNodeIndex :: [GraphNode] -> CallNodeIndex
buildCallNodeIndex nodes = Map.fromList
  [ (gnId n, n) | n <- nodes, gnType n == "CALL" ]

-- | Build index of (directory, name) -> FUNCTION node ID.
-- Uses bare gnName (e.g., "Handle", not "Server.Handle").
buildFunctionByDirAndName :: [GraphNode] -> FunctionByDirAndName
buildFunctionByDirAndName nodes = Map.fromList $ mapMaybe extract $ filter isFn nodes
  where
    isFn n = gnType n == "FUNCTION"
          && lookupMetaText "kind" n /= Just "interface_method"
          && lookupMetaText "kind" n /= Just "closure"
    extract n =
      let dir  = dirOfFile (gnFile n)
          name = gnName n
      in Just ((dir, name), gnId n)

-- ── Resolution logic ──────────────────────────────────────────────────────

-- | Resolve context propagation across call chains.
--
-- Parameters:
--   * @nodes@ — all graph nodes
--   * @callEdges@ — @(callNodeId, targetFunctionId)@ pairs from GoCallResolution
--
-- Returns 'EmitEdge' commands for context propagation edges.
-- Edges for certain context matches have no extra metadata.
-- Edges for possible (unresolved) context matches have @unresolved=true@ metadata.
resolveAll :: [GraphNode] -> [(Text, Text)] -> [PluginCommand]
resolveAll nodes callEdges =
  let contextFns   = buildContextFunctions nodes
      possibleFns  = buildPossibleContextFunctions nodes
      callIdx      = buildCallNodeIndex nodes
      fnByDirName  = buildFunctionByDirAndName nodes
  in concatMap (resolveEdge contextFns possibleFns callIdx fnByDirName) callEdges

-- | Resolve a single CALLS edge for context propagation.
resolveEdge
  :: ContextFunctions
  -> PossibleContextFunctions
  -> CallNodeIndex
  -> FunctionByDirAndName
  -> (Text, Text)       -- ^ (callNodeId, targetFunctionId)
  -> [PluginCommand]
resolveEdge contextFns possibleFns callIdx fnByDirName (callNodeId, targetFuncId) =
  case Map.lookup callNodeId callIdx of
    Nothing -> []
    Just callNode ->
      let targetCertain  = Set.member targetFuncId contextFns
          targetPossible = Set.member targetFuncId possibleFns
          targetAcceptsCtx = targetCertain || targetPossible
          -- Edges for possible matches are marked unresolved
          edgeMeta
            | targetCertain  = Map.empty
            | targetPossible = Map.singleton "unresolved" (MetaBool True)
            | otherwise      = Map.empty
          -- Find enclosing function
          mEnclosingName = extractEnclosingName (gnId callNode)
          callerDir      = dirOfFile (gnFile callNode)
          mEnclosingFnId = mEnclosingName >>= \name ->
                             Map.lookup (callerDir, name) fnByDirName
          callerAcceptsCtx = case mEnclosingFnId of
                               Just fnId -> Set.member fnId contextFns
                                         || Set.member fnId possibleFns
                               Nothing   -> False
          isGoroutine = lookupMetaBool "goroutine" callNode == Just True
          isDeferred  = lookupMetaBool "deferred" callNode == Just True
      in if not targetAcceptsCtx
         then []  -- target doesn't accept context, nothing to propagate
         else
           -- PROPAGATES_CONTEXT: enclosing function -> target function
           [ EmitEdge GraphEdge
               { geSource   = encFnId
               , geTarget   = targetFuncId
               , geType     = "PROPAGATES_CONTEXT"
               , geMetadata = edgeMeta
               }
           | callerAcceptsCtx
           , Just encFnId <- [mEnclosingFnId]
           ] ++
           -- SPAWNS_WITH_CONTEXT: call -> target function (goroutine)
           [ EmitEdge GraphEdge
               { geSource   = callNodeId
               , geTarget   = targetFuncId
               , geType     = "SPAWNS_WITH_CONTEXT"
               , geMetadata = edgeMeta
               }
           | isGoroutine
           ] ++
           -- DEFERS_WITH_CONTEXT: call -> target function (deferred)
           [ EmitEdge GraphEdge
               { geSource   = callNodeId
               , geTarget   = targetFuncId
               , geType     = "DEFERS_WITH_CONTEXT"
               , geMetadata = edgeMeta
               }
           | isDeferred
           ]

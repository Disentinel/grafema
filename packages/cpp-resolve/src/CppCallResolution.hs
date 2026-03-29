{-# LANGUAGE OverloadedStrings #-}
-- | C/C++ call resolution: resolves CALL nodes to their FUNCTION targets.
--
-- Four resolution strategies, tried in order:
--
--   1. **Static method calls** (@Class::method()@):
--      Split callee on "::", look up (class, method) in method index.
--
--   2. **Method calls** (@obj.method()@ / @ptr->method()@):
--      Extract receiver type from metadata, look up in method index.
--      If receiver type is unknown, search all classes with a matching method.
--
--   3. **Qualified function calls** (@ns::func()@):
--      Split callee on "::", look up function in the function index
--      with namespace qualification.
--
--   4. **Free function calls** (@myFunc()@):
--      Look up callee name in the function index. If multiple candidates,
--      use arg_count to disambiguate (prefer same file, then closest match).
--
-- == Disambiguation
--
-- When multiple candidate targets exist (C++ overloading), the resolver
-- applies heuristics in order:
--   1. Same file as the call site
--   2. Same directory as the call site
--   3. Matching @arg_count@ metadata
--   4. First candidate (arbitrary but deterministic)
--
-- Node types consumed: CALL, FUNCTION, CLASS
-- Edge types emitted: CALLS
module CppCallResolution
  ( resolveAll
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..))
import Grafema.Protocol (PluginCommand(..))
import CppIndex (CppIndex(..), lookupMetaText, lookupMetaInt, dirOfFile, splitQualified, unqualifiedName)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

-- | Node lookup cache: node ID -> GraphNode.
type NodeMap = Map.Map Text GraphNode

-- | Resolve all CALL nodes in the graph to their FUNCTION targets.
--
-- Parameters:
--   * @nodes@ — all graph nodes
--   * @idx@ — pre-built 'CppIndex'
--
-- Returns a list of 'EmitEdge' commands with CALLS edges.
resolveAll :: [GraphNode] -> CppIndex -> [PluginCommand]
resolveAll nodes idx =
  let nodeMap   = Map.fromList [(gnId n, n) | n <- nodes]
      callNodes = filter (\n -> gnType n == "CALL") nodes
  in concatMap (resolveCall idx nodeMap) callNodes

-- | Resolve a single CALL node using four strategies in priority order.
resolveCall :: CppIndex -> NodeMap -> GraphNode -> [PluginCommand]
resolveCall idx nodeMap callNode =
  let calleeName = gnName callNode
      mReceiver  = lookupMetaText "receiver" callNode
  in case mReceiver of
    -- Strategy 2: Method call with explicit receiver type
    Just recvType ->
      resolveMethodCall idx nodeMap callNode recvType (extractMethodName calleeName)

    Nothing ->
      case splitQualified calleeName of
        -- Strategy 1 or 3: Qualified call (Class::method or ns::func)
        Just (qualifier, name) ->
          resolveQualifiedCall idx nodeMap callNode qualifier name

        -- Strategy 4: Free function call
        Nothing ->
          resolveFreeFunctionCall idx nodeMap callNode calleeName

-- | Extract the method name from a callee that may be "receiver.method".
extractMethodName :: Text -> Text
extractMethodName name =
  case T.breakOnEnd "." name of
    ("", n) -> n
    (_, n)  -> n

-- ── Strategy 1/3: Qualified calls ──────────────────────────────────────

-- | Resolve a qualified call (@Class::method()@ or @ns::func()@).
--
-- First tries as a static method call (qualifier = class name),
-- then as a namespace-qualified function call.
resolveQualifiedCall :: CppIndex -> NodeMap -> GraphNode -> Text -> Text -> [PluginCommand]
resolveQualifiedCall idx nodeMap callNode qualifier name =
  -- Try as static method call first
  case lookupMethod idx qualifier name of
    Just candidates ->
      let target = disambiguate nodeMap callNode candidates
      in [emitCallsEdge callNode target]
    Nothing ->
      -- Try as namespace-qualified function
      let qualName = qualifier <> "::" <> name
      in case Map.lookup qualName (functionIndex idx) of
        Just candidates@(_:_) ->
          let target = disambiguate nodeMap callNode candidates
          in [emitCallsEdge callNode target]
        _ ->
          -- Try unqualified as last resort
          case Map.lookup name (functionIndex idx) of
            Just candidates@(_:_) ->
              let target = disambiguate nodeMap callNode candidates
              in [emitCallsEdge callNode target]
            _ -> []

-- ── Strategy 2: Method calls ───────────────────────────────────────────

-- | Resolve a method call with known receiver type.
resolveMethodCall :: CppIndex -> NodeMap -> GraphNode -> Text -> Text -> [PluginCommand]
resolveMethodCall idx nodeMap callNode recvType methodName =
  case lookupMethod idx recvType methodName of
    Just candidates ->
      let target = disambiguate nodeMap callNode candidates
      in [emitCallsEdge callNode target]
    Nothing ->
      -- Receiver type unknown or not in index; search all classes
      resolveMethodByNameOnly idx nodeMap callNode methodName

-- | Look up a method by (className, methodName), trying both qualified
-- and unqualified class names.
lookupMethod :: CppIndex -> Text -> Text -> Maybe [Text]
lookupMethod idx className methodName =
  case Map.lookup (className, methodName) (methodIndex idx) of
    Just candidates@(_:_) -> Just candidates
    _ ->
      let uq = unqualifiedName className
      in if uq /= className
         then case Map.lookup (uq, methodName) (methodIndex idx) of
           Just candidates@(_:_) -> Just candidates
           _                     -> Nothing
         else Nothing

-- | Search all classes for a method with the given name.
-- Used as fallback when receiver type is unknown.
resolveMethodByNameOnly :: CppIndex -> NodeMap -> GraphNode -> Text -> [PluginCommand]
resolveMethodByNameOnly idx nodeMap callNode methodName =
  let allMethods = Map.toList (methodIndex idx)
      matching   = concatMap snd $ filter (\((_, mName), _) -> mName == methodName) allMethods
  in case matching of
    []         -> []
    candidates ->
      let target = disambiguate nodeMap callNode candidates
      in [emitCallsEdge callNode target]

-- ── Strategy 4: Free function calls ────────────────────────────────────

-- | Resolve a free (unqualified) function call.
resolveFreeFunctionCall :: CppIndex -> NodeMap -> GraphNode -> Text -> [PluginCommand]
resolveFreeFunctionCall idx nodeMap callNode funcName =
  case Map.lookup funcName (functionIndex idx) of
    Just candidates@(_:_) ->
      let target = disambiguate nodeMap callNode candidates
      in [emitCallsEdge callNode target]
    _ -> []

-- ── Disambiguation ─────────────────────────────────────────────────────

-- | Disambiguate among multiple candidate targets for a CALL node.
--
-- Heuristic priority:
--   1. Same file as call site
--   2. Same directory as call site
--   3. Matching arg_count
--   4. First candidate
disambiguate :: NodeMap -> GraphNode -> [Text] -> Text
disambiguate _nodeMap _callNode [single] = single
disambiguate nodeMap callNode candidates =
  let callFile = gnFile callNode
      callDir  = dirOfFile callFile
      mArgCount = lookupMetaInt "arg_count" callNode

      -- Resolve candidates to (nodeId, Maybe GraphNode) pairs
      withNodes = map (\cId -> (cId, Map.lookup cId nodeMap)) candidates

      -- 1. Same file
      sameFile = [cId | (cId, Just cn) <- withNodes, gnFile cn == callFile]

      -- 2. Same directory
      sameDir = [cId | (cId, Just cn) <- withNodes, dirOfFile (gnFile cn) == callDir]

      -- 3. Matching arg_count
      matchingArgs = case mArgCount of
        Just ac -> [cId | (cId, Just cn) <- withNodes, lookupMetaInt "arg_count" cn == Just ac]
        Nothing -> []

  in case sameFile of
    (x:_) -> x
    [] -> case sameDir of
      (x:_) -> x
      [] -> case matchingArgs of
        (x:_) -> x
        [] -> case candidates of
          (x:_) -> x
          []    -> error "disambiguate: impossible empty candidates"

-- ── Edge emission ──────────────────────────────────────────────────────

-- | Emit a CALLS edge from a CALL node to a target FUNCTION node.
emitCallsEdge :: GraphNode -> Text -> PluginCommand
emitCallsEdge callNode targetId =
  EmitEdge GraphEdge
    { geSource   = gnId callNode
    , geTarget   = targetId
    , geType     = "CALLS"
    , geMetadata = Map.empty
    }

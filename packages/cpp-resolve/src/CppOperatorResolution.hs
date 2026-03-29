{-# LANGUAGE OverloadedStrings #-}
-- | C/C++ operator overload resolution.
--
-- Resolves overloaded operator calls to their operator FUNCTION definitions.
-- Handles both member operators (@a + b@ where @operator+@ is a method of
-- @a@'s class) and free function operators (@operator<<(ostream&, const MyClass&)@).
--
-- == Resolution Strategy
--
-- 1. Identify CALL nodes with @isOperatorCall=true@ metadata.
-- 2. Extract the operator name (e.g., @operator+@, @operator<<@).
-- 3. If receiver type is known:
--    a. Look up @operator<op>@ in method index for the receiver's class.
--    b. Emit CALLS edge if found.
-- 4. If receiver type is unknown:
--    a. Search all classes for matching @operator<op>@ method.
--    b. Also search free functions named @operator<op>@.
--    c. Prefer class member operator if found in a single class.
-- 5. Emit CALLS edge to best match.
--
-- Node types consumed: CALL (with isOperatorCall=true)
-- Edge types emitted: CALLS
module CppOperatorResolution
  ( resolveAll
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import CppIndex (CppIndex(..), lookupMetaText, lookupMetaBool, unqualifiedName)

import Data.Text (Text)
import qualified Data.Map.Strict as Map

-- | Resolve all overloaded operator calls.
--
-- Parameters:
--   * @nodes@ — all graph nodes
--   * @idx@ — pre-built 'CppIndex'
--
-- Returns a list of 'EmitEdge' commands with CALLS edges.
resolveAll :: [GraphNode] -> CppIndex -> [PluginCommand]
resolveAll nodes idx =
  let operatorCalls = filter isOperatorCall nodes
  in concatMap (resolveOperator idx) operatorCalls

-- | Check if a node is an operator call.
isOperatorCall :: GraphNode -> Bool
isOperatorCall n =
  gnType n == "CALL"
    && lookupMetaBool "isOperatorCall" n == Just True

-- | Resolve a single operator call.
resolveOperator :: CppIndex -> GraphNode -> [PluginCommand]
resolveOperator idx callNode =
  let operatorName = extractOperatorName callNode
      mRecvType    = lookupMetaText "receiver_type" callNode
  in case mRecvType of
    Just recvType -> resolveWithReceiver idx callNode recvType operatorName
    Nothing       -> resolveWithoutReceiver idx callNode operatorName

-- | Extract the operator function name from a CALL node.
--
-- If the node has @operator@ metadata, use "operator" + that value.
-- Otherwise, use the gnName directly (may already be "operator+", etc.).
extractOperatorName :: GraphNode -> Text
extractOperatorName callNode =
  case lookupMetaText "operator" callNode of
    Just op -> "operator" <> op
    Nothing -> gnName callNode

-- ── Resolution with known receiver type ────────────────────────────────

-- | Resolve operator call when receiver type is known.
resolveWithReceiver :: CppIndex -> GraphNode -> Text -> Text -> [PluginCommand]
resolveWithReceiver idx callNode recvType operatorName =
  -- Try as member operator
  case lookupMemberOperator idx recvType operatorName of
    Just targetId ->
      [emitCallsEdge callNode targetId]
    Nothing ->
      -- Fall back to free function operator
      resolveFreeOperator idx callNode operatorName

-- | Look up a member operator in the method index.
lookupMemberOperator :: CppIndex -> Text -> Text -> Maybe Text
lookupMemberOperator idx className operatorName =
  case Map.lookup (className, operatorName) (methodIndex idx) of
    Just (nodeId:_) -> Just nodeId
    _ ->
      let uq = unqualifiedName className
      in if uq /= className
         then case Map.lookup (uq, operatorName) (methodIndex idx) of
           Just (nodeId:_) -> Just nodeId
           _               -> Nothing
         else Nothing

-- ── Resolution without known receiver type ─────────────────────────────

-- | Resolve operator call when receiver type is unknown.
--
-- Searches both member operators across all classes and free function
-- operators. Prefers a unique member operator match.
resolveWithoutReceiver :: CppIndex -> GraphNode -> Text -> [PluginCommand]
resolveWithoutReceiver idx callNode operatorName =
  -- Collect all member operator matches
  let allMethods = Map.toList (methodIndex idx)
      memberMatches = concatMap snd
        $ filter (\((_, mName), _) -> mName == operatorName) allMethods
  in case memberMatches of
    [single] -> [emitCallsEdge callNode single]
    (first:_) ->
      -- Multiple member matches; prefer first
      [emitCallsEdge callNode first]
    [] ->
      -- Try as free function operator
      resolveFreeOperator idx callNode operatorName

-- | Resolve as a free function operator.
resolveFreeOperator :: CppIndex -> GraphNode -> Text -> [PluginCommand]
resolveFreeOperator idx callNode operatorName =
  case Map.lookup operatorName (functionIndex idx) of
    Just (targetId:_) -> [emitCallsEdge callNode targetId]
    _                 -> []

-- ── Edge emission ──────────────────────────────────────────────────────

-- | Emit a CALLS edge from a CALL node to a target operator FUNCTION.
emitCallsEdge :: GraphNode -> Text -> PluginCommand
emitCallsEdge callNode targetId =
  EmitEdge GraphEdge
    { geSource   = gnId callNode
    , geTarget   = targetId
    , geType     = "CALLS"
    , geMetadata = Map.singleton "resolvedVia" (MetaText "operator_overload")
    }

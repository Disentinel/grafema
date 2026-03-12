{-# LANGUAGE OverloadedStrings #-}
-- | C/C++ virtual method dispatch resolution.
--
-- Builds virtual method override chains and polymorphic dispatch tables.
-- This module runs in Phase 3 (after type resolution has built the class
-- hierarchy and call resolution has resolved call sites).
--
-- == Edge Types Emitted
--
--   * OVERRIDES: derived virtual FUNCTION -> base virtual FUNCTION
--   * DISPATCHES_TO: CALL -> each override FUNCTION (polymorphic targets)
--
-- == Algorithm
--
-- **OVERRIDES detection:**
--   1. Collect all virtual methods (FUNCTION nodes with @isVirtual=true@).
--   2. Build inheritance chains from EXTENDS edges (produced by TypeResolution).
--   3. For each derived class, for each virtual method, walk up the EXTENDS
--      chain to find the base virtual method with matching name.
--   4. Emit OVERRIDES edge from derived method to base method.
--
-- **DISPATCHES_TO (polymorphic call sites):**
--   1. Collect all CALLS edges (produced by CallResolution).
--   2. For each CALL that targets a virtual method, find all overriders
--      of that method by walking the override chain transitively.
--   3. Emit DISPATCHES_TO edge from the CALL to each override.
--
-- The class hierarchy (EXTENDS edges) must be available before this module
-- runs. In the "all" pipeline, TypeResolution runs first (Phase 1).
--
-- Node types consumed: FUNCTION (with isVirtual metadata), CLASS
-- Edge types consumed: EXTENDS (from TypeResolution), CALLS (from CallResolution)
-- Edge types emitted: OVERRIDES, DISPATCHES_TO
module CppVirtualDispatch
  ( resolveAll
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..))
import Grafema.Protocol (PluginCommand(..))
import CppIndex (CppIndex, lookupMetaText, lookupMetaBool)

import Data.Text (Text)
import Data.List (foldl')
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)
import Data.Maybe (mapMaybe)

-- | Virtual method descriptor.
data VirtualMethod = VirtualMethod
  { vmNodeId    :: !Text   -- ^ FUNCTION node ID
  , vmClassName :: !Text   -- ^ Owning class name
  , vmName      :: !Text   -- ^ Method name
  } deriving (Show, Eq)

-- | Resolve virtual dispatch relationships.
--
-- Parameters:
--   * @nodes@ — all graph nodes
--   * @idx@ — pre-built 'CppIndex'
--   * @existingEdges@ — edges from previous resolution phases (EXTENDS, CALLS)
--
-- Returns a list of 'EmitEdge' commands for OVERRIDES and DISPATCHES_TO edges.
resolveAll :: [GraphNode] -> CppIndex -> [PluginCommand] -> [PluginCommand]
resolveAll nodes _idx previousCmds =
  let -- Extract existing edges from previous phase commands
      existingEdges = extractEdges previousCmds

      -- Build inheritance map: derived class -> [base classes]
      inheritanceMap = buildInheritanceMap existingEdges

      -- Build reverse inheritance: base class -> [derived classes]
      _reverseInheritance = buildReverseInheritance inheritanceMap

      -- Collect virtual methods
      virtualMethods = collectVirtualMethods nodes

      -- Build method-by-class index: (className, methodName) -> nodeId
      methodByClass = buildMethodByClass virtualMethods

      -- Phase 1: Detect overrides
      overrideEdges = detectOverrides inheritanceMap methodByClass virtualMethods

      -- Build override index for dispatch: base method ID -> [override method IDs]
      overrideIndex = buildOverrideIndex overrideEdges

      -- Phase 2: Build dispatch tables
      callEdges   = extractCallsEdges existingEdges
      virtualSet  = Set.fromList (map vmNodeId virtualMethods)
      dispatchEdges = buildDispatchTables callEdges virtualSet overrideIndex

  in overrideEdges ++ dispatchEdges

-- ── Edge extraction from previous phases ───────────────────────────────

-- | Extract GraphEdge records from EmitEdge commands.
extractEdges :: [PluginCommand] -> [GraphEdge]
extractEdges = mapMaybe go
  where
    go (EmitEdge e) = Just e
    go _            = Nothing

-- | Extract (callNodeId, targetFuncId) pairs from CALLS edges.
extractCallsEdges :: [GraphEdge] -> [(Text, Text)]
extractCallsEdges = mapMaybe go
  where
    go e | geType e == "CALLS" = Just (geSource e, geTarget e)
    go _                       = Nothing

-- ── Inheritance maps ───────────────────────────────────────────────────

-- | Build map: derived class node ID -> [base class node IDs].
buildInheritanceMap :: [GraphEdge] -> Map Text [Text]
buildInheritanceMap = foldl' go Map.empty
  where
    go acc e
      | geType e == "EXTENDS" =
          Map.insertWith (++) (geSource e) [geTarget e] acc
      | otherwise = acc

-- | Build reverse map: base class node ID -> [derived class node IDs].
buildReverseInheritance :: Map Text [Text] -> Map Text [Text]
buildReverseInheritance = Map.foldlWithKey' go Map.empty
  where
    go acc derived bases =
      foldl' (\m base -> Map.insertWith (++) base [derived] m) acc bases

-- ── Virtual method collection ──────────────────────────────────────────

-- | Collect all virtual methods from graph nodes.
--
-- A method is virtual if it has @isVirtual=true@ or @isOverride=true@
-- or @isPureVirtual=true@ metadata.
collectVirtualMethods :: [GraphNode] -> [VirtualMethod]
collectVirtualMethods = mapMaybe extractVirtual
  where
    extractVirtual n
      | gnType n == "FUNCTION"
      , isVirtualMethod n
      , Just cls <- lookupMetaText "className" n =
          Just VirtualMethod
            { vmNodeId    = gnId n
            , vmClassName = cls
            , vmName      = gnName n
            }
      | otherwise = Nothing

    isVirtualMethod n =
         lookupMetaBool "isVirtual" n == Just True
      || lookupMetaBool "isOverride" n == Just True
      || lookupMetaBool "isPureVirtual" n == Just True

-- | Build index: (className, methodName) -> virtual method node ID.
buildMethodByClass :: [VirtualMethod] -> Map (Text, Text) Text
buildMethodByClass = foldl' go Map.empty
  where
    go acc vm = Map.insert (vmClassName vm, vmName vm) (vmNodeId vm) acc

-- ── Override detection ─────────────────────────────────────────────────

-- | Detect method overrides by walking up the inheritance chain.
--
-- For each virtual method in a derived class, walks up EXTENDS edges
-- to find a base class with a virtual method of the same name.
-- Emits OVERRIDES edge: derived method -> base method.
detectOverrides
  :: Map Text [Text]              -- ^ inheritanceMap: derived -> [bases]
  -> Map (Text, Text) Text        -- ^ methodByClass: (class, method) -> nodeId
  -> [VirtualMethod]
  -> [PluginCommand]
detectOverrides inheritanceMap methodByClass virtualMethods =
  concatMap (findOverride inheritanceMap methodByClass) virtualMethods

-- | Find the base virtual method that a given virtual method overrides.
findOverride
  :: Map Text [Text]
  -> Map (Text, Text) Text
  -> VirtualMethod
  -> [PluginCommand]
findOverride inheritanceMap methodByClass vm =
  let derivedClass = vmClassName vm
      methodName   = vmName vm
      -- Walk up inheritance chain (BFS, max depth 10 to avoid cycles)
      baseMethodId = walkUpChain inheritanceMap methodByClass methodName derivedClass 10
  in case baseMethodId of
    Just baseId | baseId /= vmNodeId vm ->
      [ EmitEdge GraphEdge
          { geSource   = vmNodeId vm
          , geTarget   = baseId
          , geType     = "OVERRIDES"
          , geMetadata = Map.empty
          }
      ]
    _ -> []

-- | Walk up the inheritance chain looking for a base method with matching name.
walkUpChain
  :: Map Text [Text]          -- ^ inheritanceMap
  -> Map (Text, Text) Text    -- ^ methodByClass
  -> Text                     -- ^ method name
  -> Text                     -- ^ current class node ID
  -> Int                      -- ^ max depth
  -> Maybe Text
walkUpChain _ _ _ _ 0 = Nothing
walkUpChain inheritanceMap methodByClass methodName classId depth =
  case Map.lookup classId inheritanceMap of
    Nothing -> Nothing
    Just bases ->
      -- Check each base class
      let directMatch = mapMaybe (\baseId ->
            Map.lookup (baseId, methodName) methodByClass) bases
      in case directMatch of
        (found:_) -> Just found
        []        ->
          -- Recurse up
          let recursiveMatches = mapMaybe
                (\baseId -> walkUpChain inheritanceMap methodByClass methodName baseId (depth - 1))
                bases
          in case recursiveMatches of
            (found:_) -> Just found
            []        -> Nothing

-- ── Override index ─────────────────────────────────────────────────────

-- | Build index: base method ID -> [override method IDs].
--
-- This is the reverse of the OVERRIDES edges: for each OVERRIDES(derived, base),
-- we record base -> derived.
buildOverrideIndex :: [PluginCommand] -> Map Text [Text]
buildOverrideIndex = foldl' go Map.empty
  where
    go acc (EmitEdge e)
      | geType e == "OVERRIDES" =
          Map.insertWith (++) (geTarget e) [geSource e] acc
    go acc _ = acc

-- ── Dispatch table construction ────────────────────────────────────────

-- | Build DISPATCHES_TO edges for polymorphic call sites.
--
-- For each CALLS edge targeting a virtual method, collect all transitive
-- overriders and emit DISPATCHES_TO from the call site to each override.
buildDispatchTables
  :: [(Text, Text)]      -- ^ (callNodeId, targetFuncId) CALLS pairs
  -> Set Text             -- ^ set of virtual method node IDs
  -> Map Text [Text]      -- ^ overrideIndex: base -> [overrides]
  -> [PluginCommand]
buildDispatchTables callEdges virtualSet overrideIndex =
  concatMap (dispatchForCall virtualSet overrideIndex) callEdges

-- | Generate DISPATCHES_TO edges for a single call.
dispatchForCall
  :: Set Text
  -> Map Text [Text]
  -> (Text, Text)       -- ^ (callNodeId, targetFuncId)
  -> [PluginCommand]
dispatchForCall virtualSet overrideIndex (callNodeId, targetFuncId)
  | Set.member targetFuncId virtualSet =
      let overrides = collectAllOverrides overrideIndex targetFuncId Set.empty
      in [ EmitEdge GraphEdge
             { geSource   = callNodeId
             , geTarget   = overrideId
             , geType     = "DISPATCHES_TO"
             , geMetadata = Map.empty
             }
         | overrideId <- Set.toList overrides
         ]
  | otherwise = []

-- | Transitively collect all overriders of a virtual method.
--
-- Uses a visited set to handle diamond inheritance safely.
collectAllOverrides :: Map Text [Text] -> Text -> Set Text -> Set Text
collectAllOverrides overrideIndex methodId visited
  | Set.member methodId visited = Set.empty
  | otherwise =
      let visited' = Set.insert methodId visited
          directOverrides = case Map.lookup methodId overrideIndex of
            Just os -> os
            Nothing -> []
          direct = Set.fromList directOverrides
          transitive = Set.unions
            [ collectAllOverrides overrideIndex oid visited'
            | oid <- directOverrides
            ]
      in Set.union direct transitive

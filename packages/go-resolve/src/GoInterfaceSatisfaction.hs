{-# LANGUAGE OverloadedStrings #-}
-- | Go interface satisfaction resolver.
--
-- Resolves structural interface satisfaction ("duck typing") by matching
-- method sets: if a struct type has all methods declared in an interface,
-- it satisfies (implements) that interface.
--
-- == Algorithm
--
-- 1. Build InterfaceMethodSet: collect interface method names from FUNCTION
--    nodes with @kind=interface_method@. The parent interface name is
--    extracted from the @[in:InterfaceName]@ suffix in the semantic ID.
--
-- 2. Build StructMethodSet: collect struct method names from FUNCTION
--    nodes with @kind=method@. The receiver type is read from the
--    @receiver@ metadata field.
--
-- 3. Build StructIndex: map struct names to CLASS node IDs.
--
-- 4. For each interface with a non-empty method set, check every struct's
--    method set. If the interface methods are a subset of the struct
--    methods, emit an IMPLEMENTS edge from the CLASS node to the
--    INTERFACE node.
--
-- == Phase 2 Limitations
--
-- * Name-only matching — method signatures (parameter types, return types)
--   are not compared.
-- * Pointer receiver vs value receiver both match.
-- * Embedded interface methods are not expanded (no transitive check).
module GoInterfaceSatisfaction
  ( resolveAll
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set

-- | Interface method set: interface name -> (INTERFACE node ID, set of method names).
type InterfaceMethodSet = Map Text (Text, Set.Set Text)

-- | Struct method set: struct/type name -> set of method names.
type StructMethodSet = Map Text (Set.Set Text)

-- | Struct index: struct name -> CLASS node ID.
type StructIndex = Map Text Text

-- | Look up a text metadata value from a node's metadata map.
lookupMetaText :: Text -> GraphNode -> Maybe Text
lookupMetaText key node = case Map.lookup key (gnMetadata node) of
  Just (MetaText t) -> Just t
  _                 -> Nothing

-- | Extract parent name from a semantic ID.
--
-- @extractParent \"path\/file.go->FUNCTION->Read[in:Reader]\"@ -> @Just \"Reader\"@
-- @extractParent \"path\/file.go->FUNCTION->main\"@ -> @Nothing@
extractParent :: Text -> Maybe Text
extractParent sid =
  case T.breakOn "[in:" sid of
    (_, rest)
      | T.null rest -> Nothing
      | otherwise ->
          let afterPrefix = T.drop 4 rest  -- drop "[in:"
              -- Take until ']' or ',' (handles both [in:X] and [in:X,h:xxxx])
              parent = T.takeWhile (\c -> c /= ']' && c /= ',') afterPrefix
          in if T.null parent then Nothing else Just parent

-- | Build the interface method set from all graph nodes.
--
-- Scans for FUNCTION nodes with @kind=interface_method@ metadata and
-- groups their names by the parent interface (extracted from semantic ID).
-- Also records the INTERFACE node ID from INTERFACE nodes.
buildInterfaceMethodSet :: [GraphNode] -> InterfaceMethodSet
buildInterfaceMethodSet nodes =
  let -- Collect interface node IDs
      ifaceNodeIds = foldl' collectIfaceIds Map.empty nodes
      -- Collect method names grouped by interface name
      ifaceMethods = foldl' collectIfaceMethods Map.empty nodes
      -- Merge: for each interface with methods, pair with its node ID
  in Map.intersectionWith (\nodeId methods -> (nodeId, methods))
       ifaceNodeIds ifaceMethods

  where
    collectIfaceIds :: Map Text Text -> GraphNode -> Map Text Text
    collectIfaceIds acc n
      | gnType n == "INTERFACE" = Map.insert (gnName n) (gnId n) acc
      | otherwise = acc

    collectIfaceMethods :: Map Text (Set.Set Text) -> GraphNode -> Map Text (Set.Set Text)
    collectIfaceMethods acc n
      | gnType n == "FUNCTION"
      , lookupMetaText "kind" n == Just "interface_method"
      , Just ifaceName <- extractParent (gnId n) =
          Map.insertWith Set.union ifaceName (Set.singleton (gnName n)) acc
      | otherwise = acc

-- | Build the struct method set from all graph nodes.
--
-- Scans for FUNCTION nodes with @kind=method@ metadata and groups
-- method names by the @receiver@ metadata value (the struct/type name).
buildStructMethodSet :: [GraphNode] -> StructMethodSet
buildStructMethodSet = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION"
      , lookupMetaText "kind" n == Just "method"
      , Just recvType <- lookupMetaText "receiver" n =
          Map.insertWith Set.union recvType (Set.singleton (gnName n)) acc
      | otherwise = acc

-- | Build the struct index: struct name -> CLASS node ID.
--
-- Indexes CLASS nodes so we can emit edges with the correct source ID.
buildStructIndex :: [GraphNode] -> StructIndex
buildStructIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "CLASS" = Map.insert (gnName n) (gnId n) acc
      | otherwise = acc

-- | Resolve interface satisfaction across all nodes.
--
-- Returns 'EmitEdge' commands for each struct that implements an interface
-- (i.e., has all the interface's methods).
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let ifaceMethodSet = buildInterfaceMethodSet nodes
      structMethodSet = buildStructMethodSet nodes
      structIdx = buildStructIndex nodes
  in [ EmitEdge GraphEdge
         { geSource   = structNodeId
         , geTarget   = ifaceNodeId
         , geType     = "IMPLEMENTS"
         , geMetadata = Map.empty
         }
     | (_ifaceName, (ifaceNodeId, requiredMethods)) <- Map.toList ifaceMethodSet
     , not (Set.null requiredMethods)
     , (structName, availableMethods) <- Map.toList structMethodSet
     , Set.isSubsetOf requiredMethods availableMethods
     , Just structNodeId <- [Map.lookup structName structIdx]
     ]

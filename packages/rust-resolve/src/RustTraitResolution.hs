{-# LANGUAGE OverloadedStrings #-}
-- | Rust trait implementation resolver.
--
-- Emits @IMPLEMENTS@ edges from @STRUCT@ nodes to @TRAIT@ nodes for each
-- explicit @impl Trait for Struct@ block recorded in the graph.
--
-- == Algorithm
--
-- 1. Build a TRAIT index: trait name → TRAIT node ID.
-- 2. Build a STRUCT index: struct name → STRUCT node ID.
-- 3. For each IMPL_BLOCK node with @metadata[\"trait\"]@, extract the
--    struct name from the semantic ID via the @IMPL_BLOCK->@ marker, then
--    look up both node IDs and emit an IMPLEMENTS edge.
--
-- The @metadata[\"trait\"]@ field is written by the Rust orchestrator for
-- every @impl TraitName for TypeName@ block (see @rust_analyzer.rs@).
module RustTraitResolution (resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..))
import Grafema.Protocol (PluginCommand(..))
import qualified Grafema.GraphTraversal as G

import qualified Data.Map.Strict as Map

resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let traitIdx  = Map.fromList [(gnName n, gnId n) | n <- nodes, gnType n == "TRAIT"]
      structIdx = Map.fromList [(gnName n, gnId n) | n <- nodes, gnType n == "STRUCT"]
  in [ EmitEdge GraphEdge
         { geSource   = structId
         , geTarget   = traitId
         , geType     = "IMPLEMENTS"
         , geMetadata = Map.empty
         }
     | n <- nodes
     , gnType n == "IMPL_BLOCK"
     , Just traitName <- [G.lookupMetaText "trait" n]
     , Just typeName  <- [G.extractByMarker (gnId n) "IMPL_BLOCK->"]
     , Just structId  <- [Map.lookup typeName structIdx]
     , Just traitId   <- [Map.lookup traitName traitIdx]
     ]

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

import Grafema.Types (GraphNode(..), GraphEdge(..), gnSemanticId)
import Grafema.Protocol (PluginCommand(..))
import qualified Grafema.GraphTraversal as G

import Data.Text (Text)
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)

-- | Index nodes of a given type by name, returning @name -> gnId@.
indexByName :: Text -> [GraphNode] -> Map Text Text
indexByName ty nodes =
  fmap gnId (G.buildIndexBy key nodes)
  where
    key n = if gnType n == ty then Just (gnName n) else Nothing

resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let traitIdx  = indexByName "TRAIT"  nodes
      structIdx = indexByName "STRUCT" nodes
  in [ EmitEdge GraphEdge
         { geSource   = structId
         , geTarget   = traitId
         , geType     = "IMPLEMENTS"
         , geMetadata = Map.empty
         }
     | n <- nodes
     , gnType n == "IMPL_BLOCK"
     , Just traitName <- [G.lookupMetaText "trait" n]
     , Just typeName  <- [G.extractByMarker (gnSemanticId n) "IMPL_BLOCK->"]
     , Just structId  <- [Map.lookup typeName structIdx]
     , Just traitId   <- [Map.lookup traitName traitIdx]
     ]

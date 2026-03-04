{-# LANGUAGE OverloadedStrings #-}
-- | Phase 6 rule: strictness/demand analysis.
--
-- Detects strictness annotations in Haskell source:
--   * 'BangPat' in function parameters -> DEMANDS edge
--   * Strict fields in data types ('HsBangTy' with SrcStrict) -> metadata
--
-- This module provides helpers that are called from other rule modules
-- (Rules.Patterns for bang patterns, Rules.DataTypes for strict fields).
module Rules.Demand
  ( emitDemands       -- :: Text -> Text -> Analyzer ()
  , isStrictField     -- :: HsType GhcPs -> Bool
  ) where

import Data.Text (Text)
import qualified Data.Map.Strict as Map

import GHC.Hs (GhcPs)
import GHC.Hs.Type (HsType(..))
import GHC.Core.DataCon (HsSrcBang(..), SrcStrictness(..))

import Analysis.Context (Analyzer, emitEdge)
import Analysis.Types (GraphEdge(..))

-- | Emit a DEMANDS edge indicating that the source node requires
-- strict evaluation of the target node.
--
-- This is called when a 'BangPat' is encountered in a function parameter.
-- The edge indicates that the function demands (forces evaluation of)
-- the parameter before the function body executes.
--
-- @emitDemands fromNodeId toNodeId@ emits:
--   DEMANDS edge: fromNodeId -> toNodeId
emitDemands :: Text -> Text -> Analyzer ()
emitDemands fromNodeId toNodeId =
  emitEdge GraphEdge
    { geSource   = fromNodeId
    , geTarget   = toNodeId
    , geType     = "DEMANDS"
    , geMetadata = Map.empty
    }

-- | Check whether a type has a strictness annotation (bang type).
--
-- In GHC 9.8, strict fields appear as:
--   @HsBangTy _ (HsSrcBang _ _ SrcStrict) innerTy@
--
-- This returns True if the outermost type wrapper is a strict bang type.
-- Used by Rules.DataTypes to add "strict" metadata to RECORD_FIELD nodes.
isStrictField :: HsType GhcPs -> Bool
isStrictField (HsBangTy _ (HsSrcBang _ _ SrcStrict) _) = True
isStrictField _ = False

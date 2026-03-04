{-# LANGUAGE OverloadedStrings #-}
-- | Phase 6 rule: type-level node walking.
--
-- Walks 'HsType GhcPs' to emit type-level graph nodes:
--   * CONSTRAINT nodes from qualified types (e.g., @Eq a =>@)
--
-- This module is intentionally minimal -- it covers the most
-- important type-level constructs without trying to fully walk
-- all HsType constructors.
--
-- Called from 'Rules.Declarations' when processing type signatures.
module Rules.Types
  ( walkType  -- :: LHsType GhcPs -> Analyzer ()
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GHC.Hs (GhcPs)
import GHC.Hs.Type (LHsType, HsType(..), LHsContext)
import GHC.Types.SrcLoc (GenLocated(..))
import GHC.Types.Name.Reader (rdrNameOcc)
import GHC.Types.Name.Occurrence (occNameString)

import Analysis.Context
  ( Analyzer
  , emitNode
  , emitEdge
  , askFile
  , askScopeId
  )
import Analysis.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Loc (getLoc)

-- | Walk a located type, emitting type-level graph nodes.
--
-- Currently handles:
--   * 'HsQualTy' -- qualified types with constraints
--   * 'HsFunTy'  -- function types (recurse to find constraints)
--   * 'HsForAllTy' -- forall types (skip to body)
--   * 'HsParTy'  -- parenthesized (unwrap)
--
-- Other type constructors are skipped.
walkType :: LHsType GhcPs -> Analyzer ()
walkType (L _ ty) = case ty of
  -- Qualified type: Eq a => ...
  -- Emit CONSTRAINT nodes for each constraint in the context.
  HsQualTy _ ctxt body -> do
    walkContext ctxt
    walkType body

  -- Function type: a -> b
  -- Recurse into both sides to find nested qualified types.
  HsFunTy _ _ argTy retTy -> do
    walkType argTy
    walkType retTy

  -- Forall type: forall a. ...
  -- Skip the binders and walk the body.
  HsForAllTy _ _ body ->
    walkType body

  -- Parenthesized type: (...)
  HsParTy _ inner ->
    walkType inner

  -- Everything else: skip.
  _ -> pure ()

-- | Walk a type context (list of constraints), emitting CONSTRAINT nodes.
--
-- A context like @(Eq a, Show a)@ produces two CONSTRAINT nodes.
-- Each constraint is rendered as text for the node name.
walkContext :: LHsContext GhcPs -> Analyzer ()
walkContext (L _ constraints) =
  mapM_ walkConstraint constraints

-- | Walk a single constraint type, emitting a CONSTRAINT node.
--
-- The constraint is rendered as a text name. For simple constraints
-- like @Eq a@, the class name is extracted. For complex constraints,
-- a best-effort text rendering is used.
walkConstraint :: LHsType GhcPs -> Analyzer ()
walkConstraint lty@(L _ cty) = do
  file    <- askFile
  scopeId <- askScopeId
  let (line, col, endLine, endCol) = getLoc lty
  let constraintText = renderConstraint cty
  let nodeId = file <> "->CONSTRAINT->" <> constraintText
                <> "[h:" <> T.pack (show line <> ":" <> show col) <> "]"
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CONSTRAINT"
    , gnName      = constraintText
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.singleton "class" (MetaText (extractClassName cty))
    }
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- | Render a constraint type as text.
--
-- For @Eq a@, returns @"Eq a"@.
-- For complex constraints, returns a best-effort rendering.
renderConstraint :: HsType GhcPs -> T.Text
renderConstraint (HsTyVar _ _ (L _ name)) =
  T.pack (occNameString (rdrNameOcc name))
renderConstraint (HsAppTy _ (L _ f) (L _ a)) =
  renderConstraint f <> " " <> renderAtom a
renderConstraint (HsParTy _ (L _ inner)) =
  "(" <> renderConstraint inner <> ")"
renderConstraint _ = "<constraint>"

-- | Render a type atom (may need parens if compound).
renderAtom :: HsType GhcPs -> T.Text
renderAtom t@(HsTyVar {}) = renderConstraint t
renderAtom t@(HsParTy {}) = renderConstraint t
renderAtom t = "(" <> renderConstraint t <> ")"

-- | Extract the class name from a constraint.
--
-- For @Eq a@, extracts @"Eq"@ by traversing left through
-- 'HsAppTy' applications.
extractClassName :: HsType GhcPs -> T.Text
extractClassName (HsTyVar _ _ (L _ name)) =
  T.pack (occNameString (rdrNameOcc name))
extractClassName (HsAppTy _ (L _ f) _) = extractClassName f
extractClassName (HsParTy _ (L _ inner)) = extractClassName inner
extractClassName _ = "<unknown>"

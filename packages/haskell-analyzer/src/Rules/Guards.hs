{-# LANGUAGE OverloadedStrings #-}
-- | Phase 4 rule: guarded right-hand sides and local bindings.
--
-- Walks GHC guard-related constructs:
--   * 'GRHSs'        -- guarded right-hand sides + where clause
--   * 'GRHS'         -- single guarded alternative
--   * 'HsLocalBinds' -- where/let local bindings
--
-- Guard expressions and RHS bodies are not walked in this phase
-- (they require walkExpr which will be wired up in Phase 4.3).
-- The key purpose of this module is to:
--   1. Provide the module structure and types for Walker.hs integration
--   2. Walk local bindings (where clauses) that contain declarations
--
-- Called from 'Analysis.Walker' and 'Rules.Declarations' when walking
-- function equations and pattern bindings.
module Rules.Guards
  ( walkGRHSs
  , walkLocalBinds
  ) where

import GHC.Hs (GhcPs, HsLocalBindsLR(..))
import GHC.Hs.Expr (GRHSs(..), GRHS(..), LHsExpr, LGRHS)
import GHC.Hs.Binds (HsValBindsLR(..), HsBindLR(..), Sig(..))
import GHC.Data.Bag (bagToList)
import GHC.Types.SrcLoc (GenLocated(..))

import Analysis.Context (Analyzer)
import Rules.Declarations (walkFunBind, walkPatBind, walkTypeSig)

-- | Walk guarded right-hand sides (a group of guards + where clause).
--
-- A function equation or case alternative has a 'GRHSs' containing:
--   * A list of guarded alternatives ('GRHS')
--   * Optional local bindings (where clause)
--
-- Example:
-- @
--   foo x
--     | x > 0    = "positive"   -- GRHS with guard
--     | otherwise = "other"     -- GRHS with guard
--     where helper = ...        -- local bindings
-- @
walkGRHSs :: GRHSs GhcPs (LHsExpr GhcPs) -> Analyzer ()
walkGRHSs (GRHSs _ grhss localBinds) = do
  mapM_ walkGRHS grhss
  walkLocalBinds localBinds

-- | Walk a single guarded right-hand side.
--
-- A 'GRHS' contains:
--   * A list of guard statements (empty for unguarded equations)
--   * The body expression
--
-- Guard expressions and the body are not walked yet (deferred to
-- Phase 4.3 when walkExpr is available).
walkGRHS :: LGRHS GhcPs (LHsExpr GhcPs) -> Analyzer ()
walkGRHS (L _ (GRHS _ _guards _body)) =
  -- Guards and body walking deferred to Phase 4.3
  -- (requires walkExpr / walkStmt which is in Rules.Expressions)
  pure ()

-- | Walk local bindings from a where clause or let expression.
--
-- Dispatches each local binding to the appropriate declaration walker:
--   * 'FunBind' -> 'walkFunBind' (local function definition)
--   * 'PatBind' -> 'walkPatBind' (local pattern binding)
--   * 'TypeSig' -> 'walkTypeSig' (local type signature)
--
-- Example:
-- @
--   foo x = helper x
--     where
--       helper :: Int -> Int    -- TypeSig -> walkTypeSig
--       helper y = y + 1       -- FunBind -> walkFunBind
-- @
walkLocalBinds :: HsLocalBindsLR GhcPs GhcPs -> Analyzer ()
walkLocalBinds (EmptyLocalBinds _) = pure ()
walkLocalBinds (HsValBinds _ valBinds) = walkValBinds valBinds
walkLocalBinds (HsIPBinds _ _) = pure ()  -- Implicit parameters: rare, skip

-- | Walk value bindings from a where/let block.
walkValBinds :: HsValBindsLR GhcPs GhcPs -> Analyzer ()
walkValBinds (ValBinds _ binds sigs) = do
  -- Walk each local binding
  mapM_ walkLocalBind (bagToList binds)
  -- Walk each local type signature
  mapM_ walkLocalSig sigs
walkValBinds (XValBindsLR _) = pure ()  -- Post-renaming: not applicable to GhcPs

-- | Walk a single local binding (from a where/let block).
walkLocalBind :: GenLocated l (HsBindLR GhcPs GhcPs) -> Analyzer ()
walkLocalBind (L _ (FunBind { fun_id = funId, fun_matches = matches })) =
  walkFunBind funId matches
walkLocalBind (L _ (PatBind { pat_lhs = pat, pat_rhs = rhs })) =
  walkPatBind pat rhs
walkLocalBind _ = pure ()  -- VarBind, PatSynBind, etc: skip

-- | Walk a local type signature (from a where/let block).
walkLocalSig :: GenLocated l (Sig GhcPs) -> Analyzer ()
walkLocalSig (L _ (TypeSig _ names sigType)) = walkTypeSig names sigType
walkLocalSig _ = pure ()  -- Other signature kinds: skip

{-# LANGUAGE OverloadedStrings #-}
-- | Phase 2 rule: top-level value declarations.
--
-- Handles three GHC AST constructs:
--   * 'FunBind'  -> FUNCTION node
--   * 'PatBind'  -> VARIABLE node
--   * 'TypeSig'  -> TYPE_SIGNATURE node + HAS_SIGNATURE edge
--
-- Called from 'Analysis.Walker.walkDecl' for 'ValD' and 'SigD' constructors.
-- Phase 2 scope: emit declaration-level nodes only. Match bodies and RHS
-- expressions are not walked (deferred to Phase 4).
module Rules.Declarations
  ( walkFunBind
  , walkPatBind
  , walkTypeSig
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GHC.Hs (GhcPs, LIdP)
import GHC.Hs.Expr (MatchGroup, GRHSs, LHsExpr)
import GHC.Hs.Pat (LPat, Pat(..))
import GHC.Hs.Type (LHsSigWcType, HsWildCardBndrs(..), HsSigType(..))
import GHC.Types.SrcLoc (GenLocated(..), unLoc)
import GHC.Types.Name.Reader (rdrNameOcc)
import GHC.Types.Name.Occurrence (occNameString)

import Analysis.Context (Analyzer, emitNode, emitEdge, askFile, askModuleId)
import Analysis.Types (GraphNode(..), GraphEdge(..))
import Grafema.SemanticId (semanticId)
import Loc (getLocN)

import Rules.Effects (walkTypeSigForEffects)
import Rules.Types (walkType)

-- | Walk a function binding ('FunBind'), emitting a FUNCTION node and a
-- CONTAINS edge from the enclosing module.
--
-- @walkFunBind funId matches@ extracts the function name from @funId@
-- (a located 'RdrName') and emits:
--   * FUNCTION node with semantic ID @file->FUNCTION->name@
--   * CONTAINS edge from the module to the function
--
-- The match group is ignored in Phase 2 (no body walking yet).
walkFunBind :: LIdP GhcPs -> MatchGroup GhcPs (LHsExpr GhcPs) -> Analyzer ()
walkFunBind funId _matches = do
  file     <- askFile
  moduleId <- askModuleId
  let name = T.pack (occNameString (rdrNameOcc (unLoc funId)))
  let (line, col, endLine, endCol) = getLocN funId
  let nodeId = semanticId file "FUNCTION" name Nothing Nothing
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.empty
    }
  emitEdge GraphEdge
    { geSource   = moduleId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- | Walk a pattern binding ('PatBind'), emitting a VARIABLE node for simple
-- variable patterns.
--
-- For Phase 2 only simple 'VarPat' patterns are handled (e.g. @x = 42@).
-- Complex patterns (tuples, constructors, etc.) are deferred to a later phase.
-- The RHS is not walked.
walkPatBind :: LPat GhcPs -> GRHSs GhcPs (LHsExpr GhcPs) -> Analyzer ()
walkPatBind pat _rhs = do
  file     <- askFile
  moduleId <- askModuleId
  case unLoc pat of
    VarPat _ locName -> do
      let name = T.pack (occNameString (rdrNameOcc (unLoc locName)))
      let (line, col, endLine, endCol) = getLocN locName
      let nodeId = semanticId file "VARIABLE" name Nothing Nothing
      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "VARIABLE"
        , gnName      = name
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = endLine
        , gnEndColumn = endCol
        , gnExported  = False
        , gnMetadata  = Map.empty
        }
      emitEdge GraphEdge
        { geSource   = moduleId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }
    _ -> pure ()  -- Complex patterns deferred to later phase

-- | Walk a type signature ('TypeSig'), emitting a TYPE_SIGNATURE node for
-- each name in the signature and a HAS_SIGNATURE edge.
--
-- A Haskell type signature may cover multiple names:
-- @foo, bar :: Int -> Int@
-- This emits one TYPE_SIGNATURE node per name.
--
-- Phase 6: also walks the type for effects (monadic return types)
-- and constraints, and emits type-level nodes.
walkTypeSig :: [LIdP GhcPs] -> LHsSigWcType GhcPs -> Analyzer ()
walkTypeSig names sigType = do
  file     <- askFile
  moduleId <- askModuleId
  mapM_ (emitTypeSigNode file moduleId) names
  -- Phase 6: detect monadic effects from the type signature.
  -- For each name in the signature, check if the return type is effectful.
  mapM_ (\locName -> do
    let name = T.pack (occNameString (rdrNameOcc (unLoc locName)))
    let funcNodeId = semanticId file "FUNCTION" name Nothing Nothing
    walkTypeSigForEffects funcNodeId sigType
    ) names
  -- Phase 6: walk the type for constraints and other type-level nodes.
  case sigType of
    HsWC _ (L _ sigTy) -> walkType (sig_body sigTy)

-- | Emit a TYPE_SIGNATURE node and HAS_SIGNATURE edge for a single name.
emitTypeSigNode :: T.Text -> T.Text -> LIdP GhcPs -> Analyzer ()
emitTypeSigNode file _moduleId locName = do
  let name = T.pack (occNameString (rdrNameOcc (unLoc locName)))
  let (line, col, endLine, endCol) = getLocN locName
  let nodeId = semanticId file "TYPE_SIGNATURE" name Nothing Nothing
  -- The target function node ID (used for the HAS_SIGNATURE edge).
  -- The function may not have been emitted yet, but the edge is valid
  -- because edges are resolved by ID, not by emission order.
  let targetId = semanticId file "FUNCTION" name Nothing Nothing
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "TYPE_SIGNATURE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.empty
    }
  emitEdge GraphEdge
    { geSource   = targetId
    , geTarget   = nodeId
    , geType     = "HAS_SIGNATURE"
    , geMetadata = Map.empty
    }


{-# LANGUAGE OverloadedStrings #-}
-- | AST walker that traverses the GHC parse tree and emits graph nodes.
--
-- Phase 1: extracts the module name from 'HsModule' and emits a MODULE
-- 'GraphNode'.
-- Phase 2: dispatches top-level declarations to rule modules
-- ('Rules.Declarations', 'Rules.DataTypes', 'Rules.TypeClasses',
-- 'Rules.TypeLevel').
-- Phase 3: walks import declarations and export lists
-- ('Rules.Imports', 'Rules.Exports').
-- Phase 4: walks into function bodies, emitting expression-level nodes
-- ('Rules.Expressions'), pattern nodes ('Rules.Patterns'), and
-- guard\/where-clause nodes.
module Analysis.Walker
  ( walkModule
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GHC.Hs (HsModule(..), GhcPs)
import GHC.Hs.Decls (HsDecl(..), TyClDecl(..), InstDecl(..))
import GHC.Hs.Binds (HsBindLR(..), Sig(..))
import GHC.Types.SrcLoc (GenLocated(..))
import GHC.Parser.Annotation (SrcSpanAnnA)
import GHC.Unit.Module (moduleNameString)

import Analysis.Context (emitNode, askFile, askModuleId, Analyzer)
import Analysis.Types (GraphNode(..))
import Loc (getLoc)

import Rules.Declarations (walkFunBind, walkPatBind, walkTypeSig)
import Rules.DataTypes (walkDataDecl)
import Rules.TypeClasses (walkClassDecl, walkInstDecl)
import Rules.TypeLevel (walkTypeSynonym, walkTypeFamily)
import Rules.Imports (walkImports)
import Rules.Exports (walkExports)
import Rules.Expressions (walkMatchGroup, walkGRHSs)

-- | Walk a parsed Haskell module, emitting graph nodes.
--
-- Phase 1: emits the MODULE node.
-- Phase 2: dispatches each top-level declaration to the appropriate
-- rule module.
walkModule :: HsModule GhcPs -> Analyzer ()
walkModule hsmod = do
  file     <- askFile
  moduleId <- askModuleId

  -- Extract module name (default to file path if no module header)
  let modName = case hsmodName hsmod of
        Just (L _ name) -> T.pack (moduleNameString name)
        Nothing         -> file  -- unnamed modules (like Main)

  -- Extract location from module header
  let (line, col, endLine, endCol) = case hsmodName hsmod of
        Just located -> getLoc located
        Nothing      -> (1, 0, 1, 0)  -- default to line 1

  -- Emit MODULE node
  emitNode GraphNode
    { gnId        = moduleId
    , gnType      = "MODULE"
    , gnName      = modName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True
    , gnMetadata  = Map.empty
    }

  -- Walk imports (Phase 3)
  walkImports (hsmodImports hsmod)

  -- Walk exports (Phase 3)
  walkExports (hsmodExports hsmod)

  -- Walk declarations, dispatching to rule modules
  mapM_ walkDecl (hsmodDecls hsmod)

-- | Dispatch a top-level declaration to the appropriate rule module.
--
-- Pattern matches on 'HsDecl' constructors:
--   * 'ValD' (function/pattern bindings) -> 'Rules.Declarations'
--   * 'SigD' (type signatures)           -> 'Rules.Declarations'
--   * 'TyClD' (type/class declarations)  -> 'Rules.DataTypes', 'Rules.TypeClasses', 'Rules.TypeLevel'
--   * 'InstD' (instance declarations)    -> 'Rules.TypeClasses'
--   * Everything else                    -> skipped (deferred to later phases)
walkDecl :: GenLocated SrcSpanAnnA (HsDecl GhcPs) -> Analyzer ()
walkDecl (L _ decl) = case decl of
  -- Value declarations: function bindings
  ValD _ (FunBind { fun_id = funId, fun_matches = matches }) -> do
    walkFunBind funId matches
    walkMatchGroup matches  -- Phase 4: walk into function body

  -- Value declarations: pattern bindings
  ValD _ (PatBind { pat_lhs = pat, pat_rhs = rhs }) -> do
    walkPatBind pat rhs
    walkGRHSs rhs  -- Phase 4: walk into RHS expressions

  -- Type signatures
  SigD _ (TypeSig _ names sigType) ->
    walkTypeSig names sigType

  -- Data/newtype declarations
  TyClD _ (DataDecl { tcdLName = name, tcdDataDefn = defn }) ->
    walkDataDecl name defn

  -- Type class declarations
  TyClD _ (ClassDecl { tcdLName = name, tcdSigs = sigs }) ->
    walkClassDecl name sigs

  -- Type synonyms
  TyClD _ (SynDecl { tcdLName = name }) ->
    walkTypeSynonym name

  -- Type families
  TyClD _ (FamDecl { tcdFam = famDecl }) ->
    walkTypeFamily famDecl

  -- Instance declarations
  InstD _ (ClsInstD _ cid) ->
    walkInstDecl cid

  -- Everything else: skip for now (imports, foreign decls, etc.)
  _ -> pure ()

{-# LANGUAGE OverloadedStrings #-}
-- | Phase 2 rule: type class and instance declarations.
--
-- Handles two GHC AST constructs:
--   * 'ClassDecl' -> TYPE_CLASS node
--   * 'ClsInstDecl' -> INSTANCE node + deferred IMPLEMENTS edge
--
-- Called from 'Analysis.Walker.walkDecl' for @TyClD _ (ClassDecl ...)@
-- and @InstD _ (ClsInstD ...)@.
-- Phase 2 scope: emit declaration-level nodes only. Class method
-- signatures are iterated but method bodies are not walked (deferred to
-- later phases).
module Rules.TypeClasses
  ( walkClassDecl
  , walkInstDecl
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GHC.Hs (GhcPs, LIdP)
import GHC.Hs.Binds (LSig, Sig(..))
import GHC.Hs.Decls (ClsInstDecl(..))
import GHC.Hs.Type (LHsSigType, HsSigType(..), HsType(..))
import GHC.Types.SrcLoc (GenLocated(..), unLoc)
import GHC.Types.Name.Reader (rdrNameOcc)
import GHC.Types.Name.Occurrence (occNameString)

import Analysis.Context
  ( Analyzer, emitNode, emitEdge, emitDeferred
  , askFile, askModuleId
  )
import Analysis.Types (GraphNode(..), GraphEdge(..), DeferredRef(..), DeferredKind(..))
import Grafema.SemanticId (semanticId)
import Loc (getLoc, getLocN)

-- | Walk a class declaration ('ClassDecl'), emitting a TYPE_CLASS node,
-- a CONTAINS edge from the enclosing module, and TYPE_SIGNATURE nodes
-- for each class method signature.
--
-- @walkClassDecl className sigs@ extracts the class name from @className@
-- (a located 'RdrName') and emits:
--   * TYPE_CLASS node with semantic ID @file->TYPE_CLASS->name@
--   * CONTAINS edge from the module to the class
--   * TYPE_SIGNATURE node per method signature + HAS_METHOD edge
--
-- Method bodies (default implementations) are not walked in Phase 2.
walkClassDecl :: LIdP GhcPs -> [LSig GhcPs] -> Analyzer ()
walkClassDecl className sigs = do
  file     <- askFile
  moduleId <- askModuleId
  let name = T.pack (occNameString (rdrNameOcc (unLoc className)))
  let (line, col, endLine, endCol) = getLocN className
  let nodeId = semanticId file "TYPE_CLASS" name Nothing Nothing
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "TYPE_CLASS"
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
  -- Walk class method signatures
  mapM_ (walkClassMethodSig file nodeId) sigs

-- | Emit a TYPE_SIGNATURE node and HAS_METHOD edge for a class method signature.
--
-- Only 'TypeSig' and 'ClassOpSig' are handled; other signatures (fixity,
-- inline pragmas, etc.) are ignored.
walkClassMethodSig :: T.Text -> T.Text -> LSig GhcPs -> Analyzer ()
walkClassMethodSig file classNodeId (L _ (TypeSig _ names _sigType)) =
  mapM_ (emitMethodSig file classNodeId) names
walkClassMethodSig file classNodeId (L _ (ClassOpSig _ _ names _sigType)) =
  mapM_ (emitMethodSig file classNodeId) names
walkClassMethodSig _ _ _ = pure ()

-- | Emit a TYPE_SIGNATURE node for a single method name + HAS_METHOD edge
-- from the class node.
emitMethodSig :: T.Text -> T.Text -> LIdP GhcPs -> Analyzer ()
emitMethodSig file classNodeId locName = do
  let name = T.pack (occNameString (rdrNameOcc (unLoc locName)))
  let (line, col, endLine, endCol) = getLocN locName
  let sigNodeId = semanticId file "TYPE_SIGNATURE" name (Just "class") Nothing
  emitNode GraphNode
    { gnId        = sigNodeId
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
    { geSource   = classNodeId
    , geTarget   = sigNodeId
    , geType     = "HAS_METHOD"
    , geMetadata = Map.empty
    }

-- | Walk an instance declaration ('ClsInstDecl'), emitting an INSTANCE
-- node, a CONTAINS edge, and a deferred IMPLEMENTS edge to the class.
--
-- The instance head text (e.g. \"Show Color\") is extracted from
-- 'cid_poly_ty'. The class name is extracted by unwrapping 'HsAppTy'
-- applications to find the leftmost 'HsTyVar'.
--
-- Instance method bindings are not walked in Phase 2.
walkInstDecl :: ClsInstDecl GhcPs -> Analyzer ()
walkInstDecl cid = do
  file     <- askFile
  moduleId <- askModuleId
  let instType = cid_poly_ty cid
  let instText = renderInstHead instType
  let classNameText = extractClassName instType
  let (line, col, endLine, endCol) = getLoc instType
  let nodeId = semanticId file "INSTANCE" instText Nothing Nothing
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "INSTANCE"
    , gnName      = instText
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
  -- Emit deferred IMPLEMENTS edge to the type class (cross-file resolution).
  -- If we can extract the class name, emit a deferred reference;
  -- otherwise skip (unresolvable instance heads are rare).
  case classNameText of
    Just cn ->
      emitDeferred DeferredRef
        { drKind       = CallResolve
        , drName       = cn
        , drFromNodeId = nodeId
        , drEdgeType   = "IMPLEMENTS"
        , drScopeId    = Nothing
        , drSource     = Nothing
        , drFile       = file
        , drLine       = line
        , drColumn     = col
        , drReceiver   = Nothing
        , drMetadata   = Map.empty
        }
    Nothing -> pure ()

-- ── Helpers ──────────────────────────────────────────────────────────────

-- | Extract the class name from an instance type signature.
--
-- Given @instance Show Color where ...@, the 'cid_poly_ty' wraps:
-- @HsSig { sig_body = HsAppTy _ classNameTy argTy }@
-- where @classNameTy = HsTyVar _ _ (L _ className)@.
--
-- For multi-param instances like @instance Monad (StateT s m)@, the
-- outermost 'HsAppTy' chain is unwrapped leftward to find the head.
extractClassName :: LHsSigType GhcPs -> Maybe T.Text
extractClassName (L _ (HsSig { sig_body = body })) = go (unLoc body)
  where
    go (HsAppTy _ (L _ f) _) = go f
    go (HsTyVar _ _ (L _ name)) =
      Just (T.pack (occNameString (rdrNameOcc name)))
    go (HsParTy _ (L _ inner)) = go inner
    go _ = Nothing

-- | Render the instance head as human-readable text.
--
-- Produces e.g. @\"Show Color\"@, @\"Functor (Either e)\"@.
-- This is a best-effort rendering; complex types fall back to
-- @\"\<instance\>\"@.
renderInstHead :: LHsSigType GhcPs -> T.Text
renderInstHead (L _ (HsSig { sig_body = body })) = renderType (unLoc body)

-- | Best-effort type renderer for instance heads.
renderType :: HsType GhcPs -> T.Text
renderType (HsTyVar _ _ (L _ name)) =
  T.pack (occNameString (rdrNameOcc name))
renderType (HsAppTy _ (L _ f) (L _ a)) =
  renderType f <> " " <> renderAtomicType a
renderType (HsParTy _ (L _ inner)) =
  "(" <> renderType inner <> ")"
renderType (HsListTy _ (L _ inner)) =
  "[" <> renderType inner <> "]"
renderType (HsTupleTy _ _ ts) =
  "(" <> T.intercalate ", " (map (renderType . unLoc) ts) <> ")"
renderType (HsFunTy _ _ (L _ a) (L _ b)) =
  renderType a <> " -> " <> renderType b
renderType _ = "<instance>"

-- | Render a type that may need parentheses in application position.
-- Atomic types (variables, parens, lists) are rendered as-is;
-- compound types are wrapped in parentheses.
renderAtomicType :: HsType GhcPs -> T.Text
renderAtomicType t@(HsTyVar {})  = renderType t
renderAtomicType t@(HsParTy {})  = renderType t
renderAtomicType t@(HsListTy {}) = renderType t
renderAtomicType t@(HsTupleTy {}) = renderType t
renderAtomicType t = "(" <> renderType t <> ")"

{-# LANGUAGE OverloadedStrings #-}
-- | Phase 14 rule: type-level constructs — generics, lifetimes, bounds.
--
-- Handles these Rust type-level constructs:
--   * 'ItemType'            -> TYPE_ALIAS node
--   * 'TypeReference' with lifetime -> LIFETIME node + LIFETIME_OF edge
--   * 'TypeImplTrait'       -> TRAIT_BOUND nodes per bound
--   * 'TypeTraitObject'     -> TRAIT_BOUND nodes per bound
--
-- Edge types emitted:
--   * CONTAINS     -- scope -> type_alias / lifetime / trait_bound
--   * LIFETIME_OF  -- lifetime -> lifetime (self-edge marking the reference)
--
-- Called from 'Analysis.Walker.walkFile' for each top-level item.
-- Recursively walks types in function signatures, struct fields, enum
-- variant fields, impl blocks, and trait definitions to discover
-- lifetimes and trait bounds.
module Rules.TypeLevel
  ( walkTypeLevel
  ) where

import Control.Monad (forM_)
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import RustAST
import Analysis.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , askFile
    , askScopeId
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Visibility helpers ─────────────────────────────────────────────────

-- | Convert a 'Vis' to its text representation for metadata.
visToText :: Vis -> Text
visToText VisPub        = "pub"
visToText VisPubCrate   = "pub(crate)"
visToText VisPubSuper   = "pub(super)"
visToText (VisPubIn t)  = "pub(in " <> t <> ")"
visToText VisPrivate    = "private"

-- | Is this visibility public (exported)?
isPub :: Vis -> Bool
isPub VisPub      = True
isPub VisPubCrate = True
isPub _           = False

-- ── Top-level item walker ──────────────────────────────────────────────

-- | Walk a single Rust item for type-level constructs.
--
-- Handles ItemType (type aliases) directly and recurses into function
-- signatures, struct fields, enum variants, impl blocks, and traits
-- to discover lifetimes and trait bounds in types.
walkTypeLevel :: RustItem -> Analyzer ()

-- ── ItemType → TYPE_ALIAS ──────────────────────────────────────────────

walkTypeLevel (ItemType ident vis ty sp _attrs) = do
  file    <- askFile
  scopeId <- askScopeId

  let line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)
      nodeId = semanticId file "TYPE_ALIAS" ident Nothing Nothing

  -- Emit TYPE_ALIAS node
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "TYPE_ALIAS"
    , gnName     = ident
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = isPub vis
    , gnMetadata = Map.fromList [("visibility", MetaText (visToText vis))]
    }

  -- Emit CONTAINS edge from parent scope to this type alias
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk the aliased type for lifetimes and trait bounds
  walkType ty

-- ── ItemFn → walk function signature types ─────────────────────────────

walkTypeLevel (ItemFn _ident _vis sig _block _attrs _sp) = do
  -- Walk function parameter types and return type for lifetimes/bounds
  mapM_ walkFnArgType (fsInputs sig)
  mapM_ walkType (fsOutput sig)

-- ── ItemStruct → walk struct field types ───────────────────────────────

walkTypeLevel (ItemStruct _ident _vis fields _attrs _sp _isTuple _isUnit) = do
  mapM_ (walkType . rfTy) fields

-- ── ItemEnum → walk variant field types ────────────────────────────────

walkTypeLevel (ItemEnum _ident _vis variants _attrs _sp) = do
  mapM_ (\v -> mapM_ (walkType . rfTy) (rvFields v)) variants

-- ── ItemImpl → walk self type + recurse items ──────────────────────────

walkTypeLevel (ItemImpl selfTy _trait items _sp _attrs _unsafe) = do
  walkType selfTy
  mapM_ walkTypeLevel items

-- ── ItemTrait → recurse items ──────────────────────────────────────────

walkTypeLevel (ItemTrait _ident _vis items _attrs _sp _unsafe) = do
  mapM_ walkTypeLevel items

-- ── ItemTraitMethod → walk signature types ─────────────────────────────

walkTypeLevel (ItemTraitMethod _ident sig _sp _attrs) = do
  mapM_ walkFnArgType (fsInputs sig)
  mapM_ walkType (fsOutput sig)

-- ── ItemConst / ItemStatic → walk their types ──────────────────────────

walkTypeLevel (ItemConst _ident _vis ty _expr _sp _attrs) = walkType ty
walkTypeLevel (ItemStatic _ident _vis ty _mut _expr _sp _attrs) = walkType ty

-- All other items: silently skip
walkTypeLevel _ = pure ()

-- ── Function argument type walker ──────────────────────────────────────

-- | Walk a function argument's type for lifetimes and trait bounds.
walkFnArgType :: RustFnArg -> Analyzer ()
walkFnArgType (FnArgSelf _) = pure ()
walkFnArgType (FnArgTyped _ ty) = walkType ty

-- ── Type walker ────────────────────────────────────────────────────────

-- | Walk a type recursively, emitting LIFETIME and TRAIT_BOUND nodes
-- and associated edges when encountered.
walkType :: RustType -> Analyzer ()

-- TypeReference with lifetime → LIFETIME node + LIFETIME_OF edge
walkType (TypeReference (Just lifetime) _mut elem sp) = do
  file    <- askFile
  scopeId <- askScopeId

  let line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)
      hash   = contentHash [("line", T.pack (show line)), ("col", T.pack (show col))]
      nodeId = semanticId file "LIFETIME" lifetime Nothing (Just hash)

  -- Emit LIFETIME node
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "LIFETIME"
    , gnName     = lifetime
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.empty
    }

  -- Emit CONTAINS edge from scope to lifetime
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit LIFETIME_OF self-edge marking the reference type
  emitEdge GraphEdge
    { geSource   = nodeId
    , geTarget   = nodeId
    , geType     = "LIFETIME_OF"
    , geMetadata = Map.empty
    }

  -- Recurse into the referenced element type
  walkType elem

-- TypeReference without lifetime → recurse into element type
walkType (TypeReference Nothing _mut elem _sp) = walkType elem

-- TypeImplTrait → TRAIT_BOUND per bound
walkType (TypeImplTrait bounds sp) = do
  file    <- askFile
  scopeId <- askScopeId

  let line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)

  forM_ (zip [0::Int ..] bounds) $ \(idx, bound) -> do
    let hash   = contentHash [("line", T.pack (show line)), ("index", T.pack (show idx))]
        nodeId = semanticId file "TRAIT_BOUND" bound Nothing (Just hash)

    emitNode GraphNode
      { gnId       = nodeId
      , gnType     = "TRAIT_BOUND"
      , gnName     = bound
      , gnFile     = file
      , gnLine     = line
      , gnColumn   = col
      , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
      , gnMetadata = Map.empty
      }

    emitEdge GraphEdge
      { geSource   = scopeId
      , geTarget   = nodeId
      , geType     = "CONTAINS"
      , geMetadata = Map.empty
      }

-- TypeTraitObject → TRAIT_BOUND per bound (same as ImplTrait)
walkType (TypeTraitObject bounds sp) = do
  file    <- askFile
  scopeId <- askScopeId

  let line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)

  forM_ (zip [0::Int ..] bounds) $ \(idx, bound) -> do
    let hash   = contentHash [("line", T.pack (show line)), ("index", T.pack (show idx))]
        nodeId = semanticId file "TRAIT_BOUND" bound Nothing (Just hash)

    emitNode GraphNode
      { gnId       = nodeId
      , gnType     = "TRAIT_BOUND"
      , gnName     = bound
      , gnFile     = file
      , gnLine     = line
      , gnColumn   = col
      , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
      , gnMetadata = Map.empty
      }

    emitEdge GraphEdge
      { geSource   = scopeId
      , geTarget   = nodeId
      , geType     = "CONTAINS"
      , geMetadata = Map.empty
      }

-- TypeSlice → recurse
walkType (TypeSlice elem _sp) = walkType elem

-- TypeArray → recurse
walkType (TypeArray elem _sp) = walkType elem

-- TypeTuple → recurse each element
walkType (TypeTuple elems _sp) = mapM_ walkType elems

-- TypeFn → recurse inputs and output
walkType (TypeFn inputs mOutput _sp) = do
  mapM_ walkType inputs
  mapM_ walkType mOutput

-- TypePath → recurse type arguments
walkType (TypePath _path args _sp) = mapM_ walkType args

-- TypeNever, TypeUnknown → nothing to do
walkType (TypeNever _) = pure ()
walkType (TypeUnknown _) = pure ()

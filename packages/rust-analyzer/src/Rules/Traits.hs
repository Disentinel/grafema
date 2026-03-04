{-# LANGUAGE OverloadedStrings #-}
-- | Phase 5 rule: traits and impl blocks.
--
-- Handles these Rust AST constructs:
--   * 'ItemTrait'       -> TRAIT node + HAS_METHOD edges + TYPE_SIGNATURE / ASSOCIATED_TYPE children
--   * 'ItemImpl' (bare) -> IMPL_BLOCK node (inherent impl)
--   * 'ItemImpl' (trait) -> IMPL_BLOCK node + deferred IMPLEMENTS reference
--   * 'ItemTraitMethod' -> TYPE_SIGNATURE node (method signature without body)
--   * 'ItemAssocType'   -> ASSOCIATED_TYPE node
--
-- Also emits CONTAINS edges:
--   * module     -> trait
--   * module     -> impl_block
--   * trait      -> type_signature
--   * trait      -> associated_type
--
-- Methods inside impl blocks are delegated to 'Rules.Declarations.walkDeclarations'
-- for FUNCTION node emission. Default methods inside traits are also delegated.
--
-- Called from 'Analysis.Walker.walkFile' for each top-level item.
module Rules.Traits
  ( walkTraits
  ) where

import Data.Text (Text)
import qualified Data.Map.Strict as Map

import RustAST
import Analysis.Types
    ( GraphNode(..)
    , GraphEdge(..)
    , MetaValue(..)
    , DeferredRef(..)
    , DeferredKind(..)
    , Scope(..)
    , ScopeKind(..)
    )
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , emitDeferred
    , askFile
    , askScopeId
    , askExported
    , askNamedParent
    , withScope
    , withEnclosingImpl
    , withNamedParent
    , withExported
    )
import Grafema.SemanticId (semanticId)
import Rules.Declarations (walkDeclarations)

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

-- ── Type name extraction ────────────────────────────────────────────────

-- | Extract a human-readable name from a RustType (for impl block target).
-- For TypePath, uses the path text. For other types, returns "<unknown>".
typeToName :: RustType -> Text
typeToName (TypePath p _ _) = p
typeToName _                = "<unknown>"

-- ── Top-level item walker ───────────────────────────────────────────────

-- | Walk a single Rust item for trait/impl block analysis.
--
-- Handles ItemTrait, ItemImpl, ItemTraitMethod, and ItemAssocType.
-- Other item types are silently ignored (handled by other rule modules).
walkTraits :: RustItem -> Analyzer ()

-- ── ItemTrait ───────────────────────────────────────────────────────────

walkTraits (ItemTrait ident vis items _attrs sp isUnsafe) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let traitExported = exported || isPub vis
      nodeId = semanticId file "TRAIT" ident parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  -- Emit TRAIT node
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "TRAIT"
    , gnName     = ident
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = traitExported
    , gnMetadata = Map.fromList
        [ ("visibility", MetaText (visToText vis))
        , ("unsafe",     MetaBool isUnsafe)
        ]
    }

  -- Emit CONTAINS edge from parent scope to trait
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk trait items inside a TraitScope
  let traitScope = Scope
        { scopeId           = nodeId
        , scopeKind         = TraitScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  let bodyAction = if traitExported then withExported else id
  bodyAction $
    withScope traitScope $
    withNamedParent ident $
      mapM_ (walkTraitItem file nodeId ident) items

-- ── ItemImpl (inherent — no trait) ──────────────────────────────────────

walkTraits (ItemImpl selfTy Nothing items sp _attrs _isUnsafe) = do
  file     <- askFile
  scopeId  <- askScopeId

  let typeName = typeToName selfTy
      nodeId   = semanticId file "IMPL_BLOCK" typeName Nothing Nothing
      line     = posLine (spanStart sp)
      col      = posCol  (spanStart sp)

  -- Emit IMPL_BLOCK node (inherent impl)
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "IMPL_BLOCK"
    , gnName     = typeName
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("target_type", MetaText typeName)
        ]
    }

  -- Emit CONTAINS edge from parent scope to impl block
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk impl items in an ImplScope
  let implScope = Scope
        { scopeId           = nodeId
        , scopeKind         = ImplScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope implScope $
    withEnclosingImpl nodeId $
    withNamedParent typeName $
      mapM_ walkDeclarations items

-- ── ItemImpl (trait impl) ───────────────────────────────────────────────

walkTraits (ItemImpl selfTy (Just traitName) items sp _attrs _isUnsafe) = do
  file     <- askFile
  scopeId  <- askScopeId

  let typeName = typeToName selfTy
      nodeId   = semanticId file "IMPL_BLOCK" typeName (Just traitName) Nothing
      line     = posLine (spanStart sp)
      col      = posCol  (spanStart sp)

  -- Emit IMPL_BLOCK node (trait impl)
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "IMPL_BLOCK"
    , gnName     = typeName
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("target_type", MetaText typeName)
        , ("trait",       MetaText traitName)
        ]
    }

  -- Emit CONTAINS edge from parent scope to impl block
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit deferred IMPLEMENTS reference for cross-file resolution
  emitDeferred DeferredRef
    { drKind       = ImplResolve
    , drName       = traitName
    , drFromNodeId = nodeId
    , drEdgeType   = "IMPLEMENTS"
    , drScopeId    = Nothing
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Just typeName
    , drMetadata   = Map.empty
    }

  -- Walk impl items in an ImplScope
  let implScope = Scope
        { scopeId           = nodeId
        , scopeKind         = ImplScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope implScope $
    withEnclosingImpl nodeId $
    withNamedParent typeName $
      mapM_ walkDeclarations items

-- All other items: silently skip (handled by other phases)
walkTraits _ = pure ()

-- ── Trait item walkers ──────────────────────────────────────────────────

-- | Walk items inside a trait definition.
-- Dispatches to specialized handlers for method signatures, associated types,
-- and default method implementations.
walkTraitItem :: Text -> Text -> Text -> RustItem -> Analyzer ()

-- Method signature (no body) -> TYPE_SIGNATURE node + HAS_METHOD edge
walkTraitItem file traitId traitName (ItemTraitMethod ident _sig sp _attrs) = do
  let nodeId = semanticId file "TYPE_SIGNATURE" ident (Just traitName) Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  -- Emit TYPE_SIGNATURE node
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "TYPE_SIGNATURE"
    , gnName     = ident
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.empty
    }

  -- Emit HAS_METHOD edge from trait to method signature
  emitEdge GraphEdge
    { geSource   = traitId
    , geTarget   = nodeId
    , geType     = "HAS_METHOD"
    , geMetadata = Map.empty
    }

-- Associated type -> ASSOCIATED_TYPE node
walkTraitItem file traitId traitName (ItemAssocType ident sp _attrs) = do
  let nodeId = semanticId file "ASSOCIATED_TYPE" ident (Just traitName) Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  -- Emit ASSOCIATED_TYPE node
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "ASSOCIATED_TYPE"
    , gnName     = ident
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.empty
    }

  -- Emit CONTAINS edge from trait to associated type
  emitEdge GraphEdge
    { geSource   = traitId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- Default method (has a body) -> delegate to walkDeclarations for FUNCTION node
walkTraitItem _file _traitId _traitName item@(ItemFn {}) =
  walkDeclarations item

-- Other items inside trait: silently skip
walkTraitItem _file _traitId _traitName _ = pure ()

{-# LANGUAGE OverloadedStrings #-}
-- | Phase 4 rule: data types — STRUCT, ENUM, VARIANT nodes.
--
-- Handles these Rust AST constructs:
--   * 'ItemStruct' -> STRUCT node + HAS_FIELD edges
--   * 'ItemEnum'   -> ENUM node + VARIANT nodes + HAS_FIELD edges
--
-- Also emits CONTAINS edges:
--   * module → struct
--   * module → enum
--   * enum   → variant
--
-- Called from 'Analysis.Walker.walkFile' for each top-level item.
module Rules.DataTypes
  ( walkDataTypes
  ) where

import Data.Text (Text)
import qualified Data.Map.Strict as Map

import RustAST
import Analysis.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , askFile
    , askScopeId
    , askExported
    , askNamedParent
    )
import Grafema.SemanticId (semanticId)

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

-- | Walk a single Rust item, emitting STRUCT/ENUM/VARIANT nodes,
-- CONTAINS edges, and HAS_FIELD edges.
--
-- Handles ItemStruct and ItemEnum. Other item types are silently
-- ignored (handled by other rule modules).
walkDataTypes :: RustItem -> Analyzer ()

-- Struct declaration
walkDataTypes (ItemStruct ident vis fields _attrs sp isTupleStruct isUnitStruct) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let structExported = exported || isPub vis
      nodeId = semanticId file "STRUCT" ident parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  -- Emit STRUCT node
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "STRUCT"
    , gnName     = ident
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = structExported
    , gnMetadata = Map.fromList
        [ ("visibility", MetaText (visToText vis))
        , ("tuple",      MetaBool isTupleStruct)
        , ("unit",       MetaBool isUnitStruct)
        ]
    }

  -- Emit CONTAINS edge from parent scope to struct
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit HAS_FIELD edges for each named field
  emitFieldEdges nodeId fields

-- Enum declaration
walkDataTypes (ItemEnum ident vis variants _attrs sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let enumExported = exported || isPub vis
      nodeId = semanticId file "ENUM" ident parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  -- Emit ENUM node
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "ENUM"
    , gnName     = ident
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = enumExported
    , gnMetadata = Map.fromList
        [ ("visibility", MetaText (visToText vis))
        ]
    }

  -- Emit CONTAINS edge from parent scope to enum
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk each variant
  mapM_ (walkVariant file nodeId ident) variants

-- All other items: silently skip (handled by other phases)
walkDataTypes _ = pure ()

-- ── Variant walker ─────────────────────────────────────────────────────

-- | Walk a single enum variant, emitting a VARIANT node, a CONTAINS
-- edge from the enum to the variant, and HAS_FIELD edges for fields.
walkVariant :: Text -> Text -> Text -> RustVariant -> Analyzer ()
walkVariant file enumId enumName (RustVariant ident fields sp) = do
  let variantId = semanticId file "VARIANT" ident Nothing (Just enumName)
      line      = posLine (spanStart sp)
      col       = posCol  (spanStart sp)
      kind      = detectVariantKind fields

  -- Emit VARIANT node
  emitNode GraphNode
    { gnId       = variantId
    , gnType     = "VARIANT"
    , gnName     = ident
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False  -- variants inherit enum visibility at query time
    , gnMetadata = Map.fromList
        [ ("kind", MetaText kind)
        ]
    }

  -- Emit CONTAINS edge from enum to variant
  emitEdge GraphEdge
    { geSource   = enumId
    , geTarget   = variantId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit HAS_FIELD edges for variant fields
  emitFieldEdges variantId fields

-- ── Field edge emission ────────────────────────────────────────────────

-- | Emit HAS_FIELD edges for a list of fields.
-- Source and target are both the parent (struct/variant) ID.
-- Field name and index are stored as metadata on the edge.
emitFieldEdges :: Text -> [RustField] -> Analyzer ()
emitFieldEdges parentId fields =
  mapM_ emitOne (zip [0..] fields)
  where
    emitOne :: (Int, RustField) -> Analyzer ()
    emitOne (idx, RustField mbName _ty _vis) = do
      let fieldName = case mbName of
            Just name -> name
            Nothing   -> ""  -- tuple fields have no name
      emitEdge GraphEdge
        { geSource   = parentId
        , geTarget   = parentId
        , geType     = "HAS_FIELD"
        , geMetadata = Map.fromList
            [ ("field_name",  MetaText fieldName)
            , ("field_index", MetaInt idx)
            ]
        }

-- ── Variant kind detection ─────────────────────────────────────────────

-- | Detect the kind of an enum variant based on its fields.
--
-- * No fields            -> "unit"
-- * All unnamed fields   -> "tuple"
-- * Any named field      -> "struct"
detectVariantKind :: [RustField] -> Text
detectVariantKind [] = "unit"
detectVariantKind fields
  | any hasName fields = "struct"
  | otherwise          = "tuple"
  where
    hasName :: RustField -> Bool
    hasName (RustField (Just _) _ _) = True
    hasName _                        = False

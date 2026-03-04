{-# LANGUAGE OverloadedStrings #-}
-- | Phase 15 rule: attributes and derive macros.
--
-- Tracks Rust attributes (@#[...]@) and derive macros on items:
--   * @#[derive(Debug, Clone)]@ -> DERIVES edge per trait (item -> item)
--   * @#[serde(rename = "foo")]@ -> ATTRIBUTE node + HAS_ATTRIBUTE edge
--   * @#[cfg(test)]@             -> ATTRIBUTE node (kind=cfg) + HAS_ATTRIBUTE
--   * @#[test]@                  -> ATTRIBUTE node (kind=test) + HAS_ATTRIBUTE
--
-- Node types: ATTRIBUTE
-- Edge types: HAS_ATTRIBUTE, DERIVES, CONTAINS
--
-- Called from 'Analysis.Walker.walkFile' for each top-level item.
module Rules.Attributes
  ( walkAttributes
  ) where

import Control.Monad (forM_, when)
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
    , askNamedParent
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Top-level item walker ──────────────────────────────────────────────

-- | Walk a single Rust item for its attributes.
--
-- For each attribute on the item:
--   * @derive@ -> DERIVES edge per trait (source = item node, target = item node)
--   * other    -> ATTRIBUTE node + HAS_ATTRIBUTE edge + CONTAINS edge
walkAttributes :: RustItem -> Analyzer ()
walkAttributes item = do
  let (attrs, mItemInfo) = extractItemInfo item
  case (attrs, mItemInfo) of
    ([], _) -> pure ()
    (_, Nothing) -> pure ()
    (as, Just (nodeType, name, sp)) -> do
      file <- askFile
      parent <- askNamedParent
      let itemId = semanticId file nodeType name parent Nothing
      mapM_ (walkAttr file itemId sp) as

-- ── Single attribute walker ────────────────────────────────────────────

-- | Walk a single attribute, emitting either DERIVES edges or
-- an ATTRIBUTE node with HAS_ATTRIBUTE edge.
walkAttr :: Text -> Text -> Span -> RustAttribute -> Analyzer ()
walkAttr file itemId sp attr = do
  scopeId <- askScopeId
  let attrPath = raPath attr
      attrTokens = raTokens attr
      line = posLine (spanStart sp)

  -- Special case: derive
  if attrPath == "derive"
    then do
      -- Parse derive traits from tokens: "Debug, Clone" -> ["Debug", "Clone"]
      let traits = map T.strip (T.splitOn "," attrTokens)
      forM_ traits $ \traitName -> when (not (T.null traitName)) $ do
        emitEdge GraphEdge
          { geSource = itemId
          , geTarget = itemId
          , geType = "DERIVES"
          , geMetadata = Map.fromList [("trait", MetaText traitName)]
          }
    else do
      -- Regular attribute: emit ATTRIBUTE node + HAS_ATTRIBUTE edge
      let kind = classifyAttr attrPath
          hash = contentHash [("path", attrPath), ("line", T.pack (show line))]
          attrId = semanticId file "ATTRIBUTE" attrPath Nothing (Just hash)
      emitNode GraphNode
        { gnId = attrId
        , gnType = "ATTRIBUTE"
        , gnName = attrPath
        , gnFile = file
        , gnLine = line
        , gnColumn = 0
        , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
        , gnMetadata = Map.fromList $
            [("kind", MetaText kind)] ++
            [("tokens", MetaText attrTokens) | not (T.null attrTokens)]
        }
      emitEdge GraphEdge
        { geSource = scopeId
        , geTarget = attrId
        , geType = "CONTAINS"
        , geMetadata = Map.empty
        }
      emitEdge GraphEdge
        { geSource = itemId
        , geTarget = attrId
        , geType = "HAS_ATTRIBUTE"
        , geMetadata = Map.empty
        }

-- ── Attribute classification ───────────────────────────────────────────

-- | Classify an attribute path into a kind for metadata.
classifyAttr :: Text -> Text
classifyAttr "cfg"        = "cfg"
classifyAttr "test"       = "test"
classifyAttr "derive"     = "derive"
classifyAttr "allow"      = "lint"
classifyAttr "warn"       = "lint"
classifyAttr "deny"       = "lint"
classifyAttr "forbid"     = "lint"
classifyAttr "inline"     = "optimization"
classifyAttr "must_use"   = "diagnostic"
classifyAttr "deprecated" = "diagnostic"
classifyAttr _            = "other"

-- ── Item info extraction ───────────────────────────────────────────────

-- | Extract attributes and item identity from a RustItem.
-- Returns the list of attributes and optionally the (nodeType, name, span)
-- tuple for the item. Returns Nothing for items that don't have a named
-- identity (e.g., impl blocks, macros).
extractItemInfo :: RustItem -> ([RustAttribute], Maybe (Text, Text, Span))
extractItemInfo (ItemFn ident _ _ _ attrs sp) =
  (attrs, Just ("FUNCTION", ident, sp))
extractItemInfo (ItemStruct ident _ _ attrs sp _ _) =
  (attrs, Just ("STRUCT", ident, sp))
extractItemInfo (ItemEnum ident _ _ attrs sp) =
  (attrs, Just ("ENUM", ident, sp))
extractItemInfo (ItemTrait ident _ _ attrs sp _) =
  (attrs, Just ("TRAIT", ident, sp))
extractItemInfo (ItemImpl _ _ _ _sp attrs _) =
  (attrs, Nothing)  -- impl blocks handled differently
extractItemInfo (ItemConst ident _ _ _ sp attrs) =
  (attrs, Just ("VARIABLE", ident, sp))
extractItemInfo (ItemStatic ident _ _ _ _ sp attrs) =
  (attrs, Just ("VARIABLE", ident, sp))
extractItemInfo (ItemType ident _ _ sp attrs) =
  (attrs, Just ("TYPE_ALIAS", ident, sp))
extractItemInfo (ItemMod ident _ _ sp attrs) =
  (attrs, Just ("MODULE", ident, sp))
extractItemInfo _ = ([], Nothing)

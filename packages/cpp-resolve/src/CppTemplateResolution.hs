{-# LANGUAGE OverloadedStrings #-}
-- | C/C++ template instantiation and specialization resolution.
--
-- Resolves template usage sites to their template definitions and links
-- template specializations to their primary templates.
--
-- == Edge Types Emitted
--
--   * INSTANTIATES_TEMPLATE: usage site -> template definition
--   * SPECIALIZES: specialization -> primary template
--
-- == Resolution Strategies
--
-- **Template instantiation:**
--   1. From deferred refs or CALL/VARIABLE nodes with @template_name@ metadata.
--   2. Look up the template name in the template index.
--   3. Emit INSTANTIATES_TEMPLATE edge: usage site -> template definition.
--
-- **Template specialization:**
--   1. From CLASS/FUNCTION nodes with @kind=partial_specialization@ or
--      @kind=full_specialization@ metadata.
--   2. Look up the primary template by name in the template index.
--   3. Emit SPECIALIZES edge: specialization -> primary template.
--
-- == Intentional Limitations
--
-- The following C++ features are NOT resolved:
--   * SFINAE / template metaprogramming (undecidable in general)
--   * Dependent names (can't resolve without instantiation context)
--   * Implicit conversions during template argument deduction
--   * Full overload resolution for function templates
--
-- Node types consumed: CLASS, FUNCTION, CALL, VARIABLE (with template metadata)
-- Edge types emitted: INSTANTIATES_TEMPLATE, SPECIALIZES
module CppTemplateResolution
  ( resolveAll
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))
import CppIndex (CppIndex(..), lookupMetaText, unqualifiedName)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

-- | Resolve all template instantiations and specializations.
--
-- Parameters:
--   * @nodes@ — all graph nodes
--   * @idx@ — pre-built 'CppIndex'
--
-- Returns a list of 'EmitEdge' commands.
resolveAll :: [GraphNode] -> CppIndex -> [PluginCommand]
resolveAll nodes idx =
     resolveInstantiations nodes idx
  ++ resolveSpecializations nodes idx

-- ── Template Instantiation ─────────────────────────────────────────────

-- | Resolve template instantiation sites.
--
-- Scans for nodes with @template_name@ metadata and links them to
-- their template definition in the template index.
resolveInstantiations :: [GraphNode] -> CppIndex -> [PluginCommand]
resolveInstantiations nodes idx =
  [ EmitEdge GraphEdge
      { geSource   = gnId n
      , geTarget   = templateNodeId
      , geType     = "INSTANTIATES_TEMPLATE"
      , geMetadata = addTemplateArgs n
      }
  | n <- nodes
  , Just templateName <- [lookupMetaText "template_name" n]
  , not (T.null templateName)
  , Just templateNodeId <- [lookupTemplate idx templateName]
  ]

-- | Look up a template in the index, trying qualified name first.
lookupTemplate :: CppIndex -> Text -> Maybe Text
lookupTemplate idx name =
  case Map.lookup name (templateIndex idx) of
    Just (nodeId:_) -> Just nodeId
    _ ->
      let uq = unqualifiedName name
      in if uq /= name
         then case Map.lookup uq (templateIndex idx) of
           Just (nodeId:_) -> Just nodeId
           _               -> Nothing
         else Nothing

-- | Add template_args metadata to the edge if available on the source node.
addTemplateArgs :: GraphNode -> Map.Map Text MetaValue
addTemplateArgs n =
  case lookupMetaText "template_args" n of
    Just args -> Map.singleton "template_args" (MetaText args)
    Nothing   -> Map.empty

-- ── Template Specialization ────────────────────────────────────────────

-- | Resolve template specializations to their primary templates.
--
-- Scans for CLASS and FUNCTION nodes with @kind=partial_specialization@
-- or @kind=full_specialization@ metadata.
resolveSpecializations :: [GraphNode] -> CppIndex -> [PluginCommand]
resolveSpecializations nodes idx =
  [ EmitEdge GraphEdge
      { geSource   = gnId n
      , geTarget   = primaryNodeId
      , geType     = "SPECIALIZES"
      , geMetadata = specMetadata n
      }
  | n <- nodes
  , isSpecialization n
  , Just primaryName <- [lookupMetaText "primary_template" n
                         `orElse` Just (gnName n)]
  , not (T.null primaryName)
  , Just primaryNodeId <- [lookupTemplate idx primaryName]
  -- Don't link to self
  , primaryNodeId /= gnId n
  ]

-- | Check if a node is a template specialization.
isSpecialization :: GraphNode -> Bool
isSpecialization n =
  let mKind = lookupMetaText "kind" n
  in (gnType n == "CLASS" || gnType n == "FUNCTION")
     && mKind `elem` [ Just "partial_specialization"
                      , Just "full_specialization"
                      , Just "explicit_specialization"
                      ]

-- | Build specialization metadata.
specMetadata :: GraphNode -> Map.Map Text MetaValue
specMetadata n =
  let base = case lookupMetaText "kind" n of
        Just k  -> Map.singleton "specialization_kind" (MetaText k)
        Nothing -> Map.empty
  in case lookupMetaText "template_args" n of
    Just args -> Map.insert "template_args" (MetaText args) base
    Nothing   -> base

-- | Simple @Maybe@ alternative operator.
orElse :: Maybe a -> Maybe a -> Maybe a
orElse (Just x) _ = Just x
orElse Nothing  y = y

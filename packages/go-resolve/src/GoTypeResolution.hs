{-# LANGUAGE OverloadedStrings #-}
-- | Go type resolution: links VARIABLE and FUNCTION nodes to their type definitions.
--
-- Emits:
--   * TYPE_OF edges: VARIABLE node -> CLASS\/INTERFACE node for the variable's type
--   * RETURNS edges: FUNCTION node -> CLASS\/INTERFACE node for each return type
--
-- Skips Go primitive types (int, string, bool, byte, rune, float32, float64, error, any).
-- Strips pointer prefix @*@ and slice prefix @[]@ before lookup.
module GoTypeResolution
  ( resolveAll
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set

-- | Type index: type name -> node ID (CLASS or INTERFACE).
type TypeIndex = Map Text Text

-- | Go primitive types that should be skipped during resolution.
primitives :: Set.Set Text
primitives = Set.fromList
  [ "int", "int8", "int16", "int32", "int64"
  , "uint", "uint8", "uint16", "uint32", "uint64", "uintptr"
  , "float32", "float64"
  , "complex64", "complex128"
  , "string", "bool", "byte", "rune", "error", "any"
  ]

-- | Look up a text metadata value from a node's metadata map.
lookupMetaText :: Text -> GraphNode -> Maybe Text
lookupMetaText key node = case Map.lookup key (gnMetadata node) of
  Just (MetaText t) -> Just t
  _                 -> Nothing

-- | Strip pointer and slice prefixes from a type name.
--
-- @stripTypePrefix \"*MyStruct\"@ -> @\"MyStruct\"@
-- @stripTypePrefix \"[]byte\"@ -> @\"byte\"@
-- @stripTypePrefix \"**T\"@ -> @\"T\"@
stripTypePrefix :: Text -> Text
stripTypePrefix t
  | "*" `T.isPrefixOf` t  = stripTypePrefix (T.drop 1 t)
  | "[]" `T.isPrefixOf` t = stripTypePrefix (T.drop 2 t)
  | otherwise              = t

-- | Check if a type name is a Go primitive.
isPrimitive :: Text -> Bool
isPrimitive = (`Set.member` primitives)

-- | Build the type index from all graph nodes.
--
-- Maps type names to node IDs for CLASS and INTERFACE nodes.
buildTypeIndex :: [GraphNode] -> TypeIndex
buildTypeIndex = foldl go Map.empty
  where
    go acc n
      | gnType n == "CLASS"     = Map.insert (gnName n) (gnId n) acc
      | gnType n == "INTERFACE" = Map.insert (gnName n) (gnId n) acc
      | otherwise               = acc

-- | Resolve type references for VARIABLE nodes.
--
-- For each VARIABLE with a @type@ metadata field, strips pointer\/slice
-- prefixes, skips primitives, and emits a TYPE_OF edge to the
-- corresponding type node.
resolveVariableTypes :: TypeIndex -> [GraphNode] -> [PluginCommand]
resolveVariableTypes typeIdx nodes =
  [ EmitEdge GraphEdge
      { geSource   = gnId varNode
      , geTarget   = typeNodeId
      , geType     = "TYPE_OF"
      , geMetadata = Map.empty
      }
  | varNode <- nodes
  , gnType varNode == "VARIABLE"
  , Just rawType <- [lookupMetaText "type" varNode]
  , let cleanType = stripTypePrefix rawType
  , not (T.null cleanType)
  , not (isPrimitive cleanType)
  , Just typeNodeId <- [Map.lookup cleanType typeIdx]
  ]

-- | Resolve return types for FUNCTION nodes.
--
-- For each FUNCTION with a @return_type@ metadata field, splits by comma,
-- strips pointer\/slice prefixes, skips primitives, and emits a RETURNS
-- edge to each matching type node.
resolveFunctionReturnTypes :: TypeIndex -> [GraphNode] -> [PluginCommand]
resolveFunctionReturnTypes typeIdx nodes =
  [ EmitEdge GraphEdge
      { geSource   = gnId funcNode
      , geTarget   = typeNodeId
      , geType     = "RETURNS"
      , geMetadata = Map.empty
      }
  | funcNode <- nodes
  , gnType funcNode == "FUNCTION"
  , Just rawRetType <- [lookupMetaText "return_type" funcNode]
  , retPart <- T.splitOn "," rawRetType
  , let cleanType = stripTypePrefix (T.strip retPart)
  , not (T.null cleanType)
  , not (isPrimitive cleanType)
  , Just typeNodeId <- [Map.lookup cleanType typeIdx]
  ]

-- | Resolve all type references across all nodes.
--
-- Returns 'EmitEdge' commands for:
--   * TYPE_OF: VARIABLE -> type definition node
--   * RETURNS: FUNCTION -> return type definition node
resolveAll :: [GraphNode] -> [PluginCommand]
resolveAll nodes =
  let typeIdx = buildTypeIndex nodes
  in resolveVariableTypes typeIdx nodes
     ++ resolveFunctionReturnTypes typeIdx nodes

{-# LANGUAGE OverloadedStrings #-}
-- | Python type resolution plugin.
--
-- Resolves type annotations from node metadata to produce typed edges:
--   - TYPE_OF edges: function/variable/parameter -> type class
--   - EXTENDS edges: class -> base class (from "bases" metadata)
--
-- Uses class index to find targets within the project.
-- Built-in types (str, int, etc.) and external types are silently skipped.
module TypeResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import System.IO (hPutStrLn, stderr)

-- | Class index: name -> (file path, node ID)
type ClassIndex = Map Text (Text, Text)

-- | Python built-in types that should not be resolved to class nodes.
builtinTypes :: Set.Set Text
builtinTypes = Set.fromList
  [ "str", "int", "float", "bool", "bytes", "complex"
  , "list", "dict", "set", "tuple", "frozenset"
  , "None", "type", "object", "property"
  ]

-- | Build class index from CLASS nodes.
buildClassIndex :: [GraphNode] -> ClassIndex
buildClassIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "CLASS" = Map.insert (gnName n) (gnFile n, gnId n) acc
      | otherwise = acc

-- | Get a text metadata value from a node.
getMetaText :: Text -> GraphNode -> Maybe Text
getMetaText key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaText t) | not (T.null t) -> Just t
    _                                  -> Nothing

-- | Strip generic wrapper to get base type name.
-- "Optional[Foo]" -> "Optional" (we resolve the inner type separately)
-- "List[str]" -> "List"
-- "dict[str, int]" -> "dict"
stripGeneric :: Text -> Text
stripGeneric t =
  case T.breakOn "[" t of
    (base, _) -> T.strip base

-- | Normalize a type name for lookup.
-- Returns Nothing for types that should be skipped (builtins, empty).
normalizeType :: Text -> Maybe Text
normalizeType raw =
  let trimmed = T.strip raw
      stripped = stripGeneric trimmed
  in if T.null stripped
       then Nothing
     else if Set.member stripped builtinTypes
       then Nothing
     else Just stripped

-- | Look up a type name in the class index, returning the target node ID if found.
lookupType :: ClassIndex -> Text -> Maybe Text
lookupType classIdx typeName =
  case normalizeType typeName of
    Nothing       -> Nothing
    Just normName -> snd <$> Map.lookup normName classIdx

-- | Split a comma-separated metadata value into individual type names.
splitTypes :: Text -> [Text]
splitTypes = filter (not . T.null) . map T.strip . T.splitOn ","

-- | Helper: create an EmitEdge command with empty metadata.
mkEdge :: Text -> Text -> Text -> PluginCommand
mkEdge src dst edgeType = EmitEdge GraphEdge
  { geSource   = src
  , geTarget   = dst
  , geType     = edgeType
  , geMetadata = Map.empty
  }

-- | Helper: create an EmitEdge command with metadata.
mkEdgeMeta :: Text -> Text -> Text -> Map Text MetaValue -> PluginCommand
mkEdgeMeta src dst edgeType meta = EmitEdge GraphEdge
  { geSource   = src
  , geTarget   = dst
  , geType     = edgeType
  , geMetadata = meta
  }

-- | Resolve TYPE_OF edges from return_annotation on FUNCTION nodes.
resolveReturnAnnotations :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveReturnAnnotations classIdx = concatMap go
  where
    go node
      | gnType node /= "FUNCTION" = []
      | otherwise =
          case getMetaText "return_annotation" node of
            Nothing -> []
            Just annotation ->
              case lookupType classIdx annotation of
                Nothing      -> []
                Just classId ->
                  [ mkEdgeMeta (gnId node) classId "TYPE_OF"
                      (Map.singleton "annotation" (MetaText annotation))
                  ]

-- | Resolve TYPE_OF edges from annotation on VARIABLE nodes.
resolveVariableAnnotations :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveVariableAnnotations classIdx = concatMap go
  where
    go node
      | gnType node /= "VARIABLE" = []
      | otherwise =
          case getMetaText "annotation" node of
            Nothing -> []
            Just annotation ->
              case lookupType classIdx annotation of
                Nothing      -> []
                Just classId ->
                  [ mkEdgeMeta (gnId node) classId "TYPE_OF"
                      (Map.singleton "annotation" (MetaText annotation))
                  ]

-- | Resolve TYPE_OF edges from annotation on PARAMETER nodes.
resolveParameterAnnotations :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveParameterAnnotations classIdx = concatMap go
  where
    go node
      | gnType node /= "PARAMETER" = []
      | otherwise =
          case getMetaText "annotation" node of
            Nothing -> []
            Just annotation ->
              case lookupType classIdx annotation of
                Nothing      -> []
                Just classId ->
                  [ mkEdgeMeta (gnId node) classId "TYPE_OF"
                      (Map.singleton "annotation" (MetaText annotation))
                  ]

-- | Resolve EXTENDS edges from bases metadata on CLASS nodes.
-- Python classes can have multiple base classes (comma-separated).
resolveExtends :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveExtends classIdx = concatMap go
  where
    go node
      | gnType node /= "CLASS" = []
      | otherwise =
          case getMetaText "bases" node of
            Nothing -> []
            Just basesStr ->
              [ mkEdge (gnId node) baseId "EXTENDS"
              | typeName <- splitTypes basesStr
              , Just baseId <- [lookupType classIdx typeName]
              ]

-- | Core resolution logic.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let classIdx = buildClassIndex nodes

  let returnEdges  = resolveReturnAnnotations classIdx nodes
      varEdges     = resolveVariableAnnotations classIdx nodes
      paramEdges   = resolveParameterAnnotations classIdx nodes
      extendsEdges = resolveExtends classIdx nodes

      allEdges = returnEdges ++ varEdges ++ paramEdges ++ extendsEdges

  hPutStrLn stderr $
    "python-type-resolve: " ++ show (length allEdges) ++ " type edges"
    ++ " (TYPE_OF=" ++ show (length returnEdges + length varEdges + length paramEdges)
    ++ ", EXTENDS=" ++ show (length extendsEdges) ++ ")"

  return allEdges

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

{-# LANGUAGE OverloadedStrings #-}
-- | Java type resolution plugin.
--
-- Resolves type references from node metadata to produce typed edges:
--   - RETURNS edges: function -> return type class
--   - TYPE_OF edges: variable -> type class
--   - EXTENDS edges: class -> superclass
--   - IMPLEMENTS edges: class -> interface
--   - THROWS_TYPE edges: function -> exception class
--
-- Uses class index to find targets within the project.
-- External types (JDK, third-party) and primitives are silently skipped.
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

-- | Class index: simple class name -> (file path, node ID).
-- We index by simple name for intra-project resolution.
type ClassIndex = Map Text (Text, Text)

-- | Method index: (class name, method name) -> method node ID.
type MethodIndex = Map (Text, Text) Text

-- | Primitive types that should not be resolved to class nodes.
primitiveTypes :: Set.Set Text
primitiveTypes = Set.fromList
  [ "boolean", "byte", "char", "short", "int"
  , "long", "float", "double", "void", "var"
  ]

-- | Build class index from CLASS, INTERFACE, ENUM, RECORD nodes.
buildClassIndex :: [GraphNode] -> ClassIndex
buildClassIndex = foldl' go Map.empty
  where
    classTypes = Set.fromList ["CLASS", "INTERFACE", "ENUM", "RECORD"]

    go acc n
      | Set.member (gnType n) classTypes =
          -- Index by simple name (for same-project resolution)
          Map.insert (gnName n) (gnFile n, gnId n) acc
      | otherwise = acc

-- | Build method index: for each FUNCTION node, map (enclosingClass, methodName) -> nodeId.
-- We infer the enclosing class from the semantic ID format.
buildMethodIndex :: [GraphNode] -> MethodIndex
buildMethodIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION" =
          -- Extract class context from semantic ID
          -- Format: file->FUNCTION->name[in:ClassName,...]
          case extractParentClass (gnId n) of
            Just className -> Map.insert (className, gnName n) (gnId n) acc
            Nothing        -> acc
      | otherwise = acc

-- | Extract parent class name from a semantic ID.
-- "file->FUNCTION->name[in:ClassName]" -> Just "ClassName"
extractParentClass :: Text -> Maybe Text
extractParentClass sid =
  case T.breakOn "[in:" sid of
    (_, rest)
      | T.null rest -> Nothing
      | otherwise ->
          let afterPrefix = T.drop 4 rest
              (beforeClose, _) = T.breakOn "]" afterPrefix
              (cleanParent, _) = T.breakOn ",h:" beforeClose
          in if T.null cleanParent then Nothing else Just cleanParent

-- | Normalize a type name for lookup: strip array brackets, trim whitespace.
-- Returns Nothing for types that should be skipped (primitives, wildcards, unknown).
normalizeType :: Text -> Maybe Text
normalizeType raw =
  let trimmed = T.strip raw
      -- Strip array brackets: "String[]" -> "String", "int[][]" -> "int"
      stripped = T.replace "[]" "" trimmed
  in if T.null stripped
       then Nothing
     else if Set.member stripped primitiveTypes
       then Nothing
     else if T.isInfixOf "?" stripped   -- wildcards
       then Nothing
     else if stripped == "<unknown>"
       then Nothing
     else Just stripped

-- | Split a comma-separated metadata value into individual type names.
splitTypes :: Text -> [Text]
splitTypes = filter (not . T.null) . map T.strip . T.splitOn ","

-- | Look up a type name in the class index, returning the target node ID if found.
lookupType :: ClassIndex -> Text -> Maybe Text
lookupType classIdx typeName =
  case normalizeType typeName of
    Nothing       -> Nothing
    Just normName -> snd <$> Map.lookup normName classIdx

-- | Get a text metadata value from a node.
getMetaText :: Text -> GraphNode -> Maybe Text
getMetaText key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaText t) | not (T.null t) -> Just t
    _                                  -> Nothing

-- | Resolve RETURNS edges: FUNCTION nodes with return_type metadata.
resolveReturns :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveReturns classIdx = concatMap go
  where
    go node
      | gnType node /= "FUNCTION" = []
      | otherwise =
          case getMetaText "return_type" node of
            Nothing -> []
            Just retType ->
              case lookupType classIdx retType of
                Nothing      -> []
                Just classId -> [mkEdge (gnId node) classId "RETURNS"]

-- | Resolve TYPE_OF edges: VARIABLE nodes with type metadata.
resolveTypeOf :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveTypeOf classIdx = concatMap go
  where
    go node
      | gnType node /= "VARIABLE" = []
      | otherwise =
          case getMetaText "type" node of
            Nothing -> []
            Just typeName ->
              case lookupType classIdx typeName of
                Nothing      -> []
                Just classId -> [mkEdge (gnId node) classId "TYPE_OF"]

-- | Resolve EXTENDS edges: CLASS nodes with extends metadata.
resolveExtends :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveExtends classIdx = concatMap go
  where
    classTypes = Set.fromList ["CLASS", "INTERFACE", "ENUM", "RECORD"]

    go node
      | not (Set.member (gnType node) classTypes) = []
      | otherwise =
          case getMetaText "extends" node of
            Nothing -> []
            Just extendsName ->
              case lookupType classIdx extendsName of
                Nothing      -> []
                Just classId -> [mkEdge (gnId node) classId "EXTENDS"]

-- | Resolve IMPLEMENTS edges: CLASS nodes with implements metadata (comma-separated).
resolveImplements :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveImplements classIdx = concatMap go
  where
    go node
      | gnType node /= "CLASS" && gnType node /= "ENUM" = []
      | otherwise =
          case getMetaText "implements" node of
            Nothing -> []
            Just implStr ->
              [ mkEdge (gnId node) ifaceId "IMPLEMENTS"
              | typeName <- splitTypes implStr
              , Just ifaceId <- [lookupType classIdx typeName]
              ]

-- | Resolve THROWS_TYPE edges: FUNCTION nodes with throws metadata (comma-separated).
resolveThrows :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveThrows classIdx = concatMap go
  where
    go node
      | gnType node /= "FUNCTION" = []
      | otherwise =
          case getMetaText "throws" node of
            Nothing -> []
            Just throwsStr ->
              [ mkEdge (gnId node) excId "THROWS_TYPE"
              | typeName <- splitTypes throwsStr
              , Just excId <- [lookupType classIdx typeName]
              ]

-- | Helper: create an EmitEdge command with empty metadata.
mkEdge :: Text -> Text -> Text -> PluginCommand
mkEdge src dst edgeType = EmitEdge GraphEdge
  { geSource   = src
  , geTarget   = dst
  , geType     = edgeType
  , geMetadata = Map.empty
  }

-- | Core resolution logic.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let classIdx   = buildClassIndex nodes
      _methodIdx = buildMethodIndex nodes

  let returnsEdges    = resolveReturns classIdx nodes
      typeOfEdges     = resolveTypeOf classIdx nodes
      extendsEdges    = resolveExtends classIdx nodes
      implementsEdges = resolveImplements classIdx nodes
      throwsEdges     = resolveThrows classIdx nodes

      allEdges = returnsEdges ++ typeOfEdges ++ extendsEdges
              ++ implementsEdges ++ throwsEdges

  hPutStrLn stderr $
    "java-type-resolve: " ++ show (length allEdges) ++ " type edges"
    ++ " (RETURNS=" ++ show (length returnsEdges)
    ++ ", TYPE_OF=" ++ show (length typeOfEdges)
    ++ ", EXTENDS=" ++ show (length extendsEdges)
    ++ ", IMPLEMENTS=" ++ show (length implementsEdges)
    ++ ", THROWS_TYPE=" ++ show (length throwsEdges) ++ ")"

  return allEdges

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

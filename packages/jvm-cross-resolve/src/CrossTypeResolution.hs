{-# LANGUAGE OverloadedStrings #-}
-- | JVM cross-language type resolution plugin.
--
-- Resolves type references that cross the Java/Kotlin language boundary.
-- Only emits edges when the source node's file and the target type's file
-- are in different JVM languages.
--
-- Produces (cross-language only):
--   - RETURNS edges: function -> return type class
--   - TYPE_OF edges: variable -> type class
--   - EXTENDS edges: class -> superclass
--   - IMPLEMENTS edges: class -> interface
--   - THROWS_TYPE edges: function -> exception class
--
-- Same-language type edges are already handled by java-resolve and kotlin-resolve.
module CrossTypeResolution (run, resolveAll) where

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
type ClassIndex = Map Text (Text, Text)

-- | Check if a file path belongs to a Java source file.
isJavaFile :: Text -> Bool
isJavaFile f = T.isSuffixOf ".java" f

-- | Check if a file path belongs to a Kotlin source file.
isKotlinFile :: Text -> Bool
isKotlinFile f = T.isSuffixOf ".kt" f || T.isSuffixOf ".kts" f

-- | Check if two file paths belong to different JVM languages.
isCrossLanguage :: Text -> Text -> Bool
isCrossLanguage srcFile dstFile =
  (isJavaFile srcFile && isKotlinFile dstFile) ||
  (isKotlinFile srcFile && isJavaFile dstFile)

-- | Primitive/builtin types that should not be resolved to class nodes.
-- Combined set from both Java and Kotlin resolvers.
builtinTypes :: Set.Set Text
builtinTypes = Set.fromList
  [ "boolean", "byte", "char", "short", "int"
  , "long", "float", "double", "void", "var"
  , "Int", "Long", "Short", "Byte", "Float", "Double"
  , "Boolean", "Char", "String", "Unit", "Nothing", "Any"
  , "Array", "List", "Map", "Set"
  , "MutableList", "MutableMap", "MutableSet"
  , "Pair", "Triple"
  ]

-- | Build unified class index from CLASS, INTERFACE, ENUM, RECORD, OBJECT nodes.
buildClassIndex :: [GraphNode] -> ClassIndex
buildClassIndex = foldl' go Map.empty
  where
    classTypes = Set.fromList ["CLASS", "INTERFACE", "ENUM", "RECORD", "OBJECT"]

    go acc n
      | Set.member (gnType n) classTypes =
          Map.insert (gnName n) (gnFile n, gnId n) acc
      | otherwise = acc

-- | Normalize a type name for lookup: strip array brackets, trim whitespace,
-- strip nullable marker (?).
-- Returns Nothing for types that should be skipped (builtins, wildcards, unknown).
normalizeType :: Text -> Maybe Text
normalizeType raw =
  let trimmed = T.strip raw
      stripped = T.replace "[]" "" trimmed
      withoutNullable = T.dropWhileEnd (== '?') stripped
  in if T.null withoutNullable
       then Nothing
     else if Set.member withoutNullable builtinTypes
       then Nothing
     else if T.isInfixOf "?" withoutNullable
       then Nothing
     else if withoutNullable == "<unknown>"
       then Nothing
     else Just withoutNullable

-- | Split a comma-separated metadata value into individual type names.
splitTypes :: Text -> [Text]
splitTypes = filter (not . T.null) . map T.strip . T.splitOn ","

-- | Look up a type name in the class index, returning (file, nodeId) if found.
lookupType :: ClassIndex -> Text -> Maybe (Text, Text)
lookupType classIdx typeName =
  case normalizeType typeName of
    Nothing       -> Nothing
    Just normName -> Map.lookup normName classIdx

-- | Get a text metadata value from a node.
getMetaText :: Text -> GraphNode -> Maybe Text
getMetaText key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaText t) | not (T.null t) -> Just t
    _                                  -> Nothing

-- | Helper: create an EmitEdge command with cross_language metadata.
mkCrossEdge :: Text -> Text -> Text -> PluginCommand
mkCrossEdge src dst edgeType = EmitEdge GraphEdge
  { geSource   = src
  , geTarget   = dst
  , geType     = edgeType
  , geMetadata = Map.singleton "cross_language" (MetaBool True)
  }

-- | Resolve RETURNS edges: FUNCTION nodes with return_type metadata (cross-language only).
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
                Nothing             -> []
                Just (targetFile, classId)
                  | isCrossLanguage (gnFile node) targetFile ->
                      [mkCrossEdge (gnId node) classId "RETURNS"]
                  | otherwise -> []

-- | Resolve TYPE_OF edges: VARIABLE nodes with type metadata (cross-language only).
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
                Nothing             -> []
                Just (targetFile, classId)
                  | isCrossLanguage (gnFile node) targetFile ->
                      [mkCrossEdge (gnId node) classId "TYPE_OF"]
                  | otherwise -> []

-- | Resolve EXTENDS edges: CLASS/INTERFACE/ENUM/RECORD/OBJECT nodes with extends metadata (cross-language only).
resolveExtends :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveExtends classIdx = concatMap go
  where
    classTypes = Set.fromList ["CLASS", "INTERFACE", "ENUM", "RECORD", "OBJECT"]

    go node
      | not (Set.member (gnType node) classTypes) = []
      | otherwise =
          case getMetaText "extends" node of
            Nothing -> []
            Just extendsName ->
              case lookupType classIdx extendsName of
                Nothing             -> []
                Just (targetFile, classId)
                  | isCrossLanguage (gnFile node) targetFile ->
                      [mkCrossEdge (gnId node) classId "EXTENDS"]
                  | otherwise -> []

-- | Resolve IMPLEMENTS edges: CLASS/ENUM nodes with implements metadata (cross-language only).
resolveImplements :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveImplements classIdx = concatMap go
  where
    go node
      | gnType node /= "CLASS" && gnType node /= "ENUM" = []
      | otherwise =
          case getMetaText "implements" node of
            Nothing -> []
            Just implStr ->
              [ mkCrossEdge (gnId node) ifaceId "IMPLEMENTS"
              | typeName <- splitTypes implStr
              , Just (targetFile, ifaceId) <- [lookupType classIdx typeName]
              , isCrossLanguage (gnFile node) targetFile
              ]

-- | Resolve THROWS_TYPE edges: FUNCTION nodes with throws metadata (cross-language only).
resolveThrows :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveThrows classIdx = concatMap go
  where
    go node
      | gnType node /= "FUNCTION" = []
      | otherwise =
          case getMetaText "throws" node of
            Nothing -> []
            Just throwsStr ->
              [ mkCrossEdge (gnId node) excId "THROWS_TYPE"
              | typeName <- splitTypes throwsStr
              , Just (targetFile, excId) <- [lookupType classIdx typeName]
              , isCrossLanguage (gnFile node) targetFile
              ]

-- | Core resolution logic.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let classIdx = buildClassIndex nodes

  let returnsEdges    = resolveReturns classIdx nodes
      typeOfEdges     = resolveTypeOf classIdx nodes
      extendsEdges    = resolveExtends classIdx nodes
      implementsEdges = resolveImplements classIdx nodes
      throwsEdges     = resolveThrows classIdx nodes

      allEdges = returnsEdges ++ typeOfEdges ++ extendsEdges
              ++ implementsEdges ++ throwsEdges

  hPutStrLn stderr $
    "jvm-cross-types: " ++ show (length allEdges) ++ " type edges"
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

{-# LANGUAGE OverloadedStrings #-}
-- | Swift type resolution plugin.
--
-- Resolves type references from node metadata to produce typed edges:
--   - RETURNS edges: function -> return type class
--   - TYPE_OF edges: variable -> type class
--   - EXTENDS edges: class -> superclass (or extension -> extended type)
--   - IMPLEMENTS edges: class/extension -> protocol
--
-- Uses class index to find targets within the project.
-- External types (stdlib, third-party), primitives, and Swift built-in
-- types are silently skipped.
module SwiftTypeResolution
  ( resolveAll
  , run
  ) where

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

-- | Swift built-in types that should not be resolved to class nodes.
builtinTypes :: Set.Set Text
builtinTypes = Set.fromList
  [ "Int", "Int8", "Int16", "Int32", "Int64"
  , "UInt", "UInt8", "UInt16", "UInt32", "UInt64"
  , "Float", "Double", "Float16", "Float80"
  , "Bool", "String", "Character"
  , "Void", "Never", "Any", "AnyObject", "AnyClass"
  , "Array", "Dictionary", "Set", "Optional"
  , "Result", "Error"
  , "Codable", "Encodable", "Decodable"
  , "Hashable", "Equatable", "Comparable", "Identifiable"
  , "CustomStringConvertible", "CustomDebugStringConvertible"
  , "Sequence", "Collection", "IteratorProtocol"
  , "RawRepresentable", "CaseIterable"
  , "Sendable", "Actor"
  , "ObservableObject", "View", "App", "Scene"
  ]

-- | Build class index from CLASS and TYPE_ALIAS nodes in Swift files.
buildClassIndex :: [GraphNode] -> ClassIndex
buildClassIndex = foldl' go Map.empty
  where
    go acc n
      | (gnType n == "CLASS" || gnType n == "TYPE_ALIAS") && hasSwiftLang n =
          Map.insert (gnName n) (gnFile n, gnId n) acc
      | otherwise = acc

-- | Normalize a type name for lookup: strip optionals, trim whitespace.
-- Returns Nothing for types that should be skipped (builtins, empty).
normalizeType :: Text -> Maybe Text
normalizeType raw =
  let trimmed = T.strip raw
      -- Strip optional markers: "String?" -> "String"
      withoutOptional = T.dropWhileEnd (== '?') trimmed
      -- Strip array brackets: "[String]" is already handled by typeToName
  in if T.null withoutOptional
       then Nothing
     else if Set.member withoutOptional builtinTypes
       then Nothing
     else if withoutOptional == "<type>" || withoutOptional == ""
       then Nothing
     else Just withoutOptional

-- | Split a comma-separated metadata value into individual type names.
splitTypes :: Text -> [Text]
splitTypes = filter (not . T.null) . map T.strip . T.splitOn ","

-- | Look up a type name in the class index, returning the target node ID.
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
      | gnType node /= "FUNCTION" || not (hasSwiftLang node) = []
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
      | gnType node /= "VARIABLE" || not (hasSwiftLang node) = []
      | otherwise =
          case getMetaText "type" node of
            Nothing -> []
            Just typeName ->
              case lookupType classIdx typeName of
                Nothing      -> []
                Just classId -> [mkEdge (gnId node) classId "TYPE_OF"]

-- | Resolve EXTENDS edges: CLASS nodes with extends metadata,
-- and EXTENSION nodes -> extended type.
resolveExtends :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveExtends classIdx = concatMap go
  where
    go node
      | not (hasSwiftLang node) = []
      -- EXTENSION -> extended type (existing logic, improved)
      | gnType node == "EXTENSION" =
          let extTypeName = case getMetaText "extendedType" node of
                Just name -> name
                Nothing   -> gnName node
          in case lookupType classIdx extTypeName of
               Nothing      -> []
               Just classId -> [mkEdge (gnId node) classId "EXTENDS"]
      -- CLASS with extends metadata (superclass)
      | gnType node == "CLASS" =
          case getMetaText "extends" node of
            Nothing -> []
            Just extendsName ->
              case lookupType classIdx extendsName of
                Nothing      -> []
                Just classId -> [mkEdge (gnId node) classId "EXTENDS"]
      | otherwise = []

-- | Resolve IMPLEMENTS edges: CLASS/EXTENSION nodes with implements metadata.
resolveImplements :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveImplements classIdx = concatMap go
  where
    go node
      | not (hasSwiftLang node) = []
      | gnType node /= "CLASS" && gnType node /= "EXTENSION" = []
      | otherwise =
          case getMetaText "implements" node of
            Nothing -> []
            Just implStr ->
              [ mkEdge (gnId node) ifaceId "IMPLEMENTS"
              | typeName <- splitTypes implStr
              , Just ifaceId <- [lookupType classIdx typeName]
              ]

-- | Helper: create an EmitEdge command with resolver metadata.
mkEdge :: Text -> Text -> Text -> PluginCommand
mkEdge src dst edgeType = EmitEdge GraphEdge
  { geSource   = src
  , geTarget   = dst
  , geType     = edgeType
  , geMetadata = Map.singleton "resolvedVia" (MetaText "swift-type-resolution")
  }

hasSwiftLang :: GraphNode -> Bool
hasSwiftLang n = case Map.lookup "language" (gnMetadata n) of
  Just (MetaText "swift") -> True
  _ -> False

-- | Core resolution logic.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let classIdx = buildClassIndex nodes

  let returnsEdges    = resolveReturns classIdx nodes
      typeOfEdges     = resolveTypeOf classIdx nodes
      extendsEdges    = resolveExtends classIdx nodes
      implementsEdges = resolveImplements classIdx nodes

      allEdges = returnsEdges ++ typeOfEdges ++ extendsEdges ++ implementsEdges

  hPutStrLn stderr $
    "swift-type-resolve: " ++ show (length allEdges) ++ " type edges"
    ++ " (RETURNS=" ++ show (length returnsEdges)
    ++ ", TYPE_OF=" ++ show (length typeOfEdges)
    ++ ", EXTENDS=" ++ show (length extendsEdges)
    ++ ", IMPLEMENTS=" ++ show (length implementsEdges) ++ ")"

  return allEdges

-- | CLI entry point: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

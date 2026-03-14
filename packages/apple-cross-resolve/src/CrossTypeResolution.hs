{-# LANGUAGE OverloadedStrings #-}
-- | Apple cross-language type resolution plugin.
--
-- Resolves type bridging between Swift and Obj-C:
--   - BRIDGES_TO edges: Swift class with same name as Obj-C class (bridging pair)
--   - EXTENDS edges: Swift class extending NSObject subclass in Obj-C
--   - IMPLEMENTS edges: @objc protocol conformance across languages
--   - RETURNS edges: function returning a type from the other language
--   - TYPE_OF edges: variable typed with a type from the other language
--
-- Same-language type edges are already handled by swift-resolve and objc-resolve.
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

-- | Class index: class name -> (file path, node ID).
type ClassIndex = Map Text (Text, Text)

-- | Check if a file path belongs to a Swift source file.
isSwiftFile :: Text -> Bool
isSwiftFile f = T.isSuffixOf ".swift" f

-- | Check if a file path belongs to an Obj-C source file.
isObjCFile :: Text -> Bool
isObjCFile f = T.isSuffixOf ".m" f || T.isSuffixOf ".mm" f || T.isSuffixOf ".h" f

-- | Check if two file paths belong to different Apple languages.
isCrossLanguage :: Text -> Text -> Bool
isCrossLanguage srcFile dstFile =
  (isSwiftFile srcFile && isObjCFile dstFile) ||
  (isObjCFile srcFile && isSwiftFile dstFile)

-- | Get language from node metadata.
getLanguage :: GraphNode -> Maybe Text
getLanguage n = case Map.lookup "language" (gnMetadata n) of
  Just (MetaText t) -> Just t
  _                 -> Nothing

-- | Check if node is Swift.
isSwift :: GraphNode -> Bool
isSwift n = getLanguage n == Just "swift"

-- | Check if node is Obj-C.
isObjC :: GraphNode -> Bool
isObjC n = getLanguage n == Just "objc"

-- | Apple builtin types that should not be resolved.
builtinTypes :: Set.Set Text
builtinTypes = Set.fromList
  [ "NSObject", "NSString", "NSArray", "NSDictionary", "NSSet"
  , "NSNumber", "NSData", "NSDate", "NSURL", "NSError"
  , "NSInteger", "NSUInteger", "CGFloat", "CGRect", "CGPoint", "CGSize"
  , "Bool", "Int", "Float", "Double", "String", "Any", "AnyObject"
  , "Void", "Never"
  , "id", "void", "BOOL", "int", "float", "double", "long", "short"
  , "char", "unsigned"
  ]

-- | Build unified class index from CLASS, INTERFACE, EXTENSION nodes.
buildClassIndex :: [GraphNode] -> ClassIndex
buildClassIndex = foldl' go Map.empty
  where
    classTypes = Set.fromList ["CLASS", "INTERFACE", "EXTENSION"]

    go acc n
      | Set.member (gnType n) classTypes =
          Map.insert (gnName n) (gnFile n, gnId n) acc
      | otherwise = acc

-- | Get a text metadata value from a node.
getMetaText :: Text -> GraphNode -> Maybe Text
getMetaText key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaText t) | not (T.null t) -> Just t
    _                                  -> Nothing

-- | Helper: create an EmitEdge command with resolvedVia metadata.
mkCrossEdge :: Text -> Text -> Text -> PluginCommand
mkCrossEdge src dst edgeType = EmitEdge GraphEdge
  { geSource   = src
  , geTarget   = dst
  , geType     = edgeType
  , geMetadata = Map.singleton "resolvedVia" (MetaText "apple-cross-type")
  }

-- | Resolve BRIDGES_TO edges: Swift classes bridging to Obj-C classes with same name.
resolveBridging :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveBridging objcIndex = concatMap go
  where
    go node
      | gnType node /= "CLASS" = []
      | not (isSwift node) = []
      | otherwise =
          case Map.lookup (gnName node) objcIndex of
            Just (_, objcId)
              | objcId /= gnId node ->
                  [mkCrossEdge (gnId node) objcId "BRIDGES_TO"]
            _ -> []

-- | Resolve cross-language EXTENDS edges.
resolveExtends :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveExtends classIdx = concatMap go
  where
    classTypes = Set.fromList ["CLASS", "INTERFACE"]

    go node
      | not (Set.member (gnType node) classTypes) = []
      | otherwise =
          case getMetaText "extends" node of
            Nothing -> []
            Just extendsName
              | Set.member extendsName builtinTypes -> []
              | otherwise ->
                  case Map.lookup extendsName classIdx of
                    Nothing -> []
                    Just (targetFile, classId)
                      | isCrossLanguage (gnFile node) targetFile ->
                          [mkCrossEdge (gnId node) classId "EXTENDS"]
                      | otherwise -> []

-- | Resolve cross-language IMPLEMENTS edges.
resolveImplements :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveImplements classIdx = concatMap go
  where
    go node
      | gnType node /= "CLASS" = []
      | otherwise =
          case getMetaText "implements" node of
            Nothing -> []
            Just implStr ->
              [ mkCrossEdge (gnId node) ifaceId "IMPLEMENTS"
              | typeName <- splitTypes implStr
              , not (Set.member typeName builtinTypes)
              , Just (targetFile, ifaceId) <- [Map.lookup typeName classIdx]
              , isCrossLanguage (gnFile node) targetFile
              ]

-- | Resolve cross-language RETURNS edges.
resolveReturns :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveReturns classIdx = concatMap go
  where
    go node
      | gnType node /= "FUNCTION" = []
      | otherwise =
          case getMetaText "return_type" node of
            Nothing -> []
            Just retType
              | Set.member retType builtinTypes -> []
              | otherwise ->
                  case Map.lookup retType classIdx of
                    Nothing -> []
                    Just (targetFile, classId)
                      | isCrossLanguage (gnFile node) targetFile ->
                          [mkCrossEdge (gnId node) classId "RETURNS"]
                      | otherwise -> []

-- | Resolve cross-language TYPE_OF edges.
resolveTypeOf :: ClassIndex -> [GraphNode] -> [PluginCommand]
resolveTypeOf classIdx = concatMap go
  where
    go node
      | gnType node /= "VARIABLE" = []
      | otherwise =
          case getMetaText "type" node of
            Nothing -> []
            Just typeName
              | Set.member typeName builtinTypes -> []
              | otherwise ->
                  case Map.lookup typeName classIdx of
                    Nothing -> []
                    Just (targetFile, classId)
                      | isCrossLanguage (gnFile node) targetFile ->
                          [mkCrossEdge (gnId node) classId "TYPE_OF"]
                      | otherwise -> []

-- | Split a comma-separated metadata value into individual type names.
splitTypes :: Text -> [Text]
splitTypes = filter (not . T.null) . map T.strip . T.splitOn ","

-- | Core resolution logic.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let classIdx = buildClassIndex nodes
      objcClasses = Map.fromList
        [ (gnName n, (gnFile n, gnId n))
        | n <- nodes, gnType n == "CLASS", isObjC n
        ]

  let bridgingEdges   = resolveBridging objcClasses nodes
      extendsEdges    = resolveExtends classIdx nodes
      implementsEdges = resolveImplements classIdx nodes
      returnsEdges    = resolveReturns classIdx nodes
      typeOfEdges     = resolveTypeOf classIdx nodes

      allEdges = bridgingEdges ++ extendsEdges ++ implementsEdges
              ++ returnsEdges ++ typeOfEdges

  hPutStrLn stderr $
    "apple-cross-types: " ++ show (length allEdges) ++ " type edges"
    ++ " (BRIDGES_TO=" ++ show (length bridgingEdges)
    ++ ", EXTENDS=" ++ show (length extendsEdges)
    ++ ", IMPLEMENTS=" ++ show (length implementsEdges)
    ++ ", RETURNS=" ++ show (length returnsEdges)
    ++ ", TYPE_OF=" ++ show (length typeOfEdges) ++ ")"

  return allEdges

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

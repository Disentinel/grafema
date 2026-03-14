{-# LANGUAGE OverloadedStrings #-}
-- | Apple cross-language call resolution plugin.
--
-- Resolves CALL nodes to their target FUNCTION nodes across the
-- Swift/Obj-C language boundary, producing (cross-language only):
--   - CALLS edges: call site -> target function
--
-- Swift -> Obj-C: Swift code calling @objc-exposed Obj-C methods.
-- Obj-C -> Swift: Obj-C code calling Swift methods via generated -Swift.h header.
--
-- Same-language call edges are already handled by swift-resolve and objc-resolve.
--
-- == Resolution Strategies
--
-- 1. Message send resolution: Obj-C [receiver selector] matched to Swift method.
-- 2. Method call resolution: Swift dot-call matched to Obj-C method by name.
-- 3. Class method / static method resolution: receiver matches a class in the other language.
module CrossCallResolution (run, resolveAll) where

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

-- | Method index: (class name, method name) -> [(file path, function node ID)].
type MethodIndex = Map (Text, Text) [(Text, Text)]

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

-- | Build unified class index from CLASS, INTERFACE, EXTENSION nodes.
buildClassIndex :: [GraphNode] -> ClassIndex
buildClassIndex = foldl' go Map.empty
  where
    classTypes = Set.fromList ["CLASS", "INTERFACE", "EXTENSION"]

    go acc n
      | Set.member (gnType n) classTypes =
          Map.insert (gnName n) (gnFile n, gnId n) acc
      | otherwise = acc

-- | Build method index: (enclosingClass, methodName) -> [(file, nodeId)].
buildMethodIndex :: [GraphNode] -> MethodIndex
buildMethodIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION" =
          case extractParentClass (gnId n) of
            Just className ->
              let key = (className, gnName n)
              in Map.insertWith (++) key [(gnFile n, gnId n)] acc
            Nothing -> acc
      | otherwise = acc

-- | Extract parent class name from a semantic ID.
-- "file->FUNCTION->method[in:ClassName]" -> Just "ClassName"
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

-- | Get a text metadata value from a node.
getMetaText :: Text -> GraphNode -> Maybe Text
getMetaText key node =
  case Map.lookup key (gnMetadata node) of
    Just (MetaText t) | not (T.null t) -> Just t
    _                                  -> Nothing

-- | Helper: create an EmitEdge command with cross-language metadata.
mkCrossEdge :: Text -> Text -> Text -> Text -> PluginCommand
mkCrossEdge src dst edgeType direction = EmitEdge GraphEdge
  { geSource   = src
  , geTarget   = dst
  , geType     = edgeType
  , geMetadata = Map.fromList
      [("crossLanguage", MetaText direction), ("resolvedVia", MetaText "apple-cross-call")]
  }

-- | Resolve static-style calls where the receiver matches a class name
-- in a different language.
resolveReceiverCalls :: ClassIndex -> MethodIndex -> [GraphNode] -> [PluginCommand]
resolveReceiverCalls classIdx methodIdx = concatMap go
  where
    go node
      | gnType node /= "CALL" = []
      | otherwise =
          case getMetaText "receiver" node of
            Nothing -> []
            Just "" -> []
            Just "self" -> []
            Just "super" -> []
            Just receiver
              | Map.member receiver classIdx ->
                  case Map.lookup (receiver, gnName node) methodIdx of
                    Nothing -> []
                    Just methods ->
                      let direction = if isSwiftFile (gnFile node)
                                      then "swift-to-objc"
                                      else "objc-to-swift"
                      in case filter (\(f, _) -> isCrossLanguage (gnFile node) f) methods of
                        ((_, m):_) -> [mkCrossEdge (gnId node) m "CALLS" direction]
                        [] -> []
              | otherwise -> []

-- | Resolve Obj-C message sends to Swift methods or vice versa.
-- Matches by selector name against method names in the other language.
resolveMessageSends :: MethodIndex -> [GraphNode] -> [PluginCommand]
resolveMessageSends methodIdx = concatMap go
  where
    go node
      | gnType node /= "CALL" = []
      | getMetaText "kind" node /= Just "objc_message" = []
      | otherwise =
          let sel = gnName node
              -- Find all methods with matching name across languages
              crossMatches =
                [ (file, fnId)
                | ((_, methodName), entries) <- Map.toList methodIdx
                , methodName == sel
                , (file, fnId) <- entries
                , isCrossLanguage (gnFile node) file
                ]
              direction = if isSwiftFile (gnFile node)
                          then "swift-to-objc"
                          else "objc-to-swift"
          in case crossMatches of
            ((_, fnId):_) -> [mkCrossEdge (gnId node) fnId "CALLS" direction]
            [] -> []

-- | Core resolution logic.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let classIdx  = buildClassIndex nodes
      methodIdx = buildMethodIndex nodes

  let receiverEdges = resolveReceiverCalls classIdx methodIdx nodes
      messageEdges  = resolveMessageSends methodIdx nodes

      allEdges = receiverEdges ++ messageEdges

  hPutStrLn stderr $
    "apple-cross-calls: " ++ show (length allEdges) ++ " call edges"
    ++ " (receiver=" ++ show (length receiverEdges)
    ++ ", message=" ++ show (length messageEdges) ++ ")"

  return allEdges

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

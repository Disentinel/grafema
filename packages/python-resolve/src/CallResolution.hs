{-# LANGUAGE OverloadedStrings #-}
-- | Python call resolution plugin.
--
-- Resolves CALL nodes to their target FUNCTION nodes, producing CALLS edges.
--
-- == Resolution Strategies
--
-- 1. Same-file function calls (no receiver):
--    find FUNCTION with matching name in same file.
-- 2. Method calls (with receiver):
--    find FUNCTION with matching name and kind=method/classmethod/staticmethod
--    in the method index. Without type inference, matches imprecisely across classes.
-- 3. Cross-file function calls:
--    if not found in same file, search all files for a function with matching name.
module CallResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import System.IO (hPutStrLn, stderr)

-- | Function index: (file, name) -> [node IDs]
type FunctionIndex = Map (Text, Text) [Text]

-- | Method index: (class_name, method_name) -> [node IDs]
type MethodIndex = Map (Text, Text) [Text]

-- | Build function index from FUNCTION nodes.
buildFunctionIndex :: [GraphNode] -> FunctionIndex
buildFunctionIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION" =
          let key = (gnFile n, gnName n)
          in Map.insertWith (++) key [gnId n] acc
      | otherwise = acc

-- | Build method index: (enclosingClass, methodName) -> [nodeId].
-- Methods are FUNCTION nodes with kind=method/classmethod/staticmethod.
buildMethodIndex :: [GraphNode] -> MethodIndex
buildMethodIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "FUNCTION"
      , Just kind <- getMetaText "kind" n
      , kind `elem` ["method", "classmethod", "staticmethod"] =
          -- Extract class name from semantic ID: file->FUNCTION->name[in:ClassName]
          case extractClassName (gnId n) of
            Just cls -> Map.insertWith (++) (cls, gnName n) [gnId n] acc
            Nothing  -> acc
      | otherwise = acc

-- | Extract class name from a semantic ID.
-- "file->FUNCTION->name[in:ClassName,h:xxx]" -> Just "ClassName"
extractClassName :: Text -> Maybe Text
extractClassName nodeId =
  case T.breakOn "[in:" nodeId of
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
  let funcIdx   = buildFunctionIndex nodes
      methodIdx = buildMethodIndex nodes
      callNodes = filter (\n -> gnType n == "CALL") nodes

  let allEdges = concatMap (resolveCall funcIdx methodIdx) callNodes

  hPutStrLn stderr $
    "python-call-resolve: " ++ show (length allEdges) ++ " call edges"

  return allEdges

resolveCall :: FunctionIndex -> MethodIndex -> GraphNode -> [PluginCommand]
resolveCall funcIdx methodIdx callNode =
  let callName = gnName callNode
      callFile = gnFile callNode
      mReceiver = getMetaText "receiver" callNode
  in case mReceiver of
       Just _receiver ->
         -- Method call: look up in method index
         -- Try all classes (imprecise without type info)
         let matches = [ mid | ((_, mname), mids) <- Map.toList methodIdx
                              , mname == callName
                              , mid <- mids ]
         in case matches of
              (target:_) -> [mkEdge (gnId callNode) target "CALLS"]
              [] -> []
       Nothing ->
         -- Function call: look up in same file first, then cross-file
         case Map.lookup (callFile, callName) funcIdx of
           Just (target:_) -> [mkEdge (gnId callNode) target "CALLS"]
           _ ->
             -- Cross-file: find any function with this name
             let matches = [ mid | ((_, fname), mids) <- Map.toList funcIdx
                                 , fname == callName
                                 , mid <- mids ]
             in case matches of
                  (target:_) -> [mkEdge (gnId callNode) target "CALLS"]
                  [] -> []

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

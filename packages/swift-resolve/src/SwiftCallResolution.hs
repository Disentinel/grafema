{-# LANGUAGE OverloadedStrings #-}
-- | Swift cross-file call resolution plugin.
--
-- Resolves CALL nodes to their target FUNCTION nodes across Swift files,
-- producing CALLS edges.
--
-- == Resolution Strategies
--
-- 1. Method calls: receiver.method pattern — look up method in the class
--    that matches the receiver name.
-- 2. Direct function calls: match CALL name to FUNCTION name in other files.
-- 3. Same-file calls are skipped (handled by same-file resolution).
module SwiftCallResolution
  ( resolveAll
  , run
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import Data.List (foldl')
import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)
import System.IO (hPutStrLn, stderr)

-- | Resolve cross-file function calls in Swift code.
--
-- For each CALL node, try to find the target FUNCTION node by name.
-- Handles:
-- - Direct function calls (name matches FUNCTION node name)
-- - Method calls (receiver.method pattern — find method in class)
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let -- Build function index: name -> [(nodeId, file)]
      funcIndex :: Map Text [(Text, Text)]
      funcIndex = foldl' (\acc n ->
        if gnType n == "FUNCTION" && hasSwiftLang n
          then Map.insertWith (++) (gnName n) [(gnId n, gnFile n)] acc
          else acc
        ) Map.empty nodes

      -- Build method index: className.methodName -> nodeId
      methodIndex :: Map Text Text
      methodIndex = foldl' (\acc n ->
        if gnType n == "FUNCTION" && hasSwiftLang n
          then case Map.lookup "kind" (gnMetadata n) of
            Just (MetaText "method") ->
              let className = extractClassName (gnId n)
              in if T.null className
                then acc
                else Map.insert (className <> "." <> gnName n) (gnId n) acc
            _ -> acc
          else acc
        ) Map.empty nodes

      -- Find all CALL nodes in Swift files
      callNodes = [ n | n <- nodes, gnType n == "CALL", hasSwiftLang n ]

      -- Resolve each call
      edges = concatMap (resolveCall funcIndex methodIndex) callNodes

  hPutStrLn stderr $
    "swift-calls: " ++ show (length edges) ++ " call edges"

  return edges

resolveCall :: Map Text [(Text, Text)] -> Map Text Text -> GraphNode -> [PluginCommand]
resolveCall funcIndex methodIndex callNode =
  let callName = gnName callNode
      callFile = gnFile callNode
  in
    -- Try method resolution first (for receiver.method patterns)
    case Map.lookup callName methodIndex of
      Just targetId ->
        [ EmitEdge GraphEdge
            { geSource = gnId callNode
            , geTarget = targetId
            , geType = "CALLS"
            , geMetadata = Map.singleton "resolvedVia" (MetaText "swift-call-resolution")
            }
        ]
      Nothing ->
        -- Try direct function name resolution (cross-file)
        case Map.lookup callName funcIndex of
          Just targets ->
            -- Prefer cross-file match
            let crossFile = [ tid | (tid, tf) <- targets, tf /= callFile ]
            in case crossFile of
              (targetId:_) ->
                [ EmitEdge GraphEdge
                    { geSource = gnId callNode
                    , geTarget = targetId
                    , geType = "CALLS"
                    , geMetadata = Map.singleton "resolvedVia" (MetaText "swift-call-resolution")
                    }
                ]
              [] -> []
          Nothing -> []

-- | Extract class name from a semantic ID like "file.swift->CLASS->MyClass->FUNCTION->method"
extractClassName :: Text -> Text
extractClassName semanticId =
  let parts = T.splitOn "->" semanticId
      -- Find CLASS segment, take the name after it
  in case findAfter "CLASS" parts of
    Just name -> name
    Nothing -> ""

findAfter :: Text -> [Text] -> Maybe Text
findAfter _ [] = Nothing
findAfter _ [_] = Nothing
findAfter target (x:y:rest)
  | x == target = Just y
  | otherwise = findAfter target (y:rest)

hasSwiftLang :: GraphNode -> Bool
hasSwiftLang n = case Map.lookup "language" (gnMetadata n) of
  Just (MetaText "swift") -> True
  _ -> False

-- | CLI entry point: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

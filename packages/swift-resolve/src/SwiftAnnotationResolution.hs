{-# LANGUAGE OverloadedStrings #-}
-- | Swift annotation resolution plugin.
--
-- Resolves annotation usages (ATTRIBUTE nodes) to their declarations:
--   - ANNOTATION_RESOLVES_TO edges: ATTRIBUTE -> CLASS (kind=annotation/protocol)
--
-- For each ATTRIBUTE node, looks up a CLASS node with a matching name.
-- External annotations (stdlib, framework) are silently skipped when
-- no matching node exists.
module SwiftAnnotationResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import System.IO (hPutStrLn, stderr)

-- | Annotation type index: annotation simple name -> node ID.
type AnnotationTypeIndex = Map Text Text

-- | Build annotation type index from CLASS nodes that could be annotation types.
-- In Swift, annotations are attributes that reference protocols or classes
-- (e.g., @MainActor -> actor MainActor, @objc -> protocol, @Published -> propertyWrapper class).
buildAnnotationTypeIndex :: [GraphNode] -> AnnotationTypeIndex
buildAnnotationTypeIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "CLASS" && hasSwiftLang n =
          -- Index all CLASS nodes — annotations can reference any class/protocol/actor
          Map.insert (gnName n) (gnId n) acc
      | otherwise = acc

-- | Resolve ANNOTATION_RESOLVES_TO edges: ATTRIBUTE -> CLASS.
-- ATTRIBUTE nodes have names like "@MainActor", "@Published" etc.
-- We strip the "@" prefix and look up the class.
resolveAnnotations :: AnnotationTypeIndex -> [GraphNode] -> [PluginCommand]
resolveAnnotations annIdx = concatMap go
  where
    go node
      | gnType node /= "ATTRIBUTE" || not (hasSwiftLang node) = []
      | otherwise =
          let attrName = gnName node
              -- Strip leading "@" for lookup
              lookupName = if T.isPrefixOf "@" attrName
                           then T.drop 1 attrName
                           else attrName
          in case Map.lookup lookupName annIdx of
               Nothing    -> []
               Just annId -> [mkEdge (gnId node) annId "ANNOTATION_RESOLVES_TO"]

-- | Helper: create an EmitEdge command.
mkEdge :: Text -> Text -> Text -> PluginCommand
mkEdge src dst edgeType = EmitEdge GraphEdge
  { geSource   = src
  , geTarget   = dst
  , geType     = edgeType
  , geMetadata = Map.singleton "resolvedVia" (MetaText "swift-annotation-resolution")
  }

hasSwiftLang :: GraphNode -> Bool
hasSwiftLang n = case Map.lookup "language" (gnMetadata n) of
  Just (MetaText "swift") -> True
  _ -> False

-- | Core resolution logic.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let annIdx = buildAnnotationTypeIndex nodes

  let annotationEdges = resolveAnnotations annIdx nodes

  hPutStrLn stderr $
    "swift-annotation-resolve: " ++ show (length annotationEdges) ++ " annotation edges"

  return annotationEdges

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

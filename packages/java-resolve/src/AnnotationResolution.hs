{-# LANGUAGE OverloadedStrings #-}
-- | Java annotation resolution plugin.
--
-- Resolves annotation usages (ATTRIBUTE nodes) to their declarations:
--   - ANNOTATION_RESOLVES_TO edges: ATTRIBUTE -> ANNOTATION_TYPE
--
-- For each ATTRIBUTE node, looks up an ANNOTATION_TYPE with a matching name
-- within the project. External annotations (JDK, third-party) are silently
-- skipped when no matching ANNOTATION_TYPE node exists.
module AnnotationResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import System.IO (hPutStrLn, stderr)

-- | Annotation type index: annotation simple name -> ANNOTATION_TYPE node ID.
type AnnotationTypeIndex = Map Text Text

-- | Build annotation type index from ANNOTATION_TYPE nodes.
buildAnnotationTypeIndex :: [GraphNode] -> AnnotationTypeIndex
buildAnnotationTypeIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "ANNOTATION_TYPE" =
          Map.insert (gnName n) (gnId n) acc
      | otherwise = acc

-- | Resolve ANNOTATION_RESOLVES_TO edges: ATTRIBUTE -> ANNOTATION_TYPE.
-- For each ATTRIBUTE node, look up matching ANNOTATION_TYPE by name.
resolveAnnotations :: AnnotationTypeIndex -> [GraphNode] -> [PluginCommand]
resolveAnnotations annIdx = concatMap go
  where
    go node
      | gnType node /= "ATTRIBUTE" = []
      | otherwise =
          case Map.lookup (gnName node) annIdx of
            Nothing    -> []
            Just annId -> [mkEdge (gnId node) annId "ANNOTATION_RESOLVES_TO"]

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
  let annIdx = buildAnnotationTypeIndex nodes

  let annotationEdges = resolveAnnotations annIdx nodes
      allEdges        = annotationEdges

  hPutStrLn stderr $
    "java-annotation-resolve: " ++ show (length allEdges) ++ " annotation edges"

  return allEdges

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

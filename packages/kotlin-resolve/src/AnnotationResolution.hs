{-# LANGUAGE OverloadedStrings #-}
-- | Kotlin annotation resolution plugin.
--
-- Resolves annotation usages (ATTRIBUTE nodes) to their declarations:
--   - ANNOTATION_RESOLVES_TO edges: ATTRIBUTE -> ANNOTATION_TYPE
--
-- For each ATTRIBUTE node, looks up an ANNOTATION_TYPE with a matching name
-- within the project. Also falls back to CLASS nodes with kind="annotation"
-- (Kotlin annotation classes). External annotations (stdlib, third-party)
-- are silently skipped when no matching node exists.
module AnnotationResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import System.IO (hPutStrLn, stderr)

-- | Annotation type index: annotation simple name -> node ID.
-- Includes both ANNOTATION_TYPE nodes and CLASS nodes with kind="annotation".
type AnnotationTypeIndex = Map Text Text

-- | Build annotation type index from ANNOTATION_TYPE nodes and
-- CLASS nodes with kind="annotation" (Kotlin annotation classes).
buildAnnotationTypeIndex :: [GraphNode] -> AnnotationTypeIndex
buildAnnotationTypeIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "ANNOTATION_TYPE" =
          Map.insert (gnName n) (gnId n) acc
      | gnType n == "CLASS"
      , Just (MetaText "annotation") <- Map.lookup "kind" (gnMetadata n) =
          Map.insert (gnName n) (gnId n) acc
      | otherwise = acc

-- | Resolve ANNOTATION_RESOLVES_TO edges: ATTRIBUTE -> ANNOTATION_TYPE.
-- For each ATTRIBUTE node, look up matching annotation type by name.
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
    "kotlin-annotation-resolve: " ++ show (length allEdges) ++ " annotation edges"

  return allEdges

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

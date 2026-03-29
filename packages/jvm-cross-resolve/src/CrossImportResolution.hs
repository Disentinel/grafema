{-# LANGUAGE OverloadedStrings #-}
-- | JVM cross-language import resolution plugin.
--
-- Resolves import declarations that cross the Java/Kotlin language boundary.
-- Only emits IMPORTS_FROM edges when the source file and target file are in
-- different JVM languages (Java -> Kotlin or Kotlin -> Java).
--
-- Same-language imports are already handled by java-resolve and kotlin-resolve.
--
-- == Resolution Algorithm
--
-- Phase 1: Build unified indexes from ALL nodes (both Java and Kotlin).
--   - Module index: file path -> (MODULE node ID, package name)
--   - Class index:  qualified class name -> (file path, node ID)
--     Built from MODULE nodes' package metadata + CLASS/INTERFACE/ENUM/RECORD/OBJECT nodes.
--
-- Phase 2: Resolve IMPORT nodes to target classes (IMPORTS_FROM edges).
--   - Only emit edge if source file language differs from target file language.
--
-- Phase 3: Resolve IMPORT_BINDING nodes to exported declarations.
--   - Same cross-language filter applies.
module CrossImportResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set
import System.IO (hPutStrLn, stderr)

-- | Module index: file path -> (MODULE node ID, package name or "")
type ModuleIndex = Map Text (Text, Text)

-- | Class index: qualified name (e.g. "com.example.Foo") -> (file path, node ID)
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

-- | Build module index from MODULE nodes.
buildModuleIndex :: [GraphNode] -> ModuleIndex
buildModuleIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "MODULE" =
          let pkg = case Map.lookup "package" (gnMetadata n) of
                Just (MetaText t) -> t
                _                 -> ""
          in Map.insert (gnFile n) (gnId n, pkg) acc
      | otherwise = acc

-- | Build unified class index from CLASS, INTERFACE, ENUM, RECORD, OBJECT nodes.
--
-- Maps qualified name (package.ClassName) to (file, nodeId).
-- Uses the module index to look up the package for each file.
-- Includes both Java types (CLASS, INTERFACE, ENUM, RECORD) and
-- Kotlin types (CLASS, INTERFACE, ENUM, OBJECT).
buildClassIndex :: [GraphNode] -> ModuleIndex -> ClassIndex
buildClassIndex nodes modIdx = foldl' go Map.empty nodes
  where
    classTypes = Set.fromList ["CLASS", "INTERFACE", "ENUM", "RECORD", "OBJECT"]

    go acc n
      | Set.member (gnType n) classTypes =
          let pkg = case Map.lookup (gnFile n) modIdx of
                Just (_, p) | not (T.null p) -> p <> "."
                _                            -> ""
              qualName = pkg <> gnName n
          in Map.insert qualName (gnFile n, gnId n) acc
      | otherwise = acc

-- | Resolve a single IMPORT node, only emitting edges for cross-language references.
resolveImport :: ClassIndex -> GraphNode -> [PluginCommand]
resolveImport classIdx node =
  let importName = gnName node
      isAsterisk = case Map.lookup "asterisk" (gnMetadata node) of
        Just (MetaBool True) -> True
        _                    -> False
  in if isAsterisk
     then []
     else case Map.lookup importName classIdx of
       Just (targetFile, classNodeId)
         | isCrossLanguage (gnFile node) targetFile ->
           [ EmitEdge GraphEdge
               { geSource   = gnId node
               , geTarget   = classNodeId
               , geType     = "IMPORTS_FROM"
               , geMetadata = Map.singleton "cross_language" (MetaBool True)
               }
           ]
       _ -> []

-- | Resolve a single IMPORT_BINDING node, only emitting edges for cross-language references.
resolveBinding :: ClassIndex -> GraphNode -> [PluginCommand]
resolveBinding classIdx node =
  let bindingName = gnName node
      source = case Map.lookup "source" (gnMetadata node) of
        Just (MetaText s) -> s
        _                 -> ""
      importedName = case Map.lookup "imported_name" (gnMetadata node) of
        Just (MetaText n) -> n
        _                 -> bindingName
  in if T.null source
     then
       case Map.lookup importedName classIdx of
         Just (targetFile, classNodeId)
           | isCrossLanguage (gnFile node) targetFile ->
             [ EmitEdge GraphEdge
                 { geSource   = gnId node
                 , geTarget   = classNodeId
                 , geType     = "IMPORTS_FROM"
                 , geMetadata = Map.singleton "cross_language" (MetaBool True)
                 }
             ]
         _ -> []
     else
       case Map.lookup source classIdx of
         Just (targetFile, classNodeId)
           | isCrossLanguage (gnFile node) targetFile ->
             [ EmitEdge GraphEdge
                 { geSource   = gnId node
                 , geTarget   = classNodeId
                 , geType     = "IMPORTS_FROM"
                 , geMetadata = Map.singleton "cross_language" (MetaBool True)
                 }
             ]
         _ ->
           case Map.lookup importedName classIdx of
             Just (targetFile, classNodeId)
               | isCrossLanguage (gnFile node) targetFile ->
                 [ EmitEdge GraphEdge
                     { geSource   = gnId node
                     , geTarget   = classNodeId
                     , geType     = "IMPORTS_FROM"
                     , geMetadata = Map.singleton "cross_language" (MetaBool True)
                     }
                 ]
             _ -> []

-- | Core resolution logic.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let modIdx   = buildModuleIndex nodes
      classIdx = buildClassIndex nodes modIdx

      importNodes  = filter (\n -> gnType n == "IMPORT") nodes
      bindingNodes = filter (\n -> gnType n == "IMPORT_BINDING") nodes

  let importEdges  = concatMap (resolveImport classIdx) importNodes
      bindingEdges = concatMap (resolveBinding classIdx) bindingNodes

  hPutStrLn stderr $
    "jvm-cross-imports: " ++ show (length importEdges) ++ " import edges, "
      ++ show (length bindingEdges) ++ " binding edges"

  return (importEdges ++ bindingEdges)

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

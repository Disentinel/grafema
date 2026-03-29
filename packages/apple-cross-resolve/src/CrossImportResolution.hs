{-# LANGUAGE OverloadedStrings #-}
-- | Apple cross-language import resolution plugin.
--
-- Resolves bridging header imports: Obj-C headers imported in Swift bridging
-- header become visible in Swift, and @objc Swift declarations become visible
-- in Obj-C via the generated -Swift.h header.
--
-- Only emits IMPORTS_FROM edges when the source file and target file are in
-- different Apple languages (Swift -> Obj-C or Obj-C -> Swift).
--
-- Same-language imports are already handled by swift-resolve and objc-resolve.
--
-- == Resolution Algorithm
--
-- Phase 1: Build indexes from MODULE and CLASS nodes.
--   - Module index: file path -> (MODULE node ID, language)
--   - Class index:  class name -> (file path, node ID)
--
-- Phase 2: Resolve IMPORT nodes to target modules (IMPORTS_FROM edges).
--   - Only emit edge if source file language differs from target file language.
module CrossImportResolution (run, resolveAll) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..), readNodesFromStdin, writeCommandsToStdout)

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map
import System.IO (hPutStrLn, stderr)

-- | Module index: file path -> (MODULE node ID, language)
type ModuleIndex = Map Text (Text, Text)

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

-- | Build module index from MODULE nodes.
buildModuleIndex :: [GraphNode] -> ModuleIndex
buildModuleIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "MODULE" =
          let lang = case getLanguage n of
                Just l  -> l
                Nothing -> ""
          in Map.insert (gnFile n) (gnId n, lang) acc
      | otherwise = acc

-- | Resolve bridging imports across language boundary.
resolveBridgingImport :: ModuleIndex -> GraphNode -> [PluginCommand]
resolveBridgingImport modIdx importNode =
  let importName = gnName importNode
      -- Try matching against module files
      matches = [ (file, modId)
                | (file, (modId, _lang)) <- Map.toList modIdx
                , isCrossLanguage (gnFile importNode) file
                , matchesImport importName file
                ]
  in case matches of
    ((_, targetModId):_) ->
      [ EmitEdge GraphEdge
          { geSource   = gnId importNode
          , geTarget   = targetModId
          , geType     = "IMPORTS_FROM"
          , geMetadata = Map.fromList
              [("bridging", MetaText "true"), ("resolvedVia", MetaText "apple-cross-import")]
          }
      ]
    [] -> []

-- | Check if an import name matches a file path.
-- Handles both #import "Header.h" style and framework-style imports.
matchesImport :: Text -> Text -> Bool
matchesImport importName file =
  -- Direct header match: #import "MyClass.h" matches "MyClass.h" or "path/to/MyClass.h"
  T.isSuffixOf importName file
  || T.isSuffixOf ("/" <> importName) file
  -- Module name match: import Foundation matches files with Foundation in path
  || (not (T.null importName) && importName `T.isInfixOf` file)

-- | Core resolution logic.
resolveAll :: [GraphNode] -> IO [PluginCommand]
resolveAll nodes = do
  let modIdx = buildModuleIndex nodes

      importNodes = filter (\n -> gnType n == "IMPORT") nodes
      edges = concatMap (resolveBridgingImport modIdx) importNodes

  hPutStrLn stderr $
    "apple-cross-imports: " ++ show (length edges) ++ " import edges"

  return edges

-- | CLI entry: read nodes from stdin, resolve, write commands to stdout.
run :: IO ()
run = do
  nodes <- readNodesFromStdin
  commands <- resolveAll nodes
  writeCommandsToStdout commands

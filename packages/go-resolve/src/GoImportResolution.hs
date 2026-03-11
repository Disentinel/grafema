{-# LANGUAGE OverloadedStrings #-}
-- | Go import resolution plugin.
--
-- Resolves Go import declarations to their target packages within the
-- same module. Uses the module path from go.mod to distinguish
-- same-module imports from standard library and third-party imports.
--
-- == Go Module System
--
-- Go packages correspond to directories:
--
-- * @cmd\/server\/main.go@ -> package in @cmd\/server@
-- * @internal\/auth\/auth.go@ -> package in @internal\/auth@
--
-- Imports use full module paths:
--
-- * @\"fmt\"@ -> standard library (no dot in first segment)
-- * @\"github.com\/user\/myproject\/internal\/auth\"@ -> same-module
-- * @\"github.com\/other\/lib\"@ -> third-party
--
-- == Resolution Algorithm
--
-- Phase 1: Build package index from MODULE nodes.
--   - PackageIndex: directory path -> [MODULE node ID]
--   - Group MODULE nodes by their file's directory.
--
-- Phase 2: Resolve IMPORT nodes to MODULE nodes (IMPORTS_FROM edges).
--   - Extract @path@ from IMPORT node metadata.
--   - Skip standard library imports (no dot in first path segment).
--   - For same-module imports, strip module prefix to get relative dir.
--   - Look up relative dir in PackageIndex.
--   - Emit IMPORTS_FROM edge to first MODULE in that directory.
--
-- Blank imports (@_ \"pkg\"@) and dot imports (@. \"pkg\"@) are still
-- resolved since they reference real packages.
module GoImportResolution
  ( resolveAll
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.Protocol (PluginCommand(..))

import Data.List (foldl')
import Data.Text (Text)
import qualified Data.Text as T
import Data.Map.Strict (Map)
import qualified Data.Map.Strict as Map

-- | Package index: directory path -> list of MODULE node IDs in that directory.
type PackageIndex = Map Text [Text]

-- | Build package index from MODULE nodes.
--
-- For each MODULE node, extracts the directory from its file path and
-- groups MODULE IDs by directory. Multiple files in the same Go package
-- (directory) share a single index entry.
buildPackageIndex :: [GraphNode] -> PackageIndex
buildPackageIndex = foldl' go Map.empty
  where
    go acc n
      | gnType n == "MODULE" =
          let dir = dirOfFile (gnFile n)
          in Map.insertWith (++) dir [gnId n] acc
      | otherwise = acc

-- | Look up a text metadata value from a node's metadata map.
lookupMetaText :: Text -> GraphNode -> Maybe Text
lookupMetaText key node = case Map.lookup key (gnMetadata node) of
  Just (MetaText t) -> Just t
  _                 -> Nothing

-- | Extract directory from a file path (everything before last '/').
--
-- @dirOfFile \"cmd\/server\/main.go\"@ -> @\"cmd\/server\"@
-- @dirOfFile \"main.go\"@ -> @\"\"@
dirOfFile :: Text -> Text
dirOfFile f = case T.breakOnEnd "/" f of
  ("", _) -> ""
  (d, _)  -> T.dropEnd 1 d  -- drop trailing '/'

-- | Check if an import path looks like a standard library import.
--
-- Standard library packages have no dot in their first path segment:
-- @\"fmt\"@, @\"database\/sql\"@, @\"net\/http\"@.
-- Third-party and module imports always have a domain: @\"github.com\/...\"@.
isStdLib :: Text -> Bool
isStdLib path = not (T.any (== '.') (head' (T.splitOn "/" path)))
  where
    head' []    = ""
    head' (x:_) = x

-- | Core resolution logic.
--
-- Given all graph nodes from the analyzed Go project and the module path
-- (from go.mod), resolves IMPORT nodes to their target MODULE nodes
-- within the same module.
--
-- Returns a list of 'PluginCommand's (EmitEdge) to be sent to the
-- orchestrator.
resolveAll :: [GraphNode] -> Text -> [PluginCommand]
resolveAll nodes modulePath =
  let pkgIdx      = buildPackageIndex nodes
      importNodes = filter (\n -> gnType n == "IMPORT") nodes
  in concatMap (resolveOneImport pkgIdx modulePath) importNodes

-- | Resolve a single IMPORT node, producing IMPORTS_FROM edge commands.
--
-- 1. Extract @path@ from metadata.
-- 2. Skip standard library imports (no dot in first segment).
-- 3. For same-module imports, strip module prefix to get relative directory.
-- 4. Look up in package index.
-- 5. Emit IMPORTS_FROM edge to first MODULE in the directory.
--
-- When the module path is empty, falls back to suffix matching against
-- known directory paths in the package index.
resolveOneImport :: PackageIndex -> Text -> GraphNode -> [PluginCommand]
resolveOneImport pkgIdx modulePath node =
  case lookupMetaText "path" node of
    Nothing -> []
    Just importPath
      | isStdLib importPath -> []
      | otherwise ->
          let mRelDir = case T.stripPrefix modulePath importPath of
                Just suffix | not (T.null modulePath) ->
                  Just (T.dropWhile (== '/') suffix)
                _ -> Nothing
              mTarget = case mRelDir of
                Just relDir -> case Map.lookup relDir pkgIdx of
                  Just (tid : _) -> Just tid
                  _              -> Nothing
                Nothing ->
                  -- Fallback: suffix match when module path is empty
                  if T.null modulePath
                  then findBySuffix pkgIdx importPath
                  else Nothing  -- third-party import, skip
          in case mTarget of
            Just targetId ->
              [ EmitEdge GraphEdge
                  { geSource   = gnId node
                  , geTarget   = targetId
                  , geType     = "IMPORTS_FROM"
                  , geMetadata = Map.empty
                  }
              ]
            Nothing -> []

-- | Find a target MODULE by matching import path suffix against known directories.
--
-- Used as a fallback when the module path is empty (go.mod not available).
-- Checks if any known directory in the package index is a suffix of the
-- import path. Returns the first match.
findBySuffix :: PackageIndex -> Text -> Maybe Text
findBySuffix pkgIdx importPath =
  let candidates =
        [ targetId
        | (dir, moduleIds) <- Map.toList pkgIdx
        , not (T.null dir)
        , T.isSuffixOf dir importPath
        , targetId <- take 1 moduleIds
        ]
  in case candidates of
    (targetId : _) -> Just targetId
    []             -> Nothing

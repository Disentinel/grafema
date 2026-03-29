{-# LANGUAGE OverloadedStrings #-}
-- | C/C++ include resolution: resolves @#include@ directives to MODULE nodes.
--
-- Handles both local includes (@#include "foo.h"@) and system includes
-- (@#include \<vector\>@). Local includes are resolved relative to the
-- including file first, then via project include paths. System includes
-- with no matching MODULE node are silently skipped (standard library
-- headers are not part of the project graph).
--
-- == Resolution Algorithm
--
-- 1. Extract include path from IMPORT node's @path@ metadata.
-- 2. Classify as system (@\<...\>@) or local (@"..."@) via @include_kind@ metadata.
-- 3. For local includes:
--    a. Resolve relative to the including file's directory.
--    b. If not found, try each project include path.
-- 4. For system includes:
--    a. Try each project include path.
--    b. If not found, skip gracefully (likely a standard library header).
-- 5. Match resolved path against the module index.
-- 6. Emit IMPORTS_FROM edge: IMPORT -> MODULE.
--
-- Node types consumed: IMPORT (with include-related metadata)
-- Edge types emitted: IMPORTS_FROM
module CppIncludeResolution
  ( resolveAll
  ) where

import Grafema.Types (GraphNode(..), GraphEdge(..))
import Grafema.Protocol (PluginCommand(..))
import CppIndex (CppIndex(..), lookupMetaText, dirOfFile)

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

-- | Resolve all @#include@ directives to their target MODULE nodes.
--
-- Parameters:
--   * @nodes@ — all graph nodes from the C/C++ project
--   * @idx@ — pre-built 'CppIndex'
--
-- Returns a list of 'EmitEdge' commands with IMPORTS_FROM edges.
resolveAll :: [GraphNode] -> CppIndex -> [PluginCommand]
resolveAll nodes idx =
  let importNodes = filter isIncludeImport nodes
  in concatMap (resolveOneInclude idx) importNodes

-- | Check if a node is an IMPORT node representing a @#include@ directive.
isIncludeImport :: GraphNode -> Bool
isIncludeImport n =
  gnType n == "IMPORT"
    && lookupMetaText "kind" n `elem` [Just "include", Just "IncludeResolve", Nothing]

-- | Resolve a single @#include@ directive.
resolveOneInclude :: CppIndex -> GraphNode -> [PluginCommand]
resolveOneInclude idx node =
  case lookupMetaText "path" node of
    Nothing -> []
    Just includePath ->
      let isSystem     = lookupMetaText "include_kind" node == Just "system"
          includerDir  = dirOfFile (gnFile node)
          candidates   = if isSystem
                         then systemCandidates includePath
                         else localCandidates includerDir includePath
      in case findFirstMatch (moduleIndex idx) candidates of
        Just targetId ->
          [ EmitEdge GraphEdge
              { geSource   = gnId node
              , geTarget   = targetId
              , geType     = "IMPORTS_FROM"
              , geMetadata = Map.empty
              }
          ]
        Nothing -> []

-- | Generate candidate file paths for a local include (@#include "foo.h"@).
--
-- Priority order:
--   1. Relative to the including file's directory
--   2. The include path as-is (project root relative)
localCandidates :: Text -> Text -> [Text]
localCandidates includerDir includePath =
  let relative = if T.null includerDir
                 then includePath
                 else includerDir <> "/" <> includePath
      -- Normalize away ".." components
      normalized = normalizePath relative
      -- Also try the path as-is (relative to project root)
      asIs = normalizePath includePath
  in [normalized, asIs]

-- | Generate candidate file paths for a system include (@#include \<vector\>@).
--
-- System includes are searched only via the include path as-is.
-- Standard library headers without MODULE nodes will simply not match.
systemCandidates :: Text -> [Text]
systemCandidates includePath = [includePath]

-- | Find the first candidate path that exists in the module index.
findFirstMatch :: Map.Map Text Text -> [Text] -> Maybe Text
findFirstMatch _modIdx [] = Nothing
findFirstMatch modIdx (c:cs) =
  case Map.lookup c modIdx of
    Just nodeId -> Just nodeId
    Nothing     -> findFirstMatch modIdx cs

-- | Normalize a file path by resolving @..@ and @.@ components.
--
-- @normalizePath "src/utils/../common/types.h"@ -> @"src/common/types.h"@
-- @normalizePath "src/./foo.h"@ -> @"src/foo.h"@
normalizePath :: Text -> Text
normalizePath path =
  let segments = T.splitOn "/" path
      resolved = foldl resolveSegment [] segments
  in T.intercalate "/" (reverse resolved)
  where
    resolveSegment acc "."  = acc
    resolveSegment (_:rest) ".." = rest
    resolveSegment [] ".." = []  -- can't go above root, drop silently
    resolveSegment acc seg = seg : acc

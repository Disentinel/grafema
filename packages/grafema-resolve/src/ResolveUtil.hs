{-# LANGUAGE OverloadedStrings #-}
-- | Shared utilities for grafema-resolve plugins.
--
-- Extracted from SameFileCalls and PropertyAccess to eliminate duplication.
module ResolveUtil
  ( extractClassFromId
  , lookupMetaText
  , buildImportIndex
  ) where

import Grafema.Types (GraphNode(..), MetaValue(..))

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)

-- | Extract class name from a semantic ID with @[in:ClassName]@ suffix.
--
-- Example: @"file.js->FUNCTION->render[in:App]"@ -> @Just "App"@
-- Example: @"file.js->FUNCTION->foo"@ -> @Nothing@
extractClassFromId :: Text -> Maybe Text
extractClassFromId sid =
  case T.breakOn "[in:" sid of
    (_, rest)
      | T.null rest -> Nothing
      | otherwise ->
          let afterPrefix = T.drop 4 rest  -- drop "[in:"
              (parent, _) = T.breakOn "]" afterPrefix
              -- Strip possible ",h:..." suffix
              (cleanParent, _) = T.breakOn ",h:" parent
          in if T.null cleanParent then Nothing else Just cleanParent

-- | Look up a text value in a metadata map.
lookupMetaText :: Text -> Map Text MetaValue -> Maybe Text
lookupMetaText key meta = case Map.lookup key meta of
  Just (MetaText t) -> Just t
  _                 -> Nothing

-- | Build a set of imported names: @(file, localName)@.
-- Used to skip names that are imports (handled by ImportResolution/CrossFileCalls).
buildImportIndex :: [GraphNode] -> Set (Text, Text)
buildImportIndex nodes =
  Set.fromList
    [ (gnFile n, gnName n)
    | n <- nodes
    , gnType n == "IMPORT_BINDING"
    ]

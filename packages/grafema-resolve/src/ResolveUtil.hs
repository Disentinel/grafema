{-# LANGUAGE OverloadedStrings #-}
-- | Shared utilities for grafema-resolve plugins.
--
-- Extracted from SameFileCalls and PropertyAccess to eliminate duplication.
module ResolveUtil
  ( extractClassFromId
  , decodeSemIdChars
  , lookupMetaText
  , buildImportIndex
  , ClassRangeIndex
  , buildClassRangeIndex
  , findEnclosingClass
  ) where

import Grafema.Types (GraphNode(..), MetaValue(..))

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Map.Strict (Map)
import qualified Data.Set as Set
import Data.Set (Set)

-- | Decode percent-encoded characters commonly found in Grafema URI-format semantic IDs.
-- Only decodes the three characters that appear in scope markers: @[@ @]@ @>@
decodeSemIdChars :: Text -> Text
decodeSemIdChars = T.replace "%5B" "[" . T.replace "%5b" "["
                 . T.replace "%5D" "]" . T.replace "%5d" "]"
                 . T.replace "%3E" ">" . T.replace "%3e" ">"

-- | Extract class name from a semantic ID with @[in:ClassName]@ suffix.
--
-- Handles both legacy arrow format (@file.js->FUNCTION->render[in:App]@)
-- and URI format (@grafema://...#FUNCTION-%3Erender%5Bin:App%5D@).
--
-- Example: @"file.js->FUNCTION->render[in:App]"@ -> @Just "App"@
-- Example: @"file.js->FUNCTION->foo"@ -> @Nothing@
extractClassFromId :: Text -> Maybe Text
extractClassFromId sid =
  let decoded = decodeSemIdChars sid
  in case T.breakOn "[in:" decoded of
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

-- | Class range index for line containment: file -> [(className, startLine, endLine)]
type ClassRangeIndex = Map Text [(Text, Int, Int)]

-- | Build class range index from CLASS nodes for line containment lookup.
buildClassRangeIndex :: [GraphNode] -> ClassRangeIndex
buildClassRangeIndex nodes =
  Map.fromListWith (++)
    [ (gnFile n, [(gnName n, gnLine n, gnEndLine n)])
    | n <- nodes
    , gnType n == "CLASS"
    , not (T.null (gnName n))
    , gnEndLine n > 0
    ]

-- | Find the class that contains a given line position in a file.
findEnclosingClass :: ClassRangeIndex -> Text -> Int -> Maybe Text
findEnclosingClass classRanges file line =
  case Map.lookup file classRanges of
    Nothing -> Nothing
    Just ranges ->
      case filter (\(_, start, end) -> line >= start && line <= end) ranges of
        [(className, _, _)] -> Just className
        _                   -> Nothing  -- ambiguous (multiple matches) or none

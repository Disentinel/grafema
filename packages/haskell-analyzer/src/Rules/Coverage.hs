{-# LANGUAGE OverloadedStrings #-}
-- | Phase 7 post-pass: constructor coverage analysis.
--
-- After the main analysis pass completes, this module inspects the
-- resulting 'FileAnalysis' to detect missing constructors in pattern
-- matches. For each function that pattern-matches on constructors of
-- a known data type (defined in the same file), it checks whether all
-- constructors are covered. Unhandled constructors produce
-- MISSING_CONSTRUCTOR edges from the function to the data type.
--
-- This is intra-file best-effort analysis: data types defined in other
-- modules cannot be checked here.
module Rules.Coverage
  ( checkCoverage
  ) where

import Data.List (sortOn)
import Data.Text (Text)
import qualified Data.Map.Strict as Map
import qualified Data.Set as Set

import Analysis.Types (FileAnalysis(..), GraphNode(..), GraphEdge(..), MetaValue(..))

-- | Check pattern coverage in the completed analysis.
--
-- Returns MISSING_CONSTRUCTOR edges for each constructor of a locally
-- defined data type that is not covered by patterns in a function that
-- handles at least one constructor of that type.
--
-- Strategy:
-- 1. Build a map from data type name to its constructor names (from
--    DATA_TYPE + CONSTRUCTOR nodes linked by CONTAINS edges).
-- 2. Collect all FUNCTION nodes (sorted by line number).
-- 3. Collect all PATTERN nodes with constructor metadata.
-- 4. Assign each PATTERN to its enclosing function using line-based
--    proximity (a pattern belongs to the nearest preceding function).
-- 5. For each function, determine which data types are partially
--    matched and emit MISSING_CONSTRUCTOR edges for uncovered
--    constructors.
checkCoverage :: FileAnalysis -> [GraphEdge]
checkCoverage fa =
  let dataTypes    = collectDataTypes fa   -- Map DataTypeName (DataTypeNodeId, Set ConstructorName)
      functions    = collectFunctions fa   -- [(FunctionNodeId, FunctionLine)] sorted by line
      patterns     = collectPatterns fa    -- [(ConstructorName, PatternLine)]
      -- Assign patterns to functions by line proximity
      fnPatterns   = assignPatternsToFunctions functions patterns
      -- For each function, check coverage against known data types
  in concatMap (checkFunction dataTypes) (Map.toList fnPatterns)

-- | Map from data type name to (data type node ID, set of constructor names).
collectDataTypes :: FileAnalysis -> Map.Map Text (Text, Set.Set Text)
collectDataTypes fa =
  let dtNodes = [ n | n <- faNodes fa, gnType n == "DATA_TYPE" ]
      conNodes = [ n | n <- faNodes fa, gnType n == "CONSTRUCTOR" ]
      -- Build map from data type node ID -> data type name
      dtIdToName = Map.fromList [ (gnId n, gnName n) | n <- dtNodes ]
      -- Find CONTAINS edges from DATA_TYPE to CONSTRUCTOR
      containsEdges = [ e | e <- faEdges fa
                       , geType e == "CONTAINS"
                       , Map.member (geSource e) dtIdToName
                       ]
      -- Group constructor names by their parent data type
      initial = Map.fromList [ (gnName n, (gnId n, Set.empty)) | n <- dtNodes ]
      -- For each CONTAINS edge, find the constructor name and add it to the data type
      conIdToName = Map.fromList [ (gnId n, gnName n) | n <- conNodes ]
  in foldl (\acc edge ->
        case (Map.lookup (geSource edge) dtIdToName, Map.lookup (geTarget edge) conIdToName) of
          (Just dtName, Just conName) ->
            Map.adjust (\(dtId, cons) -> (dtId, Set.insert conName cons)) dtName acc
          _ -> acc
     ) initial containsEdges

-- | Collect FUNCTION nodes as (nodeId, line) pairs, sorted by line.
collectFunctions :: FileAnalysis -> [(Text, Int)]
collectFunctions fa =
  sortOn snd [ (gnId n, gnLine n) | n <- faNodes fa, gnType n == "FUNCTION" ]

-- | Collect PATTERN nodes with constructor metadata as (constructorName, line).
collectPatterns :: FileAnalysis -> [(Text, Int)]
collectPatterns fa =
  [ (conName, gnLine n)
  | n <- faNodes fa
  , gnType n == "PATTERN"
  , Just (MetaText conName) <- [Map.lookup "constructor" (gnMetadata n)]
  ]

-- | Assign patterns to their enclosing function based on line proximity.
--
-- A pattern at line P belongs to the function at line F where F <= P
-- and F is the largest such function line. If no function precedes the
-- pattern, it is assigned to the first function (if any).
assignPatternsToFunctions :: [(Text, Int)] -> [(Text, Int)] -> Map.Map Text (Set.Set Text)
assignPatternsToFunctions [] _ = Map.empty
assignPatternsToFunctions fns pats =
  foldl (\acc (conName, patLine) ->
    case findEnclosingFn fns patLine of
      Just fnId -> Map.insertWith Set.union fnId (Set.singleton conName) acc
      Nothing   -> acc
  ) Map.empty pats

-- | Find the function whose line is closest to (but not after) the given line.
findEnclosingFn :: [(Text, Int)] -> Int -> Maybe Text
findEnclosingFn fns patLine =
  case filter (\(_, fnLine) -> fnLine <= patLine) fns of
    [] -> Nothing
    xs -> Just (fst (last xs))

-- | Check a single function's patterns against known data types.
--
-- For each data type whose constructors are partially matched by this
-- function's patterns, emit MISSING_CONSTRUCTOR edges for uncovered
-- constructors.
checkFunction :: Map.Map Text (Text, Set.Set Text) -> (Text, Set.Set Text) -> [GraphEdge]
checkFunction dataTypes (fnNodeId, matchedConstructors) =
  concatMap (checkDataType fnNodeId matchedConstructors) (Map.toList dataTypes)

-- | Check if a function's patterns partially cover a data type's constructors.
--
-- Returns MISSING_CONSTRUCTOR edges for uncovered constructors if and only if:
-- 1. At least one of the data type's constructors is matched
-- 2. Not all constructors are matched
checkDataType :: Text -> Set.Set Text -> (Text, (Text, Set.Set Text)) -> [GraphEdge]
checkDataType fnNodeId matchedConstructors (_dtName, (dtNodeId, allConstructors))
  | Set.null allConstructors = []   -- no constructors known
  | Set.null overlap = []           -- function doesn't match this data type at all
  | overlap == allConstructors = [] -- all constructors covered
  | otherwise =
      [ GraphEdge
          { geSource   = fnNodeId
          , geTarget   = dtNodeId
          , geType     = "MISSING_CONSTRUCTOR"
          , geMetadata = Map.singleton "constructor" (MetaText con)
          }
      | con <- Set.toList missing
      ]
  where
    overlap = Set.intersection matchedConstructors allConstructors
    missing = Set.difference allConstructors matchedConstructors


{-# LANGUAGE OverloadedStrings #-}
-- | Memory allocation metadata for C/C++.
--
-- Adds memory metadata to CALL nodes:
--   * new/new[]         -> allocKind="new"/"new[]"
--   * delete/delete[]   -> allocKind="delete"/"delete[]"
--   * malloc/free/calloc/realloc -> allocKind="malloc"/"free"/etc.
--   * placement new     -> allocKind="placement_new"
--
-- This module is used as a helper by Rules.Expressions rather than
-- as a standalone walker, since memory operations are detected during
-- expression walking.
module Rules.Memory
  ( isMemoryAllocCall
  , memoryAllocKind
  ) where

import Data.Text (Text)
import qualified Data.Map.Strict as Map

import Analysis.Types (MetaValue(..))

-- | Check if a function name is a C memory allocation function.
isMemoryAllocCall :: Text -> Bool
isMemoryAllocCall name = name `elem` memoryFunctions

-- | Get the allocKind metadata for a memory function call.
memoryAllocKind :: Text -> Map.Map Text MetaValue
memoryAllocKind name
  | name == "malloc"  = Map.singleton "allocKind" (MetaText "malloc")
  | name == "calloc"  = Map.singleton "allocKind" (MetaText "calloc")
  | name == "realloc" = Map.singleton "allocKind" (MetaText "realloc")
  | name == "free"    = Map.singleton "allocKind" (MetaText "free")
  | name == "aligned_alloc" = Map.singleton "allocKind" (MetaText "aligned_alloc")
  | name == "posix_memalign" = Map.singleton "allocKind" (MetaText "posix_memalign")
  | otherwise         = Map.empty

-- | List of known C memory allocation/deallocation functions.
memoryFunctions :: [Text]
memoryFunctions =
  [ "malloc"
  , "calloc"
  , "realloc"
  , "free"
  , "aligned_alloc"
  , "posix_memalign"
  ]

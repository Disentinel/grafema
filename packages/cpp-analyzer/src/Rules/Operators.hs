{-# LANGUAGE OverloadedStrings #-}
-- | Operator overloading detection for C++.
--
-- For FunctionDecl/MethodDecl where name starts with "operator":
--   * Sets kind="operator" metadata on FUNCTION node
--   * Extracts operator symbol (e.g., "+", "<<", "()", "[]")
--
-- This module provides helper functions used by Rules.Declarations
-- during function declaration processing.
module Rules.Operators
  ( isOperatorOverload
  , extractOperatorSymbol
  , operatorMetadata
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import Analysis.Types (MetaValue(..))

-- | Check if a function name is an operator overload.
isOperatorOverload :: Text -> Bool
isOperatorOverload name = T.isPrefixOf "operator" name

-- | Extract the operator symbol from an operator overload name.
-- Examples:
--   "operator+"   -> "+"
--   "operator<<"  -> "<<"
--   "operator()"  -> "()"
--   "operator[]"  -> "[]"
--   "operator new" -> "new"
--   "operator bool" -> "bool" (conversion operator)
extractOperatorSymbol :: Text -> Text
extractOperatorSymbol name =
  let stripped = T.drop 8 name  -- drop "operator"
      trimmed  = T.stripStart stripped
  in if T.null trimmed then "<unknown>" else trimmed

-- | Build operator metadata for a FUNCTION node.
operatorMetadata :: Text -> Map.Map Text MetaValue
operatorMetadata name
  | isOperatorOverload name =
      Map.fromList
        [ ("kind",           MetaText "operator")
        , ("operatorSymbol", MetaText (extractOperatorSymbol name))
        ]
  | otherwise = Map.empty

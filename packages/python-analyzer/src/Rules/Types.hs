{-# LANGUAGE OverloadedStrings #-}
-- | Type annotation rule: emits TYPE_OF edges for Python type annotations
-- (function return types, variable annotations, parameter annotations).
--
-- Handles these Python type annotation patterns:
--   * NameExpr "int"           -> deferred TYPE_OF for simple types
--   * SubscriptExpr            -> walks into Optional[X], List[X], Dict[K,V]
--   * AttributeExpr            -> walks into module.Type dotted paths
--
-- Edge types: TYPE_OF (via deferred resolution)
--
-- Called from the analysis walker for type annotation expressions.
module Rules.Types
  ( walkTypeRef
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import PythonAST (PythonExpr(..), Span(..), Pos(..))
import Analysis.Types
    ( DeferredRef(..)
    , DeferredKind(..)
    )
import Analysis.Context
    ( Analyzer
    , emitDeferred
    , askFile
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Type reference walker ─────────────────────────────────────────────

-- | Walk a type annotation expression and emit deferred type references
-- for resolution. Handles simple names, subscripts (generics), and
-- dotted attribute paths.
walkTypeRef :: PythonExpr -> Analyzer ()

-- Simple type name: int, str, MyClass, etc.
walkTypeRef (NameExpr name sp) = do
  file <- askFile
  let line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)
      hash = contentHash
        [ ("name", name)
        , ("line", T.pack (show line))
        ]
      refId = semanticId file "REFERENCE" name Nothing (Just hash)

  emitDeferred DeferredRef
    { drKind       = TypeResolve
    , drName       = name
    , drFromNodeId = refId
    , drEdgeType   = "TYPE_OF"
    , drScopeId    = Nothing
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.empty
    }

-- Subscript: Optional[X], List[X], Dict[K,V], Union[A,B], etc.
-- Walk the base type (the container/generic name).
walkTypeRef (SubscriptExpr val _slice _sp) = walkTypeRef val

-- Attribute access: module.Type, typing.Optional, etc.
-- Walk the value part to resolve the dotted path.
walkTypeRef (AttributeExpr val attr sp) = do
  file <- askFile
  let fullName = extractDottedName (AttributeExpr val attr sp)
      line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)
      hash = contentHash
        [ ("name", fullName)
        , ("line", T.pack (show line))
        ]
      refId = semanticId file "REFERENCE" fullName Nothing (Just hash)

  emitDeferred DeferredRef
    { drKind       = TypeResolve
    , drName       = fullName
    , drFromNodeId = refId
    , drEdgeType   = "TYPE_OF"
    , drScopeId    = Nothing
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.empty
    }

-- BinOp with "|": Python 3.10+ union syntax (X | Y)
walkTypeRef (BinOpExpr left "|" right _) = do
  walkTypeRef left
  walkTypeRef right

-- Other expressions (ConstantExpr for None, etc.): skip
walkTypeRef _ = pure ()

-- ── Helpers ───────────────────────────────────────────────────────────

-- | Extract a dotted name from nested AttributeExpr chains.
-- e.g. AttributeExpr (AttributeExpr (NameExpr "a") "b") "c" -> "a.b.c"
extractDottedName :: PythonExpr -> Text
extractDottedName (NameExpr name _)        = name
extractDottedName (AttributeExpr val attr _) =
  extractDottedName val <> "." <> attr
extractDottedName _ = "<unknown>"

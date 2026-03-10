{-# LANGUAGE OverloadedStrings #-}
-- | Decorator rule: emits ATTRIBUTE nodes and HAS_ATTRIBUTE edges
-- for Python decorator expressions (@staticmethod, @property, etc.).
--
-- Handles these Python decorator patterns:
--   * @staticmethod            -> ATTRIBUTE node + HAS_ATTRIBUTE edge
--   * @property                -> ATTRIBUTE node + HAS_ATTRIBUTE edge
--   * @module.decorator        -> ATTRIBUTE node with dotted name
--   * @decorator(args)         -> ATTRIBUTE node (name from call func)
--
-- Node types: ATTRIBUTE
-- Edge types: HAS_ATTRIBUTE
--
-- Called from the analysis walker for each function/class definition
-- that has decorators.
module Rules.Decorators
  ( walkDecorators
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import PythonAST (PythonExpr(..), Span(..), Pos(..))
import Analysis.Types
    ( GraphNode(..)
    , GraphEdge(..)
    , MetaValue(..)
    )
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , askFile
    , askNamedParent
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Top-level decorator walker ────────────────────────────────────────

-- | Walk a decorator list and emit ATTRIBUTE nodes + HAS_ATTRIBUTE edges
-- for each decorator, linked to the target node (function or class).
walkDecorators :: [PythonExpr] -> Text -> Analyzer ()
walkDecorators decos targetNodeId =
  mapM_ (walkSingleDecorator targetNodeId) decos

-- ── Single decorator walker ───────────────────────────────────────────

-- | Walk a single decorator expression, emitting ATTRIBUTE node +
-- HAS_ATTRIBUTE edge to the target.
walkSingleDecorator :: Text -> PythonExpr -> Analyzer ()
walkSingleDecorator targetNodeId decoExpr = do
  file   <- askFile
  parent <- askNamedParent

  let decoName = extractDecoratorName decoExpr
      sp       = exprSpan decoExpr
      hash     = contentHash
        [ ("name", decoName)
        , ("line", T.pack (show (posLine (spanStart sp))))
        ]
      attrNodeId = semanticId file "ATTRIBUTE" decoName parent (Just hash)
      line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId        = attrNodeId
    , gnType      = "ATTRIBUTE"
    , gnName      = decoName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("decorator_name", MetaText decoName)
        , ("kind",           MetaText (classifyDecorator decoName))
        ]
    }

  emitEdge GraphEdge
    { geSource   = targetNodeId
    , geTarget   = attrNodeId
    , geType     = "HAS_ATTRIBUTE"
    , geMetadata = Map.empty
    }

-- ── Helpers ───────────────────────────────────────────────────────────

-- | Extract decorator name from an expression.
-- Handles: @name, @module.attr, @decorator(args), nested dots.
extractDecoratorName :: PythonExpr -> Text
extractDecoratorName (NameExpr name _)        = name
extractDecoratorName (AttributeExpr val attr _) =
  extractDecoratorName val <> "." <> attr
extractDecoratorName (CallExpr func _ _ _)    = extractDecoratorName func
extractDecoratorName _                        = "<unknown>"

-- | Get span from any expression.
exprSpan :: PythonExpr -> Span
exprSpan (NameExpr _ sp)           = sp
exprSpan (AttributeExpr _ _ sp)    = sp
exprSpan (CallExpr _ _ _ sp)       = sp
exprSpan (BoolOpExpr _ _ sp)       = sp
exprSpan (NamedExpr _ _ sp)        = sp
exprSpan (BinOpExpr _ _ _ sp)      = sp
exprSpan (UnaryOpExpr _ _ sp)      = sp
exprSpan (LambdaExpr _ _ sp)       = sp
exprSpan (IfExpr _ _ _ sp)         = sp
exprSpan (DictExpr _ _ sp)         = sp
exprSpan (SetExpr _ sp)            = sp
exprSpan (ListCompExpr _ _ sp)     = sp
exprSpan (SetCompExpr _ _ sp)      = sp
exprSpan (DictCompExpr _ _ _ sp)   = sp
exprSpan (GeneratorExpr _ _ sp)    = sp
exprSpan (AwaitExpr _ sp)          = sp
exprSpan (YieldExpr _ sp)          = sp
exprSpan (YieldFromExpr _ sp)      = sp
exprSpan (CompareExpr _ _ _ sp)    = sp
exprSpan (FormattedValueExpr _ _ _ sp) = sp
exprSpan (JoinedStrExpr _ sp)      = sp
exprSpan (ConstantExpr _ _ sp)     = sp
exprSpan (SubscriptExpr _ _ sp)    = sp
exprSpan (StarredExpr _ sp)        = sp
exprSpan (ListExpr _ sp)           = sp
exprSpan (TupleExpr _ sp)          = sp
exprSpan (SliceExpr _ _ _ sp)      = sp
exprSpan (ExprUnknown sp)          = sp

-- | Classify a Python decorator into a kind for metadata.
classifyDecorator :: Text -> Text
classifyDecorator "staticmethod"      = "builtin"
classifyDecorator "classmethod"       = "builtin"
classifyDecorator "property"          = "builtin"
classifyDecorator "abstractmethod"    = "abstract"
classifyDecorator "abc.abstractmethod" = "abstract"
classifyDecorator "dataclass"         = "framework"
classifyDecorator "dataclasses.dataclass" = "framework"
classifyDecorator "functools.wraps"   = "wrapper"
classifyDecorator "functools.lru_cache" = "cache"
classifyDecorator "functools.cache"   = "cache"
classifyDecorator "contextmanager"    = "context"
classifyDecorator "contextlib.contextmanager" = "context"
classifyDecorator "override"          = "override"
classifyDecorator "typing.override"   = "override"
classifyDecorator "pytest.fixture"    = "test"
classifyDecorator "pytest.mark.parametrize" = "test"
classifyDecorator _                   = "other"

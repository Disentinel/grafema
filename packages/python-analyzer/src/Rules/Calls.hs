{-# LANGUAGE OverloadedStrings #-}
-- | Call and expression rule: emits CALL, PROPERTY_ACCESS, REFERENCE nodes
-- for Python call expressions, attribute access, and name references.
--
-- Node types: CALL, PROPERTY_ACCESS, REFERENCE
-- Edge types: CONTAINS
--
-- Called from the Walker for expression-level analysis.
module Rules.Calls
  ( walkCalls
  , walkExpr
  ) where

import Data.Char (isUpper)
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import PythonAST
import Analysis.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , askFile
    , askScopeId
    , askNamedParent
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Span helpers ───────────────────────────────────────────────────────

spanLC :: Span -> (Int, Int)
spanLC sp = (posLine (spanStart sp), posCol (spanStart sp))

posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- ── Constructor detection ──────────────────────────────────────────────

-- | In Python, calls to names starting with an uppercase letter are
-- typically constructor calls (class instantiation).
isConstructor :: Text -> Bool
isConstructor name = case T.uncons name of
  Just (c, _) -> isUpper c
  Nothing     -> False

-- ── Name extraction from expressions ───────────────────────────────────

-- | Extract a human-readable name from an expression (for receiver, etc.).
exprToName :: PythonExpr -> Text
exprToName (NameExpr n _)        = n
exprToName (AttributeExpr _ a _) = a
exprToName _                     = "<expr>"

-- | Extract the receiver name from a call's function expression.
extractReceiver :: PythonExpr -> Maybe Text
extractReceiver (AttributeExpr val _ _) = Just (exprToName val)
extractReceiver (CallExpr func _ _ _)   = Just (exprToName func)
extractReceiver _                       = Nothing

-- | Extract the function name from a call expression's func field.
extractFuncName :: PythonExpr -> Text
extractFuncName (NameExpr n _)        = n
extractFuncName (AttributeExpr _ a _) = a
extractFuncName (CallExpr func _ _ _) = extractFuncName func
extractFuncName _                     = "<expr>"

-- ── Expression walker ──────────────────────────────────────────────────

-- | Walk a single Python expression, emitting graph nodes and edges.
-- Dispatches to specific handlers based on expression type.
walkExpr :: PythonExpr -> Analyzer ()

-- ── CALL node: function/method call ────────────────────────────────────

walkExpr (CallExpr func args keywords sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let funcName   = extractFuncName func
      mReceiver  = extractReceiver func
      (line, col) = spanLC sp
      hash       = posHash line col
      nodeId     = semanticId file "CALL" funcName parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CALL"
    , gnName      = funcName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("argCount",   MetaInt (length args))
        , ("kwargCount", MetaInt (length keywords))
        ]
        ++ [ ("receiver", MetaText recv) | Just recv <- [mReceiver] ]
        ++ [ ("kind", MetaText "constructor") | isConstructor funcName ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk sub-expressions: receiver (if attribute access), arguments, keyword values
  case func of
    AttributeExpr val _ _ -> walkExpr val
    CallExpr {}           -> walkExpr func
    _                     -> pure ()

  mapM_ walkExpr args
  mapM_ (\kw -> walkExpr (pkValue kw)) keywords

-- ── PROPERTY_ACCESS node: attribute access (not part of a call) ────────

walkExpr (AttributeExpr val attr sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let receiverName = exprToName val
      (line, col)  = spanLC sp
      hash         = posHash line col
      nodeId       = semanticId file "PROPERTY_ACCESS" attr parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "PROPERTY_ACCESS"
    , gnName      = attr
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("receiver", MetaText receiverName) ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk the base expression
  walkExpr val

-- ── REFERENCE node: name expression ────────────────────────────────────

walkExpr (NameExpr name sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let (line, col) = spanLC sp
      hash        = posHash line col
      nodeId      = semanticId file "REFERENCE" name parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "REFERENCE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.empty
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- ── Transparent expressions: walk children recursively ─────────────────

walkExpr (BoolOpExpr _ values _) =
  mapM_ walkExpr values

walkExpr (NamedExpr target value _) =
  walkExpr target >> walkExpr value

walkExpr (BinOpExpr left _ right _) =
  walkExpr left >> walkExpr right

walkExpr (UnaryOpExpr _ operand _) =
  walkExpr operand

walkExpr (LambdaExpr _ body _) =
  walkExpr body

walkExpr (IfExpr test body orelse _) =
  walkExpr test >> walkExpr body >> walkExpr orelse

walkExpr (DictExpr keys values _) = do
  mapM_ (mapM_ walkExpr) keys
  mapM_ walkExpr values

walkExpr (SetExpr elts _) =
  mapM_ walkExpr elts

walkExpr (ListCompExpr elt generators _) = do
  walkExpr elt
  mapM_ walkComprehension generators

walkExpr (SetCompExpr elt generators _) = do
  walkExpr elt
  mapM_ walkComprehension generators

walkExpr (DictCompExpr key value generators _) = do
  walkExpr key
  walkExpr value
  mapM_ walkComprehension generators

walkExpr (GeneratorExpr elt generators _) = do
  walkExpr elt
  mapM_ walkComprehension generators

walkExpr (AwaitExpr value _) =
  walkExpr value

walkExpr (YieldExpr mValue _) =
  mapM_ walkExpr mValue

walkExpr (YieldFromExpr value _) =
  walkExpr value

walkExpr (CompareExpr left _ comparators _) = do
  walkExpr left
  mapM_ walkExpr comparators

walkExpr (FormattedValueExpr value _ mFmt _) = do
  walkExpr value
  mapM_ walkExpr mFmt

walkExpr (JoinedStrExpr values _) =
  mapM_ walkExpr values

walkExpr (SubscriptExpr value slice _) =
  walkExpr value >> walkExpr slice

walkExpr (StarredExpr value _) =
  walkExpr value

walkExpr (ListExpr elts _) =
  mapM_ walkExpr elts

walkExpr (TupleExpr elts _) =
  mapM_ walkExpr elts

walkExpr (SliceExpr mLower mUpper mStep _) = do
  mapM_ walkExpr mLower
  mapM_ walkExpr mUpper
  mapM_ walkExpr mStep

-- Leaf expressions: no sub-expressions to walk
walkExpr (ConstantExpr {}) = pure ()
walkExpr (ExprUnknown {})  = pure ()

-- ── Comprehension walker ───────────────────────────────────────────────

-- | Walk a comprehension generator (target, iter, ifs).
walkComprehension :: PythonComprehension -> Analyzer ()
walkComprehension comp = do
  walkExpr (pcTarget comp)
  walkExpr (pcIter comp)
  mapM_ walkExpr (pcIfs comp)

-- ── Alias for backward compatibility ───────────────────────────────────

-- | Walk a call expression — alias for walkExpr specialized to calls.
-- Kept for API compatibility with Walker.
walkCalls :: PythonExpr -> Analyzer ()
walkCalls = walkExpr

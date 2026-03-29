{-# LANGUAGE OverloadedStrings #-}
-- | Error flow rule: emits TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK nodes
-- and HAS_CATCH, HAS_FINALLY, HAS_BODY, CONTAINS edges for Python
-- try/except/finally statements. Also counts raise statements for
-- error_exit_count metadata on enclosing functions.
--
-- Handles these Python AST constructs:
--   * 'TryStmt'   -> TRY_BLOCK + CATCH_BLOCK(s) + FINALLY_BLOCK
--   * 'RaiseStmt' -> contributes to error_exit_count of enclosing function
--
-- Node types: TRY_BLOCK, CATCH_BLOCK, FINALLY_BLOCK, VARIABLE
-- Edge types: CONTAINS, HAS_CATCH, HAS_FINALLY, HAS_BODY
--
-- Called from the analysis walker for each statement.
module Rules.ErrorFlow
  ( walkErrorFlow
  , countRaises
  ) where

import Control.Monad (when, forM_)
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import PythonAST
    ( PythonStmt(..)
    , PythonExpr(..)
    , PythonExceptHandler(..)
    , Span(..)
    , Pos(..)
    )
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
    , askScopeId
    , askNamedParent
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Error flow walker ─────────────────────────────────────────────────

-- | Walk an error-related statement and emit TRY_BLOCK / CATCH_BLOCK /
-- FINALLY_BLOCK nodes with appropriate edges.
walkErrorFlow :: PythonStmt -> Analyzer ()

walkErrorFlow (TryStmt _body handlers orelse finalbody sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let hash = contentHash [("line", T.pack (show (posLine (spanStart sp))))]
      tryNodeId = semanticId file "TRY_BLOCK" "try" parent (Just hash)
      line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId        = tryNodeId
    , gnType      = "TRY_BLOCK"
    , gnName      = "try"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("handler_count", MetaInt (length handlers))
        , ("has_else",      MetaBool (not (null orelse)))
        , ("has_finally",   MetaBool (not (null finalbody)))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = tryNodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Handlers (except clauses)
  forM_ (zip [0 :: Int ..] handlers) $ \(idx, handler) ->
    walkExceptHandler file tryNodeId parent hash idx handler

  -- Finally block
  when (not (null finalbody)) $ do
    let finallyHash = contentHash
          [ ("line", T.pack (show line))
          , ("kind", "finally")
          ]
        finallyId = semanticId file "FINALLY_BLOCK" "finally" parent (Just finallyHash)
        -- Use span of the try statement since we don't have separate finally span
    emitNode GraphNode
      { gnId        = finallyId
      , gnType      = "FINALLY_BLOCK"
      , gnName      = "finally"
      , gnFile      = file
      , gnLine      = line
      , gnColumn    = col
      , gnEndLine   = posLine (spanEnd sp)
      , gnEndColumn = posCol  (spanEnd sp)
      , gnExported  = False
      , gnMetadata  = Map.empty
      }

    emitEdge GraphEdge
      { geSource   = tryNodeId
      , geTarget   = finallyId
      , geType     = "HAS_FINALLY"
      , geMetadata = Map.empty
      }

walkErrorFlow _ = pure ()

-- ── Except handler walker ─────────────────────────────────────────────

-- | Walk a single except handler, emitting CATCH_BLOCK node + HAS_CATCH edge.
walkExceptHandler :: Text -> Text -> Maybe Text -> Text -> Int -> PythonExceptHandler -> Analyzer ()
walkExceptHandler file tryNodeId parent _tryHash idx handler = do
  let hsp = pehSpan handler
      handlerHash = contentHash
        [ ("line", T.pack (show (posLine (spanStart hsp))))
        , ("idx",  T.pack (show idx))
        ]
      catchId = semanticId file "CATCH_BLOCK" catchName parent (Just handlerHash)
      catchName = case pehType handler of
        Just expr -> extractExceptionTypeName expr
        Nothing   -> "bare"

  emitNode GraphNode
    { gnId        = catchId
    , gnType      = "CATCH_BLOCK"
    , gnName      = catchName
    , gnFile      = file
    , gnLine      = posLine (spanStart hsp)
    , gnColumn    = posCol  (spanStart hsp)
    , gnEndLine   = posLine (spanEnd hsp)
    , gnEndColumn = posCol  (spanEnd hsp)
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("exception_type", MetaText catchName) ] ++
        [ ("exception_variable", MetaText n) | Just n <- [pehName handler] ]
    }

  emitEdge GraphEdge
    { geSource   = tryNodeId
    , geTarget   = catchId
    , geType     = "HAS_CATCH"
    , geMetadata = Map.empty
    }

-- ── Pure raise counter ────────────────────────────────────────────────

-- | Count the number of raise statements in a list of statements (pure).
-- Used to compute the @error_exit_count@ metadata for FUNCTION nodes.
countRaises :: [PythonStmt] -> Int
countRaises = sum . map countInStmt
  where
    countInStmt :: PythonStmt -> Int
    countInStmt (RaiseStmt _ _ _)                  = 1
    countInStmt (IfStmt _ body els _)              = countRaises body + countRaises els
    countInStmt (ForStmt _ _ body els _ _)         = countRaises body + countRaises els
    countInStmt (WhileStmt _ body els _)           = countRaises body + countRaises els
    countInStmt (TryStmt body handlers els fin _)  =
      countRaises body
      + sum (map (countRaises . pehBody) handlers)
      + countRaises els
      + countRaises fin
    countInStmt (WithStmt _ body _ _)              = countRaises body
    countInStmt _                                  = 0

-- ── Helpers ───────────────────────────────────────────────────────────

-- | Extract exception type name from an expression.
-- Handles: NameExpr "ValueError", AttributeExpr for module.Error,
-- TupleExpr for multi-except, CallExpr for except SomeError(...).
extractExceptionTypeName :: PythonExpr -> Text
extractExceptionTypeName (NameExpr name _)         = name
extractExceptionTypeName (AttributeExpr val attr _) =
  extractExceptionTypeName val <> "." <> attr
extractExceptionTypeName (TupleExpr elts _)         =
  T.intercalate "|" (map extractExceptionTypeName elts)
extractExceptionTypeName (CallExpr func _ _ _)      =
  extractExceptionTypeName func
extractExceptionTypeName _                          = "<unknown>"

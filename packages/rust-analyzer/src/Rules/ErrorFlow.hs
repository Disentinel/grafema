{-# LANGUAGE OverloadedStrings #-}
-- | Phase 11 rule: error flow -- ? operator propagation.
--
-- Tracks error propagation via the @?@ operator in Rust.
--
-- Handles these constructs:
--   * 'ExprTry' (the @?@ operator) -> ERROR_PROPAGATES edge from
--     the @?@ usage site to the enclosing function
--
-- Emits:
--   * ERROR_PROPAGATES edges (from ? site to enclosing function)
--   * @error_exit_count@ metadata on FUNCTION nodes (count of @?@ in body)
--
-- CRITICAL: @?@ inside a closure does NOT propagate to the outer function.
-- The 'ExprClosure' case stops recursion, because closures have their own
-- error-propagation scope.
--
-- Called from 'Rules.Declarations' for function bodies.
module Rules.ErrorFlow
  ( walkErrorFlow
  , countErrorExits
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import RustAST
import Analysis.Types (GraphEdge(..), MetaValue(..))
import Analysis.Context
    ( Analyzer
    , emitEdge
    , askFile
    , askEnclosingFn
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Error flow edge walker ──────────────────────────────────────────

-- | Walk an expression tree looking for 'ExprTry' (the @?@ operator)
-- and emit ERROR_PROPAGATES edges from the @?@ usage site to the
-- enclosing function.
--
-- CRITICAL: @?@ in a closure does NOT propagate to the outer function.
-- Closures have their own error-propagation scope, so 'ExprClosure'
-- returns @pure ()@ without recursing.
walkErrorFlow :: RustExpr -> Analyzer ()

-- ── ExprTry: the ? operator ─────────────────────────────────────────

walkErrorFlow (ExprTry expr sp) = do
  file <- askFile
  encFn <- askEnclosingFn
  case encFn of
    Just fnId -> do
      let line = posLine (spanStart sp)
          col  = posCol (spanStart sp)
          hash = contentHash [("line", T.pack (show line)), ("col", T.pack (show col))]
          -- Transient ID for the ? location
          tryId = semanticId file "CALL" "?" Nothing (Just hash)
      emitEdge GraphEdge
        { geSource   = tryId
        , geTarget   = fnId
        , geType     = "ERROR_PROPAGATES"
        , geMetadata = Map.fromList [("line", MetaInt line), ("col", MetaInt col)]
        }
    Nothing -> pure ()  -- ? outside function (shouldn't happen but be safe)
  -- Recurse into the inner expression
  walkErrorFlow expr

-- ── Closure: stops error propagation ────────────────────────────────

walkErrorFlow (ExprClosure _ _ _ _ _) = pure ()  -- ? in closure does NOT propagate to outer fn

-- ── Transparent expressions: recurse into children ──────────────────

walkErrorFlow (ExprCall func args _) =
  walkErrorFlow func >> mapM_ walkErrorFlow args

walkErrorFlow (ExprMethodCall recv _ args _) =
  walkErrorFlow recv >> mapM_ walkErrorFlow args

walkErrorFlow (ExprBinary left _ right _) =
  walkErrorFlow left >> walkErrorFlow right

walkErrorFlow (ExprUnary _ expr _) =
  walkErrorFlow expr

walkErrorFlow (ExprIf cond thenBlock mElse _) =
  walkErrorFlow cond >> walkBlockEF thenBlock >> mapM_ walkErrorFlow mElse

walkErrorFlow (ExprMatch expr arms _) =
  walkErrorFlow expr >> mapM_ (walkErrorFlow . raBody) arms

walkErrorFlow (ExprBlock stmts _) =
  mapM_ walkStmtEF stmts

walkErrorFlow (ExprAssign left right _) =
  walkErrorFlow left >> walkErrorFlow right

walkErrorFlow (ExprField base _ _) =
  walkErrorFlow base

walkErrorFlow (ExprIndex expr idx _) =
  walkErrorFlow expr >> walkErrorFlow idx

walkErrorFlow (ExprAwait expr _) =
  walkErrorFlow expr

walkErrorFlow (ExprCast expr _ _) =
  walkErrorFlow expr

walkErrorFlow (ExprTuple elems _) =
  mapM_ walkErrorFlow elems

walkErrorFlow (ExprArray elems _) =
  mapM_ walkErrorFlow elems

walkErrorFlow (ExprUnsafe blk _) =
  walkBlockEF blk

walkErrorFlow (ExprAsync _ blk _) =
  walkBlockEF blk

walkErrorFlow (ExprReturn mExpr _) =
  mapM_ walkErrorFlow mExpr

walkErrorFlow (ExprBreak mExpr _ _) =
  mapM_ walkErrorFlow mExpr

walkErrorFlow (ExprRange mStart mEnd _) =
  mapM_ walkErrorFlow mStart >> mapM_ walkErrorFlow mEnd

walkErrorFlow (ExprStruct _ fields mRest _) =
  mapM_ (walkErrorFlow . snd) fields >> mapM_ walkErrorFlow mRest

walkErrorFlow (ExprLet _ expr _) =
  walkErrorFlow expr

walkErrorFlow (ExprReference expr _ _) =
  walkErrorFlow expr

walkErrorFlow (ExprLoop body _ _) =
  walkBlockEF body

walkErrorFlow (ExprWhile cond body _ _) =
  walkErrorFlow cond >> walkBlockEF body

walkErrorFlow (ExprForLoop _ expr body _ _) =
  walkErrorFlow expr >> walkBlockEF body

-- ── Terminal expressions: no children ───────────────────────────────

walkErrorFlow (ExprPath _ _) = pure ()
walkErrorFlow (ExprLit _ _) = pure ()
walkErrorFlow (ExprContinue _ _) = pure ()
walkErrorFlow (ExprUnknown _) = pure ()

-- ── Block & statement helpers ───────────────────────────────────────

-- | Walk all statements in a block for error flow.
walkBlockEF :: RustBlock -> Analyzer ()
walkBlockEF (RustBlock stmts) = mapM_ walkStmtEF stmts

-- | Walk a single statement for error flow.
walkStmtEF :: RustStmt -> Analyzer ()
walkStmtEF (StmtExpr expr) = walkErrorFlow expr
walkStmtEF (StmtSemi expr) = walkErrorFlow expr
walkStmtEF (StmtLocal _ mInit _) = mapM_ walkErrorFlow mInit
walkStmtEF (StmtItem _) = pure ()
walkStmtEF (StmtMacro _) = pure ()

-- ── Pure ? counter ──────────────────────────────────────────────────

-- | Count the number of @?@ operators in a function body (pure).
--
-- Used to compute the @error_exit_count@ metadata for FUNCTION nodes.
-- This is a pure function that walks the AST without monadic context.
--
-- CRITICAL: @?@ inside closures are NOT counted, because closures
-- have their own error-propagation scope.
countErrorExits :: RustBlock -> Int
countErrorExits (RustBlock stmts) = sum (map countStmt stmts)
  where
    countStmt :: RustStmt -> Int
    countStmt (StmtExpr e)      = countExpr e
    countStmt (StmtSemi e)      = countExpr e
    countStmt (StmtLocal _ mi _) = maybe 0 countExpr mi
    countStmt (StmtItem _)      = 0
    countStmt (StmtMacro _)     = 0

    countExpr :: RustExpr -> Int
    countExpr (ExprTry e _)              = 1 + countExpr e
    countExpr (ExprClosure _ _ _ _ _)    = 0  -- don't count ? inside closures
    countExpr (ExprCall f args _)        = countExpr f + sum (map countExpr args)
    countExpr (ExprMethodCall r _ args _) = countExpr r + sum (map countExpr args)
    countExpr (ExprBinary l _ r _)       = countExpr l + countExpr r
    countExpr (ExprUnary _ e _)          = countExpr e
    countExpr (ExprIf c t me _)          = countExpr c + countBlock t + maybe 0 countExpr me
    countExpr (ExprMatch e arms _)       = countExpr e + sum (map (countExpr . raBody) arms)
    countExpr (ExprBlock stmts' _)       = sum (map countStmt stmts')
    countExpr (ExprAssign l r _)         = countExpr l + countExpr r
    countExpr (ExprField b _ _)          = countExpr b
    countExpr (ExprIndex e i _)          = countExpr e + countExpr i
    countExpr (ExprAwait e _)            = countExpr e
    countExpr (ExprCast e _ _)           = countExpr e
    countExpr (ExprTuple es _)           = sum (map countExpr es)
    countExpr (ExprArray es _)           = sum (map countExpr es)
    countExpr (ExprUnsafe blk _)         = countBlock blk
    countExpr (ExprAsync _ blk _)        = countBlock blk
    countExpr (ExprReturn me _)          = maybe 0 countExpr me
    countExpr (ExprBreak me _ _)         = maybe 0 countExpr me
    countExpr (ExprRange ms me _)        = maybe 0 countExpr ms + maybe 0 countExpr me
    countExpr (ExprStruct _ flds mr _)   = sum (map (countExpr . snd) flds) + maybe 0 countExpr mr
    countExpr (ExprLet _ e _)            = countExpr e
    countExpr (ExprReference e _ _)      = countExpr e
    countExpr (ExprLoop body _ _)        = countBlock body
    countExpr (ExprWhile c body _ _)     = countExpr c + countBlock body
    countExpr (ExprForLoop _ e body _ _) = countExpr e + countBlock body
    countExpr _                          = 0  -- terminal: Path, Lit, Continue, Unknown

    countBlock :: RustBlock -> Int
    countBlock (RustBlock ss) = sum (map countStmt ss)

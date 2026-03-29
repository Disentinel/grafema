{-# LANGUAGE OverloadedStrings #-}
-- | Error flow rule: THROWS edges and throw statement tracking.
--
-- Tracks error flow in Java:
--   * @throws@ declarations -> THROWS_DECLARED edge metadata
--   * @throw@ statements    -> THROWS edge from throw site to enclosing method
--   * Error exit counting   -> @error_exit_count@ metadata on FUNCTION nodes
--
-- CRITICAL: @throw@ inside a lambda does NOT propagate to the outer method.
-- Lambdas have their own error-propagation scope.
--
-- Called from 'Rules.Declarations' for method/constructor bodies.
module Rules.ErrorFlow
  ( walkErrorFlow
  , walkErrorFlowStmt
  , countThrows
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import JavaAST
import Analysis.Types (GraphEdge(..), MetaValue(..))
import Analysis.Context
    ( Analyzer
    , emitEdge
    , askFile
    , askEnclosingFn
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Error flow edge walker ─────────────────────────────────────────────

-- | Walk an expression tree looking for throw-related constructs.
walkErrorFlow :: JavaExpr -> Analyzer ()

-- Method call: walk args and scope
walkErrorFlow (MethodCallExpr _ mScope args _ _) = do
  mapM_ walkErrorFlow mScope
  mapM_ walkErrorFlow args

-- Constructor call: walk args
walkErrorFlow (ObjectCreationExpr _ args _ _ _) =
  mapM_ walkErrorFlow args

-- Field access: walk scope
walkErrorFlow (FieldAccessExpr scope _ _) =
  walkErrorFlow scope

-- Array access: walk both
walkErrorFlow (ArrayAccessExpr arr idx _) =
  walkErrorFlow arr >> walkErrorFlow idx

-- Assign: walk both sides
walkErrorFlow (AssignExpr target _ value _) =
  walkErrorFlow target >> walkErrorFlow value

-- Binary: walk both sides
walkErrorFlow (BinaryExpr left _ right _) =
  walkErrorFlow left >> walkErrorFlow right

-- Unary: walk operand
walkErrorFlow (UnaryExpr _ _ expr _) =
  walkErrorFlow expr

-- Conditional: walk all three parts
walkErrorFlow (ConditionalExpr cond thenE elseE _) =
  walkErrorFlow cond >> walkErrorFlow thenE >> walkErrorFlow elseE

-- Cast: walk inner
walkErrorFlow (CastExpr _ expr _) =
  walkErrorFlow expr

-- InstanceOf: walk expr
walkErrorFlow (InstanceOfExpr expr _ mPat _) =
  walkErrorFlow expr >> mapM_ walkErrorFlow mPat

-- Lambda: STOP -- lambdas have their own error scope
walkErrorFlow (LambdaExpr _ _ _ _) = pure ()
walkErrorFlow (LambdaBlockExpr _ _ _) = pure ()

-- Method ref: walk scope
walkErrorFlow (MethodRefExpr scope _ _) =
  walkErrorFlow scope

-- Enclosed: walk inner
walkErrorFlow (EnclosedExpr inner _) =
  walkErrorFlow inner

-- Array creation: walk dimensions and init
walkErrorFlow (ArrayCreationExpr _ dims mInit _) = do
  mapM_ (mapM_ walkErrorFlow) dims
  mapM_ walkErrorFlow mInit

-- Array init: walk values
walkErrorFlow (ArrayInitExpr values _) =
  mapM_ walkErrorFlow values

-- Switch expr: walk selector
walkErrorFlow (SwitchExpr sel _ _) =
  walkErrorFlow sel

-- VarDecl expr: skip (handled at stmt level)
walkErrorFlow (VarDeclExpr _ _ _) = pure ()

-- Terminal expressions: nothing to do
walkErrorFlow (NameExpr _ _)      = pure ()
walkErrorFlow (LiteralExpr _ _ _) = pure ()
walkErrorFlow (ThisExpr _ _)      = pure ()
walkErrorFlow (SuperExpr _ _)     = pure ()
walkErrorFlow (TextBlockExpr _ _) = pure ()
walkErrorFlow (ClassExpr _ _)     = pure ()
walkErrorFlow (PatternExpr _ _ _) = pure ()
walkErrorFlow (ExprUnknown _)     = pure ()

-- ── Statement-level error flow ─────────────────────────────────────────

-- | Walk a statement for throw tracking. Emits THROWS edges from throw
-- sites to the enclosing function.
walkErrorFlowStmt :: JavaStmt -> Analyzer ()

walkErrorFlowStmt (ThrowStmt expr sp) = do
  file  <- askFile
  encFn <- askEnclosingFn
  case encFn of
    Just fnId -> do
      let line = posLine (spanStart sp)
          col  = posCol  (spanStart sp)
          hash = contentHash [("line", T.pack (show line)), ("col", T.pack (show col))]
          throwId = semanticId file "CALL" "throw" Nothing (Just hash)
      emitEdge GraphEdge
        { geSource   = throwId
        , geTarget   = fnId
        , geType     = "THROWS"
        , geMetadata = Map.fromList
            [ ("line", MetaInt line)
            , ("col",  MetaInt col)
            ]
        }
    Nothing -> pure ()
  walkErrorFlow expr

walkErrorFlowStmt (ExprStmt expr _) =
  walkErrorFlow expr

walkErrorFlowStmt (BlockStmt stmts _) =
  mapM_ walkErrorFlowStmt stmts

walkErrorFlowStmt (ReturnStmt mExpr _) =
  mapM_ walkErrorFlow mExpr

walkErrorFlowStmt (IfStmt cond thenStmt mElse _) = do
  walkErrorFlow cond
  walkErrorFlowStmt thenStmt
  mapM_ walkErrorFlowStmt mElse

walkErrorFlowStmt (SwitchStmt sel entries _) = do
  walkErrorFlow sel
  mapM_ (\e -> mapM_ walkErrorFlowStmt (jseStmts e)) entries

walkErrorFlowStmt (WhileStmt cond body _) =
  walkErrorFlow cond >> walkErrorFlowStmt body

walkErrorFlowStmt (DoStmt cond body _) =
  walkErrorFlow cond >> walkErrorFlowStmt body

walkErrorFlowStmt (ForStmt inits mCond updates body _) = do
  mapM_ walkErrorFlow inits
  mapM_ walkErrorFlow mCond
  mapM_ walkErrorFlow updates
  walkErrorFlowStmt body

walkErrorFlowStmt (ForEachStmt _ iter body _) =
  walkErrorFlow iter >> walkErrorFlowStmt body

walkErrorFlowStmt (TryStmt resources tryBlock catches mFinally _) = do
  mapM_ walkErrorFlow resources
  walkErrorFlowStmt tryBlock
  mapM_ (walkErrorFlowStmt . jccBody) catches
  mapM_ walkErrorFlowStmt mFinally

walkErrorFlowStmt (SynchronizedStmt expr body _) =
  walkErrorFlow expr >> walkErrorFlowStmt body

walkErrorFlowStmt (LabeledStmt _ stmt _) =
  walkErrorFlowStmt stmt

walkErrorFlowStmt (AssertStmt check mMsg _) = do
  walkErrorFlow check
  mapM_ walkErrorFlow mMsg

walkErrorFlowStmt (YieldStmt expr _) =
  walkErrorFlow expr

walkErrorFlowStmt (VarDeclStmt _ vars _) =
  mapM_ (\v -> mapM_ walkErrorFlow (jvInit v)) vars

walkErrorFlowStmt (ExplicitCtorInvStmt _ args mExpr _) = do
  mapM_ walkErrorFlow args
  mapM_ walkErrorFlow mExpr

walkErrorFlowStmt _ = pure ()

-- ── Pure throw counter ─────────────────────────────────────────────────

-- | Count the number of throw statements in a method body (pure).
--
-- Used to compute the @error_exit_count@ metadata for FUNCTION nodes.
--
-- CRITICAL: @throw@ inside lambdas is NOT counted, because lambdas
-- have their own error-propagation scope.
countThrows :: JavaStmt -> Int
countThrows (ThrowStmt _ _) = 1
countThrows (ExprStmt _ _)  = 0
countThrows (BlockStmt stmts _) = sum (map countThrows stmts)
countThrows (ReturnStmt _ _) = 0
countThrows (IfStmt _ thenStmt mElse _) =
  countThrows thenStmt + maybe 0 countThrows mElse
countThrows (SwitchStmt _ entries _) =
  sum (map (\e -> sum (map countThrows (jseStmts e))) entries)
countThrows (WhileStmt _ body _) = countThrows body
countThrows (DoStmt _ body _) = countThrows body
countThrows (ForStmt _ _ _ body _) = countThrows body
countThrows (ForEachStmt _ _ body _) = countThrows body
countThrows (TryStmt _ tryBlock catches mFinally _) =
  countThrows tryBlock
  + sum (map (countThrows . jccBody) catches)
  + maybe 0 countThrows mFinally
countThrows (SynchronizedStmt _ body _) = countThrows body
countThrows (LabeledStmt _ stmt _) = countThrows stmt
countThrows _ = 0

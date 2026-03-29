{-# LANGUAGE OverloadedStrings #-}
-- | Error flow rule for Kotlin.
--
-- Tracks throw statements and error propagation.
-- No checked exceptions in Kotlin (unlike Java).
-- Lambdas have their own error scope (throws inside lambdas
-- don't propagate to the outer function).
module Rules.ErrorFlow
  ( walkErrorFlow
  , walkErrorFlowStmt
  , countThrows
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import KotlinAST
import Analysis.Types (GraphEdge(..), MetaValue(..))
import Analysis.Context
    ( Analyzer
    , emitEdge
    , askFile
    , askEnclosingFn
    )
import Grafema.SemanticId (semanticId, contentHash)

-- Expression-level error flow walker

walkErrorFlow :: KotlinExpr -> Analyzer ()

walkErrorFlow (CallExpr _ mScope args _ _) = do
  mapM_ walkErrorFlow mScope
  mapM_ walkErrorFlow args

walkErrorFlow (SafeCallExpr scope _ args _) =
  walkErrorFlow scope >> mapM_ walkErrorFlow args

walkErrorFlow (ObjectCreationExpr _ args _ _) =
  mapM_ walkErrorFlow args

walkErrorFlow (PropertyAccessExpr scope _ _) =
  walkErrorFlow scope

walkErrorFlow (AssignExpr target _ value _) =
  walkErrorFlow target >> walkErrorFlow value

walkErrorFlow (BinaryExpr left _ right _) =
  walkErrorFlow left >> walkErrorFlow right

walkErrorFlow (UnaryExpr _ _ expr _) =
  walkErrorFlow expr

walkErrorFlow (ElvisExpr left right _) =
  walkErrorFlow left >> walkErrorFlow right

walkErrorFlow (NotNullAssertExpr expr _) =
  walkErrorFlow expr

walkErrorFlow (IsExpr expr _ _ _) =
  walkErrorFlow expr

walkErrorFlow (AsExpr expr _ _ _) =
  walkErrorFlow expr

walkErrorFlow (IfExpr cond thenE mElseE _) = do
  walkErrorFlow cond
  walkErrorFlow thenE
  mapM_ walkErrorFlow mElseE

walkErrorFlow (WhenExpr mSubject entries _) = do
  mapM_ walkErrorFlow mSubject
  mapM_ (\e -> do
    mapM_ walkErrorFlow (kweConditions e)
    walkErrorFlowStmt (kweBody e)
    ) entries

walkErrorFlow (RangeExpr left right _ _) =
  walkErrorFlow left >> walkErrorFlow right

walkErrorFlow (DestructuringDecl _ initExpr _) =
  walkErrorFlow initExpr

walkErrorFlow (EnclosedExpr inner _) =
  walkErrorFlow inner

walkErrorFlow (StringTemplateExpr parts _) =
  mapM_ walkErrorFlow parts

walkErrorFlow (StringExprPart expr _) =
  walkErrorFlow expr

-- Lambda: STOP -- lambdas have their own error scope
walkErrorFlow (LambdaExpr _ _ _) = pure ()

-- Terminal expressions
walkErrorFlow (NameExpr _ _)           = pure ()
walkErrorFlow (LiteralExpr _ _ _)      = pure ()
walkErrorFlow (ThisExpr _ _)           = pure ()
walkErrorFlow (SuperExpr _ _ _)        = pure ()
walkErrorFlow (StringLiteralPart _ _)  = pure ()
walkErrorFlow (ExprUnknown _)          = pure ()

-- Statement-level error flow

walkErrorFlowStmt :: KotlinStmt -> Analyzer ()

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

walkErrorFlowStmt (ReturnStmt mExpr _ _) =
  mapM_ walkErrorFlow mExpr

walkErrorFlowStmt (IfStmt cond thenStmt mElse _) = do
  walkErrorFlow cond
  walkErrorFlowStmt thenStmt
  mapM_ walkErrorFlowStmt mElse

walkErrorFlowStmt (WhenStmt mSubject entries _) = do
  mapM_ walkErrorFlow mSubject
  mapM_ (\e -> walkErrorFlowStmt (kweBody e)) entries

walkErrorFlowStmt (WhileStmt cond body _) =
  walkErrorFlow cond >> walkErrorFlowStmt body

walkErrorFlowStmt (DoWhileStmt cond body _) =
  walkErrorFlow cond >> walkErrorFlowStmt body

walkErrorFlowStmt (ForStmt _ iter body _) =
  walkErrorFlow iter >> walkErrorFlowStmt body

walkErrorFlowStmt (TryStmt tryBlock catches mFinally _) = do
  walkErrorFlowStmt tryBlock
  mapM_ (walkErrorFlowStmt . kccBody) catches
  mapM_ walkErrorFlowStmt mFinally

walkErrorFlowStmt (VarDeclStmt _ vars _) =
  mapM_ (\v -> mapM_ walkErrorFlow (kvInit v)) vars

walkErrorFlowStmt _ = pure ()

-- Pure throw counter

-- | Count throw statements in a function body (pure).
-- Throws inside lambdas are NOT counted.
countThrows :: KotlinStmt -> Int
countThrows (ThrowStmt _ _) = 1
countThrows (ExprStmt _ _)  = 0
countThrows (BlockStmt stmts _) = sum (map countThrows stmts)
countThrows (ReturnStmt _ _ _) = 0
countThrows (IfStmt _ thenStmt mElse _) =
  countThrows thenStmt + maybe 0 countThrows mElse
countThrows (WhenStmt _ entries _) =
  sum (map (countThrows . kweBody) entries)
countThrows (WhileStmt _ body _) = countThrows body
countThrows (DoWhileStmt _ body _) = countThrows body
countThrows (ForStmt _ _ body _) = countThrows body
countThrows (TryStmt tryBlock catches mFinally _) =
  countThrows tryBlock
  + sum (map (countThrows . kccBody) catches)
  + maybe 0 countThrows mFinally
countThrows _ = 0

{-# LANGUAGE OverloadedStrings #-}
-- Rules for statement nodes: return, throw, if, switch, loops, try/catch
module Rules.Statements
  ( ruleReturnStatement
  , ruleThrowStatement
  , ruleIfStatement
  , ruleSwitchStatement
  , ruleSwitchCase
  , ruleForStatement
  , ruleForInOfStatement
  , ruleWhileStatement
  , ruleTryStatement
  , ruleBlockStatement
  , ruleExpressionStatement
  , ruleCatchClause
  ) where

import qualified Data.Map.Strict as Map
import Data.Foldable (forM_)
import Data.Text (Text)
import qualified Data.Text as T
import Analysis.Types
import Analysis.Context (Analyzer, askFile, askEnclosingFn, askNamedParent, askScopeId, emitNode, emitEdge, withAncestor)
import {-# SOURCE #-} Analysis.Walker (walkNode)
import Analysis.Scope (withScope, declareInScope)
import Analysis.SemanticId (semanticId, contentHash)
import AST.Types
import AST.Span (Span(..))

-- ── Return Statement ────────────────────────────────────────────────────

ruleReturnStatement :: ASTNode -> Analyzer (Maybe Text)
ruleReturnStatement node = do
  encFn <- askEnclosingFn
  mChildId <- case getChildrenMaybe "argument" node of
    Just arg -> withAncestor node (walkNode arg)
    Nothing  -> return Nothing
  case encFn of
    Just fnId ->
      forM_ mChildId $ \childId ->
        emitEdge GraphEdge
          { geSource = fnId, geTarget = childId
          , geType = "RETURNS", geMetadata = Map.empty
          }
    Nothing -> return ()
  return Nothing

-- ── Throw Statement ─────────────────────────────────────────────────────

ruleThrowStatement :: ASTNode -> Analyzer (Maybe Text)
ruleThrowStatement node = do
  encFn <- askEnclosingFn
  mChildId <- case getChildrenMaybe "argument" node of
    Just arg -> withAncestor node (walkNode arg)
    Nothing  -> return Nothing
  case encFn of
    Just fnId ->
      forM_ mChildId $ \childId ->
        emitEdge GraphEdge
          { geSource = fnId, geTarget = childId
          , geType = "THROWS", geMetadata = Map.empty
          }
    Nothing -> return ()
  return Nothing

-- ── If Statement ────────────────────────────────────────────────────────

ruleIfStatement :: ASTNode -> Analyzer (Maybe Text)
ruleIfStatement node = do
  file <- askFile
  parent <- askNamedParent
  let sp = astNodeSpan node
      hash = contentHash [("k", "if"), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "BRANCH" "if" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "BRANCH", gnName = "if"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  case getChildrenMaybe "test" node of
    Just test -> do
      mTestId <- withAncestor node (walkNode test)
      forM_ mTestId $ \testId ->
        emitEdge GraphEdge { geSource = nodeId, geTarget = testId, geType = "HAS_CONDITION", geMetadata = Map.empty }
    Nothing -> return ()
  case getChildrenMaybe "consequent" node of
    Just cons -> do
      mConsId <- withAncestor node (walkNode cons)
      forM_ mConsId $ \consId ->
        emitEdge GraphEdge { geSource = nodeId, geTarget = consId, geType = "HAS_CONSEQUENT", geMetadata = Map.empty }
    Nothing -> return ()
  case getChildrenMaybe "alternate" node of
    Just alt -> do
      mAltId <- withAncestor node (walkNode alt)
      forM_ mAltId $ \altId ->
        emitEdge GraphEdge { geSource = nodeId, geTarget = altId, geType = "HAS_ALTERNATE", geMetadata = Map.empty }
    Nothing -> return ()
  return (Just nodeId)

-- ── Switch Statement ────────────────────────────────────────────────────

ruleSwitchStatement :: ASTNode -> Analyzer (Maybe Text)
ruleSwitchStatement node = do
  file <- askFile
  parent <- askNamedParent
  let sp = astNodeSpan node
      hash = contentHash [("k", "switch"), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "BRANCH" "switch" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "BRANCH", gnName = "switch"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  case getChildrenMaybe "discriminant" node of
    Just disc -> do
      mDiscId <- withAncestor node (walkNode disc)
      forM_ mDiscId $ \discId ->
        emitEdge GraphEdge { geSource = nodeId, geTarget = discId, geType = "HAS_CONDITION", geMetadata = Map.empty }
    Nothing -> return ()
  let cases = getChildren "cases" node
  mapM_ (\c -> withAncestor node (walkNode c)) cases
  return (Just nodeId)

-- ── Switch Case ──────────────────────────────────────────────────────────

ruleSwitchCase :: ASTNode -> Analyzer (Maybe Text)
ruleSwitchCase node = do
  file <- askFile
  parent <- askNamedParent
  let sp = astNodeSpan node
      testValue = case getChildrenMaybe "test" node of
        Just t  -> getTextFieldOr "value" (getTextFieldOr "name" "default" t) t
        Nothing -> "default"
      hash = contentHash [("t", testValue), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "CASE" "case" parent (Just hash)

  emitNode GraphNode
    { gnId = nodeId, gnType = "CASE", gnName = "case"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }

  -- Test (the case value, null for default)
  case getChildrenMaybe "test" node of
    Just test -> do
      mTestId <- withAncestor node (walkNode test)
      forM_ mTestId $ \testId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = testId
          , geType = "HAS_CONDITION", geMetadata = Map.empty
          }
    Nothing -> return ()  -- default case

  -- Walk consequent statements
  let stmts = getChildren "consequent" node
  mapM_ (\s -> withAncestor node (walkNode s)) stmts
  return (Just nodeId)

-- ── For Statement ───────────────────────────────────────────────────────

ruleForStatement :: ASTNode -> Analyzer (Maybe Text)
ruleForStatement node = do
  file <- askFile
  parent <- askNamedParent
  let sp     = astNodeSpan node
      hash   = contentHash [("k", "for"), ("line", T.pack (show (spanStart sp)))]
      loopId = semanticId file "LOOP" "for" parent (Just hash)
  emitNode GraphNode
    { gnId = loopId, gnType = "LOOP", gnName = "for"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.singleton "kind" (MetaText "for")
    }
  withScope BlockScope loopId $ do
    case getChildrenMaybe "init" node of
      Just ini -> do
        mIniId <- withAncestor node (walkNode ini)
        forM_ mIniId $ \iniId ->
          emitEdge GraphEdge { geSource = loopId, geTarget = iniId, geType = "HAS_INIT", geMetadata = Map.empty }
      Nothing -> return ()
    case getChildrenMaybe "test" node of
      Just test -> do
        mTestId <- withAncestor node (walkNode test)
        forM_ mTestId $ \testId ->
          emitEdge GraphEdge { geSource = loopId, geTarget = testId, geType = "HAS_CONDITION", geMetadata = Map.empty }
      Nothing -> return ()
    case getChildrenMaybe "update" node of
      Just upd -> do
        mUpdId <- withAncestor node (walkNode upd)
        forM_ mUpdId $ \updId ->
          emitEdge GraphEdge { geSource = loopId, geTarget = updId, geType = "HAS_UPDATE", geMetadata = Map.empty }
      Nothing -> return ()
    case getChildrenMaybe "body" node of
      Just body -> withAncestor node (walkNode body) >> return ()
      Nothing -> return ()
  return (Just loopId)

-- | ForIn and ForOf statements
ruleForInOfStatement :: ASTNode -> Analyzer (Maybe Text)
ruleForInOfStatement node = do
  file <- askFile
  parent <- askNamedParent
  let sp     = astNodeSpan node
      hash   = contentHash [("k", "for-in-of"), ("line", T.pack (show (spanStart sp)))]
      loopId = semanticId file "LOOP" "for-in-of" parent (Just hash)
  emitNode GraphNode
    { gnId = loopId, gnType = "LOOP", gnName = "for-in-of"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.singleton "kind" (MetaText "for-in-of")
    }
  withScope BlockScope loopId $ do
    case getChildrenMaybe "left" node of
      Just left -> withAncestor node (walkNode left) >> return ()
      Nothing   -> return ()
    case getChildrenMaybe "right" node of
      Just right -> do
        mRightId <- withAncestor node (walkNode right)
        forM_ mRightId $ \rightId ->
          emitEdge GraphEdge { geSource = loopId, geTarget = rightId, geType = "ITERATES_OVER", geMetadata = Map.empty }
      Nothing -> return ()
    case getChildrenMaybe "body" node of
      Just body -> withAncestor node (walkNode body) >> return ()
      Nothing -> return ()
  return (Just loopId)

-- ── While / DoWhile Statement ───────────────────────────────────────────

ruleWhileStatement :: ASTNode -> Analyzer (Maybe Text)
ruleWhileStatement node = do
  file <- askFile
  parent <- askNamedParent
  let sp     = astNodeSpan node
      hash   = contentHash [("k", "while"), ("line", T.pack (show (spanStart sp)))]
      loopId = semanticId file "LOOP" "while" parent (Just hash)
  emitNode GraphNode
    { gnId = loopId, gnType = "LOOP", gnName = "while"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.singleton "kind" (MetaText "while")
    }
  case getChildrenMaybe "test" node of
    Just test -> do
      mTestId <- withAncestor node (walkNode test)
      forM_ mTestId $ \testId ->
        emitEdge GraphEdge { geSource = loopId, geTarget = testId, geType = "HAS_CONDITION", geMetadata = Map.empty }
    Nothing -> return ()
  case getChildrenMaybe "body" node of
    Just body -> withAncestor node (walkNode body) >> return ()
    Nothing -> return ()
  return (Just loopId)

-- ── Try Statement ───────────────────────────────────────────────────────

ruleTryStatement :: ASTNode -> Analyzer (Maybe Text)
ruleTryStatement node = do
  file <- askFile
  parent <- askNamedParent
  let sp    = astNodeSpan node
      tryId = semanticId file "TRY_BLOCK" "try" parent Nothing
  emitNode GraphNode
    { gnId = tryId, gnType = "TRY_BLOCK", gnName = "try"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  case getChildrenMaybe "block" node of
    Just blk -> withAncestor node (walkNode blk) >> return ()
    Nothing -> return ()
  case getChildrenMaybe "handler" node of
    Just h -> do
      let hSp = astNodeSpan h
          catchId = semanticId file "CATCH_BLOCK" "catch" parent Nothing
      emitNode GraphNode
        { gnId = catchId, gnType = "CATCH_BLOCK", gnName = "catch"
        , gnFile = file, gnLine = spanStart hSp, gnColumn = 0
        , gnEndLine = spanEnd hSp, gnEndColumn = 0
        , gnExported = False, gnMetadata = Map.empty
        }
      emitEdge GraphEdge { geSource = tryId, geTarget = catchId, geType = "HAS_CATCH", geMetadata = Map.empty }
      withAncestor node (walkNode h) >> return ()
    Nothing -> return ()
  case getChildrenMaybe "finalizer" node of
    Just fin -> do
      let fSp = astNodeSpan fin
          finId = semanticId file "FINALLY_BLOCK" "finally" parent Nothing
      emitNode GraphNode
        { gnId = finId, gnType = "FINALLY_BLOCK", gnName = "finally"
        , gnFile = file, gnLine = spanStart fSp, gnColumn = 0
        , gnEndLine = spanEnd fSp, gnEndColumn = 0
        , gnExported = False, gnMetadata = Map.empty
        }
      emitEdge GraphEdge { geSource = tryId, geTarget = finId, geType = "HAS_FINALLY", geMetadata = Map.empty }
      withAncestor node (walkNode fin) >> return ()
    Nothing -> return ()
  return (Just tryId)

-- ── Block Statement ─────────────────────────────────────────────────────

ruleBlockStatement :: ASTNode -> Analyzer (Maybe Text)
ruleBlockStatement node = do
  let stmts = getChildren "body" node
  mapM_ (\s -> withAncestor node (walkNode s)) stmts
  return Nothing

-- ── Expression Statement ──────────────────────────────────────────────

ruleExpressionStatement :: ASTNode -> Analyzer (Maybe Text)
ruleExpressionStatement node = do
  case getChildrenMaybe "expression" node of
    Just expr -> withAncestor node (walkNode expr)
    Nothing   -> return Nothing

-- ── Catch Clause ──────────────────────────────────────────────────────

ruleCatchClause :: ASTNode -> Analyzer (Maybe Text)
ruleCatchClause node = do
  file <- askFile
  parent <- askNamedParent
  let mkCatchBody = case getChildrenMaybe "body" node of
        Just body -> withAncestor node (walkNode body) >> return ()
        Nothing   -> return ()
  case getChildrenMaybe "param" node of
    Just p -> do
      let pName = getTextFieldOr "name" "<catch>" p
          sp    = astNodeSpan p
          pId   = semanticId file "PARAMETER" pName parent Nothing
      emitNode GraphNode
        { gnId = pId, gnType = "PARAMETER", gnName = pName
        , gnFile = file, gnLine = spanStart sp, gnColumn = 0
        , gnEndLine = spanEnd sp, gnEndColumn = 0
        , gnExported = False
        , gnMetadata = Map.singleton "kind" (MetaText "catch")
        }
      withScope CatchScope pId $ do
        catchScopeId <- askScopeId
        emitEdge GraphEdge
          { geSource = catchScopeId, geTarget = pId
          , geType = "DECLARES", geMetadata = Map.empty
          }
        declareInScope (Declaration pId DeclCatch pName) mkCatchBody
    Nothing -> mkCatchBody
  return Nothing

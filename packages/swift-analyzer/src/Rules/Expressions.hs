{-# LANGUAGE OverloadedStrings #-}
-- | Expressions and statements rule for Swift.
--
-- Handles CALL, PROPERTY_ACCESS, CLOSURE nodes and their edges.
-- DeclStmt delegates back to Rules.Declarations (via hs-boot).
module Rules.Expressions (walkExpr, walkStmt) where

import qualified Data.Map.Strict as Map
import qualified Data.Text as T

import SwiftAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)
import {-# SOURCE #-} Rules.Declarations (walkDeclaration)
import Rules.ControlFlow (walkControlFlowStmt)
import Rules.ErrorFlow (walkErrorFlowStmt)

-- | Check if a condition is an optional binding (if let / guard let).
isOptBindingCond :: SwiftCondition -> Bool
isOptBindingCond (OptionalBindingCondition _ _ _ _) = True
isOptBindingCond _ = False

-- Span helpers

posHash :: Int -> Int -> T.Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- Walk expression, emitting CALL and PROPERTY_ACCESS nodes
walkExpr :: SwiftExpr -> Analyzer ()
walkExpr (CallExpr callee args trailingClosure sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let callName = extractCallName callee
      line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = posHash line col
      nodeId = semanticId file "CALL" callName parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "CALL", gnName = callName, gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("argCount", MetaInt (length args + (case trailingClosure of { Just _ -> 1; Nothing -> 0 })))
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  -- Walk argument expressions
  mapM_ (\(_, expr) -> walkExpr expr) args
  case trailingClosure of
    Just c -> walkExpr c
    Nothing -> return ()

walkExpr (MemberAccessExpr member mBase sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = posHash line col
      nodeId = semanticId file "PROPERTY_ACCESS" member parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "PROPERTY_ACCESS", gnName = member, gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList [("language", MetaText "swift")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  case mBase of
    Just base -> walkExpr base
    Nothing -> return ()

walkExpr (ClosureExpr _captures _params body sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = posHash line col
      nodeId = semanticId file "FUNCTION" "<closure>" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "FUNCTION", gnName = "<closure>", gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList [("kind", MetaText "closure"), ("language", MetaText "swift")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withEnclosingFn nodeId $ mapM_ walkStmt body

walkExpr (AwaitExpr expr _) = walkExpr expr
walkExpr (TryExpr expr _ _) = walkExpr expr
walkExpr (ForceUnwrapExpr expr _) = walkExpr expr
walkExpr (OptionalChainingExpr expr _) = walkExpr expr
walkExpr (InfixExpr left _ right _) = walkExpr left >> walkExpr right
walkExpr (PrefixExpr _ expr _) = walkExpr expr
walkExpr (PostfixExpr _ expr _) = walkExpr expr
walkExpr (TernaryExpr c t e _) = walkExpr c >> walkExpr t >> walkExpr e
walkExpr (AsExpr expr _ _ _) = walkExpr expr
walkExpr (IsExpr expr _ _) = walkExpr expr
walkExpr (TupleExpr elems _) = mapM_ (\(_, e) -> walkExpr e) elems
walkExpr (ArrayExpr elems _) = mapM_ walkExpr elems
walkExpr (DictExpr pairs _) = mapM_ (\(k, v') -> walkExpr k >> walkExpr v') pairs
walkExpr (SubscriptCallExpr callee args _) = do
  walkExpr callee
  mapM_ (\(_, e) -> walkExpr e) args
walkExpr (IfExpr conds body mElse sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = posHash line col
      nodeId = semanticId file "BRANCH" "if" parent (Just hash)
      hasOptBinding = any isOptBindingCond conds
  emitNode GraphNode
    { gnId = nodeId, gnType = "BRANCH", gnName = "if", gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList $
        [ ("kind", MetaText "if")
        , ("language", MetaText "swift")
        ] ++ [("optionalBinding", MetaBool True) | hasOptBinding]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  mapM_ walkStmt body
  case mElse of
    Just e -> walkStmt e
    Nothing -> return ()
walkExpr (SwitchExpr subj cases sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = posHash line col
      nodeId = semanticId file "BRANCH" "switch" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "BRANCH", gnName = "switch", gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "switch")
        , ("caseCount", MetaInt (length cases))
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  walkExpr subj
  mapM_ (\c -> mapM_ walkStmt (sscBody c)) cases
walkExpr _ = return ()  -- Literals, DeclRef, etc. -- no graph nodes

-- Walk statement
walkStmt :: SwiftStmt -> Analyzer ()
walkStmt stmt = do
  -- Emit control flow nodes (BRANCH, LOOP, SCOPE)
  walkControlFlowStmt stmt
  -- Emit error flow nodes (throw CALL, try-catch SCOPE)
  walkErrorFlowStmt stmt
  -- Recurse into children
  walkStmtChildren stmt

-- Recurse into child expressions and statements
walkStmtChildren :: SwiftStmt -> Analyzer ()
walkStmtChildren (IfStmt _conds body mElse _) = do
  mapM_ walkStmt body
  case mElse of
    Just e -> walkStmt e
    Nothing -> return ()
walkStmtChildren (GuardStmt _conds body _) = mapM_ walkStmt body
walkStmtChildren (ForInStmt _pat seq' body _ _) = walkExpr seq' >> mapM_ walkStmt body
walkStmtChildren (WhileStmt _conds body _) = mapM_ walkStmt body
walkStmtChildren (RepeatWhileStmt body cond _) = mapM_ walkStmt body >> walkExpr cond
walkStmtChildren (SwitchStmt subj cases _) = do
  walkExpr subj
  mapM_ (\c -> mapM_ walkStmt (sscBody c)) cases
walkStmtChildren (DoStmt body catches _) = do
  mapM_ walkStmt body
  mapM_ (\c -> mapM_ walkStmt (sccBody c)) catches
walkStmtChildren (ReturnStmt mExpr _) = case mExpr of Just e -> walkExpr e; Nothing -> return ()
walkStmtChildren (ThrowStmt mExpr _) = case mExpr of Just e -> walkExpr e; Nothing -> return ()
walkStmtChildren (DeferStmt body _) = mapM_ walkStmt body
walkStmtChildren (ExprStmt expr _) = walkExpr expr
walkStmtChildren (DeclStmt decl _) = walkDeclaration decl
walkStmtChildren _ = return ()

-- Extract call name from callee expression
extractCallName :: SwiftExpr -> T.Text
extractCallName (DeclRefExpr name _) = name
extractCallName (MemberAccessExpr member (Just base) _) =
  extractCallName base <> "." <> member
extractCallName (MemberAccessExpr member Nothing _) = "." <> member
extractCallName _ = "<call>"

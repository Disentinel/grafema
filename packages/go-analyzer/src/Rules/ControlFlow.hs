{-# LANGUAGE OverloadedStrings #-}
-- | Control flow and statement walker for Go.
--
-- Handles all Go statement types, emitting control flow nodes (BRANCH,
-- LOOP, CASE) and walking sub-expressions/statements.
--
-- Handles these Go statement types:
--   * 'BlockStmt'        -> walk child statements
--   * 'ReturnStmt'       -> walk result expressions
--   * 'IfStmt'           -> BRANCH node (kind=if)
--   * 'ForStmt'          -> LOOP node (kind=for)
--   * 'RangeStmt'        -> LOOP node (kind=range)
--   * 'SwitchStmt'       -> BRANCH node (kind=switch)
--   * 'TypeSwitchStmt'   -> BRANCH node (kind=type_switch)
--   * 'SelectStmt'       -> BRANCH node (kind=select)
--   * 'CaseClauseStmt'   -> CASE node
--   * 'CommClauseStmt'   -> walk comm + body
--   * 'GoStmtNode'       -> walk call expression
--   * 'DeferStmtNode'    -> walk call expression
--   * 'SendStmtNode'     -> walk chan + value expressions
--   * 'AssignStmtNode'   -> short var decl (:=) -> VARIABLE nodes; walk RHS
--   * 'ExprStmtNode'     -> walk expression
--   * 'DeclStmtNode'     -> walk declaration via Declarations
--   * 'IncDecStmtNode'   -> walk x
--   * 'LabeledStmtNode'  -> walk inner statement
--   * 'BranchStmtNode'   -> no-op
--   * 'EmptyStmtNode'    -> no-op
--   * 'StmtUnknown'      -> no-op
--
-- Node types: BRANCH, LOOP, CASE, VARIABLE
-- Edge types: CONTAINS, ASSIGNED_FROM
--
-- Called from 'Rules.Declarations' for function/method bodies.
module Rules.ControlFlow
  ( walkStmt
  , walkStmts
  ) where

import Data.Char (isUpper)
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GoAST
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
    , askEnclosingFn
    , withGoroutine
    , withDeferred
    )
import Grafema.SemanticId (semanticId, contentHash)
import Rules.Calls (walkExpr)
import {-# SOURCE #-} Rules.Declarations (walkDeclarations)

-- ── Span helpers ─────────────────────────────────────────────────────────

spanLC :: Span -> (Int, Int)
spanLC sp = (posLine (spanStart sp), posCol (spanStart sp))

posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- ── Name extraction ──────────────────────────────────────────────────────

-- | Extract the trailing name from a semantic ID.
extractName :: Text -> Maybe Text
extractName sid =
  case T.splitOn "->" sid of
    [] -> Nothing
    parts ->
      let lastPart = last parts
          name = T.takeWhile (/= '[') lastPart
      in if T.null name then Nothing else Just name

-- ── Export detection (for short var decls) ───────────────────────────────

isExported :: Text -> Bool
isExported name = case T.uncons name of
  Just (c, _) -> isUpper c
  Nothing     -> False

-- ── Expression name extraction ───────────────────────────────────────────

exprToName :: GoExpr -> Text
exprToName (IdentNode n _) = n
exprToName _                = "<expr>"

-- ── Statement walkers ────────────────────────────────────────────────────

-- | Walk a list of statements.
walkStmts :: [GoStmt] -> Analyzer ()
walkStmts = mapM_ walkStmt

-- | Walk a single Go statement, dispatching to sub-walkers.
walkStmt :: GoStmt -> Analyzer ()

-- Block: walk all child statements
walkStmt (BlockStmt stmts _) =
  mapM_ walkStmt stmts

-- Return: walk result expressions
walkStmt (ReturnStmt results _) =
  mapM_ walkExpr results

-- If: emit BRANCH node, walk condition, body, else
walkStmt (IfStmt mInit cond body mElse sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "if" parent (Just hash)
      branchCount = case mElse of
        Nothing -> 1
        Just _  -> 2

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = "if"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",        MetaText "if")
        , ("branchCount", MetaInt branchCount)
        , ("hasElse",     MetaBool (branchCount > 1))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  mapM_ walkStmt mInit
  walkExpr cond
  walkStmt body
  mapM_ walkStmt mElse

-- For: emit LOOP node, walk init, cond, post, body
walkStmt (ForStmt mInit mCond mPost body sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "LOOP" "for" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "LOOP"
    , gnName      = "for"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "for")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  mapM_ walkStmt mInit
  mapM_ walkExpr mCond
  mapM_ walkStmt mPost
  walkStmt body

-- Range: emit LOOP node, walk x, body
walkStmt (RangeStmt mKey mVal x body sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "LOOP" "range" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "LOOP"
    , gnName      = "range"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "range")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit VARIABLE nodes for range variables (key, value).
  -- Range vars are implicitly := declarations, scoped under the LOOP node.
  let emitRangeVar expr = case expr of
        IdentNode varName varSp
          | varName /= "_" -> do
              let (vLine, vCol) = spanLC varSp
                  vHash = posHash vLine vCol
                  varNodeId = semanticId file "VARIABLE" varName parent (Just vHash)
              emitNode GraphNode
                { gnId        = varNodeId
                , gnType      = "VARIABLE"
                , gnName      = varName
                , gnFile      = file
                , gnLine      = vLine
                , gnColumn    = vCol
                , gnEndLine   = posLine (spanEnd varSp)
                , gnEndColumn = posCol  (spanEnd varSp)
                , gnExported  = isExported varName
                , gnMetadata  = Map.fromList
                    [ ("kind",    MetaText "variable")
                    , ("mutable", MetaBool True)
                    ]
                }
              emitEdge GraphEdge
                { geSource   = nodeId
                , geTarget   = varNodeId
                , geType     = "CONTAINS"
                , geMetadata = Map.empty
                }
        _ -> walkExpr expr

  mapM_ emitRangeVar mKey
  mapM_ emitRangeVar mVal
  walkExpr x
  walkStmt body

-- Switch: emit BRANCH node, walk init, tag, body
walkStmt (SwitchStmt mInit mTag body sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "switch" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = "switch"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "switch")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  mapM_ walkStmt mInit
  mapM_ walkExpr mTag
  walkStmt body

-- TypeSwitch: emit BRANCH node, walk init, assign, body
walkStmt (TypeSwitchStmt mInit assign body sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "type_switch" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = "type_switch"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "type_switch")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  mapM_ walkStmt mInit
  walkStmt assign
  walkStmt body

-- Select: emit BRANCH node, walk body
walkStmt (SelectStmt body sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "select" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = "select"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "select")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  walkStmt body

-- CaseClause: emit CASE node, walk body
walkStmt (CaseClauseStmt caseList body sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      isDefault   = null caseList
      nodeId      = semanticId file "CASE" (if isDefault then "default" else "case") parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CASE"
    , gnName      = if isDefault then "default" else "case"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",      MetaText "case")
        , ("isDefault", MetaBool isDefault)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  mapM_ walkExpr caseList
  mapM_ walkStmt body

-- CommClause: walk comm and body
walkStmt (CommClauseStmt mComm body _) = do
  mapM_ walkStmt mComm
  mapM_ walkStmt body

-- Go statement: walk call expression in goroutine context
walkStmt (GoStmtNode call _) =
  withGoroutine $ walkExpr call

-- Defer statement: walk call expression in deferred context
walkStmt (DeferStmtNode call _) =
  withDeferred $ walkExpr call

-- Send statement: emit SENDS_TO edge, walk chan and value
walkStmt (SendStmtNode ch val sp) = do
  encFn <- askEnclosingFn
  case encFn of
    Just fnId -> do
      let chanName = exprToName ch
      emitEdge GraphEdge
        { geSource   = fnId
        , geTarget   = chanName
        , geType     = "SENDS_TO"
        , geMetadata = Map.fromList
            [ ("line", MetaInt (posLine (spanStart sp)))
            , ("col",  MetaInt (posCol  (spanStart sp)))
            ]
        }
    Nothing -> pure ()
  walkExpr ch >> walkExpr val

-- Assign statement: short var decl (:=) emits VARIABLE nodes
walkStmt (AssignStmtNode lhs rhs tok sp) = do
  -- Walk RHS first
  mapM_ walkExpr rhs

  if tok == ":="
    then do
      -- Short variable declaration: emit VARIABLE nodes for LHS identifiers
      file    <- askFile
      scopeId <- askScopeId
      encFn   <- askEnclosingFn
      let parent = encFn >>= extractName
          (_line, _col) = spanLC sp

      mapM_ (\expr -> case expr of
        IdentNode varName varSp ->
          if varName == "_"
            then pure ()  -- skip blank identifier
            else do
              let (vLine, vCol) = spanLC varSp
                  hash = posHash vLine vCol
                  nodeId = semanticId file "VARIABLE" varName parent (Just hash)
              emitNode GraphNode
                { gnId        = nodeId
                , gnType      = "VARIABLE"
                , gnName      = varName
                , gnFile      = file
                , gnLine      = vLine
                , gnColumn    = vCol
                , gnEndLine   = posLine (spanEnd varSp)
                , gnEndColumn = posCol  (spanEnd varSp)
                , gnExported  = isExported varName
                , gnMetadata  = Map.fromList
                    [ ("kind",    MetaText "variable")
                    , ("mutable", MetaBool True)
                    ]
                }
              emitEdge GraphEdge
                { geSource   = scopeId
                , geTarget   = nodeId
                , geType     = "CONTAINS"
                , geMetadata = Map.empty
                }

              -- Emit ASSIGNED_FROM edge if there's a corresponding RHS
              let idx = findIndex' expr lhs
              case idx >>= safeIndex rhs of
                Just rhsExpr ->
                  let rhsName = exprToName rhsExpr
                      (rl, rc) = spanLC (goExprSpan rhsExpr)
                      rhsHash = posHash rl rc
                      rhsId = case rhsExpr of
                        IdentNode n rsp ->
                          let (nl, nc) = spanLC rsp
                          in semanticId file "REFERENCE" n parent (Just (posHash nl nc))
                        _ -> semanticId file "REFERENCE" rhsName parent (Just rhsHash)
                  in emitEdge GraphEdge
                      { geSource   = nodeId
                      , geTarget   = rhsId
                      , geType     = "ASSIGNED_FROM"
                      , geMetadata = Map.empty
                      }
                Nothing -> pure ()
        _ -> walkExpr expr
        ) lhs
    else do
      -- Regular assignment: walk LHS
      mapM_ walkExpr lhs

-- Expression statement: walk expression
walkStmt (ExprStmtNode x _) =
  walkExpr x

-- Declaration statement: walk the inner declaration
walkStmt (DeclStmtNode decl _) =
  walkDeclarations decl

-- IncDec statement: walk x
walkStmt (IncDecStmtNode x _ _) =
  walkExpr x

-- Labeled statement: walk inner statement
walkStmt (LabeledStmtNode _ stmt _) =
  walkStmt stmt

-- Terminal statements: no-op
walkStmt (BranchStmtNode _ _ _) = pure ()
walkStmt (EmptyStmtNode _)      = pure ()
walkStmt (StmtUnknown _)        = pure ()

-- ── Helpers ──────────────────────────────────────────────────────────────

-- | Find the index of an element in a list by reference equality.
findIndex' :: GoExpr -> [GoExpr] -> Maybe Int
findIndex' _ []     = Nothing
findIndex' e (x:xs)
  | goExprSpan e == goExprSpan x = Just 0
  | otherwise = fmap (+1) (findIndex' e xs)

-- | Safe index into a list.
safeIndex :: [a] -> Int -> Maybe a
safeIndex []     _ = Nothing
safeIndex (x:_)  0 = Just x
safeIndex (_:xs) n
  | n > 0     = safeIndex xs (n - 1)
  | otherwise  = Nothing

-- | Extract span from any GoExpr.
goExprSpan :: GoExpr -> Span
goExprSpan (CallExprNode _ _ _ sp)     = sp
goExprSpan (SelectorExprNode _ _ sp)   = sp
goExprSpan (IdentNode _ sp)            = sp
goExprSpan (BasicLitNode _ _ sp)       = sp
goExprSpan (CompositeLitNode _ _ sp)   = sp
goExprSpan (UnaryExprNode _ _ sp)      = sp
goExprSpan (BinaryExprNode _ _ _ sp)   = sp
goExprSpan (KeyValueExprNode _ _ sp)   = sp
goExprSpan (ParenExprNode _ sp)        = sp
goExprSpan (TypeAssertNode _ _ sp)     = sp
goExprSpan (SliceExprNode _ _ _ _ sp)  = sp
goExprSpan (FuncLitNode _ _ sp)        = sp
goExprSpan (IndexExprNode _ _ sp)      = sp
goExprSpan (IndexListExprNode _ _ sp)  = sp
goExprSpan (StarExprNode _ sp)         = sp
goExprSpan (ExprUnknown sp)            = sp

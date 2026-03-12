{-# LANGUAGE OverloadedStrings #-}
-- | Control flow and statement walker for C/C++.
--
-- Handles all C/C++ statement types, emitting control flow nodes (BRANCH,
-- LOOP, CASE) and walking sub-expressions/statements.
--
-- Handles these statement types:
--   * 'CompoundStmt'   -> push BlockScope, walk children
--   * 'IfStmt'         -> BRANCH node (kind=if)
--   * 'ForStmt'        -> LOOP node (kind=for)
--   * 'WhileStmt'      -> LOOP node (kind=while)
--   * 'DoStmt'         -> LOOP node (kind=do-while)
--   * 'RangeForStmt'   -> LOOP node (kind=range-for)
--   * 'SwitchStmt'     -> BRANCH node (kind=switch)
--   * 'CaseStmt'       -> CASE node
--   * 'DefaultStmt'    -> CASE node (isDefault=True)
--   * 'ReturnStmt'     -> walk return expression
--   * 'BreakStmt'      -> no-op
--   * 'ContinueStmt'   -> no-op
--   * 'GotoStmt'       -> metadata (label name)
--   * 'LabelStmt'      -> metadata (label name)
--   * 'DeclStmt'       -> walk child declarations
--   * 'NullStmt'       -> no-op
--   * 'CoReturn'       -> EXPRESSION node (kind=co_return)
--   * 'CoAwait'         -> EXPRESSION node (kind=co_await)
--   * 'CoYield'         -> EXPRESSION node (kind=co_yield)
module Rules.Statements
  ( walkStmt
  , walkStmts
  , walkChild
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import CppAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)
import {-# SOURCE #-} Rules.Expressions (walkExpr)
import {-# SOURCE #-} Rules.Declarations (walkDeclaration, walkBodyChild)

-- ── Helpers ────────────────────────────────────────────────────────────

posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

extractName :: Text -> Maybe Text
extractName sid =
  case T.splitOn "->" sid of
    [] -> Nothing
    parts ->
      let lastPart = last parts
          name = T.takeWhile (/= '[') lastPart
      in if T.null name then Nothing else Just name

-- ── Statement walkers ──────────────────────────────────────────────────

-- | Walk a list of statements.
walkStmts :: [CppNode] -> Analyzer ()
walkStmts = mapM_ walkStmt

-- | Walk a single C/C++ statement, dispatching to sub-walkers.
walkStmt :: CppNode -> Analyzer ()

-- Compound statement (block): push BlockScope, walk children
walkStmt node | nodeKind node == "CompoundStmt" = do
  scopeId <- askScopeId
  let blockScope = Scope
        { scopeId           = scopeId <> "::block"
        , scopeKind         = BlockScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope blockScope $
    mapM_ walkChild (nodeChildren node)

-- If statement
walkStmt node | nodeKind node == "IfStmt" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line        = nodeLine node
      col         = nodeColumn node
      endLine     = maybe line id (nodeEndLine node)
      endCol      = maybe col id (nodeEndColumn node)
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "if" parent (Just hash)
      isConstexpr = lookupBoolField "isConstexpr" node
      cond        = lookupNodeField "condition" node
      initStmt    = lookupNodeField "init" node
      thenStmt    = lookupNodeField "then" node
      elseStmt    = lookupNodeField "else" node
      branchCount = case elseStmt of
        Nothing -> 1
        Just _  -> 2

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = "if"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("kind",        MetaText "if")
        , ("branchCount", MetaInt branchCount)
        , ("hasElse",     MetaBool (branchCount > 1))
        ] ++
        [ ("isConstexpr", MetaBool True) | isConstexpr ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- HAS_CONDITION edge
  case cond of
    Just condNode -> do
      let condId = nodeId <> "::condition"
      emitEdge GraphEdge
        { geSource   = nodeId
        , geTarget   = condId
        , geType     = "HAS_CONDITION"
        , geMetadata = Map.empty
        }
      walkExpr condNode
    Nothing -> pure ()

  -- HAS_CONSEQUENT edge (then branch)
  case thenStmt of
    Just thenNode -> do
      let thenId = nodeId <> "::consequent"
      emitEdge GraphEdge
        { geSource   = nodeId
        , geTarget   = thenId
        , geType     = "HAS_CONSEQUENT"
        , geMetadata = Map.empty
        }
      walkStmt thenNode
    Nothing -> pure ()

  -- HAS_ALTERNATE edge (else branch)
  case elseStmt of
    Just elseNode -> do
      let elseId = nodeId <> "::alternate"
      emitEdge GraphEdge
        { geSource   = nodeId
        , geTarget   = elseId
        , geType     = "HAS_ALTERNATE"
        , geMetadata = Map.empty
        }
      walkStmt elseNode
    Nothing -> pure ()

  -- Walk init statement if present (C++17 if-init)
  mapM_ walkStmt initStmt

-- For statement
walkStmt node | nodeKind node == "ForStmt" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "LOOP" "for" parent (Just hash)
      initSt  = lookupNodeField "init" node
      cond    = lookupNodeField "condition" node
      incr    = lookupNodeField "increment" node
      body    = lookupNodeField "body" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "LOOP"
    , gnName      = "for"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "for")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- HAS_INIT edge
  case initSt of
    Just _ ->
      emitEdge GraphEdge
        { geSource   = nodeId
        , geTarget   = nodeId <> "::init"
        , geType     = "HAS_INIT"
        , geMetadata = Map.empty
        }
    Nothing -> pure ()

  -- HAS_BODY edge
  case body of
    Just _ ->
      emitEdge GraphEdge
        { geSource   = nodeId
        , geTarget   = nodeId <> "::body"
        , geType     = "HAS_BODY"
        , geMetadata = Map.empty
        }
    Nothing -> pure ()

  -- HAS_UPDATE edge
  case incr of
    Just _ ->
      emitEdge GraphEdge
        { geSource   = nodeId
        , geTarget   = nodeId <> "::update"
        , geType     = "HAS_UPDATE"
        , geMetadata = Map.empty
        }
    Nothing -> pure ()

  let loopScope = Scope
        { scopeId           = nodeId
        , scopeKind         = LoopScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope loopScope $ do
    mapM_ walkStmt initSt
    mapM_ walkExpr cond
    mapM_ walkExpr incr
    mapM_ walkStmt body

-- While statement
walkStmt node | nodeKind node == "WhileStmt" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "LOOP" "while" parent (Just hash)
      cond    = lookupNodeField "condition" node
      body    = lookupNodeField "body" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "LOOP"
    , gnName      = "while"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "while")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- HAS_CONDITION edge
  case cond of
    Just _ ->
      emitEdge GraphEdge
        { geSource   = nodeId
        , geTarget   = nodeId <> "::condition"
        , geType     = "HAS_CONDITION"
        , geMetadata = Map.empty
        }
    Nothing -> pure ()

  -- HAS_BODY edge
  case body of
    Just _ ->
      emitEdge GraphEdge
        { geSource   = nodeId
        , geTarget   = nodeId <> "::body"
        , geType     = "HAS_BODY"
        , geMetadata = Map.empty
        }
    Nothing -> pure ()

  let loopScope = Scope
        { scopeId           = nodeId
        , scopeKind         = LoopScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope loopScope $ do
    mapM_ walkExpr cond
    mapM_ walkStmt body

-- Do-while statement
walkStmt node | nodeKind node == "DoStmt" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "LOOP" "do-while" parent (Just hash)
      cond    = lookupNodeField "condition" node
      body    = lookupNodeField "body" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "LOOP"
    , gnName      = "do-while"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "do-while")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- HAS_CONDITION edge
  case cond of
    Just _ ->
      emitEdge GraphEdge
        { geSource   = nodeId
        , geTarget   = nodeId <> "::condition"
        , geType     = "HAS_CONDITION"
        , geMetadata = Map.empty
        }
    Nothing -> pure ()

  -- HAS_BODY edge
  case body of
    Just _ ->
      emitEdge GraphEdge
        { geSource   = nodeId
        , geTarget   = nodeId <> "::body"
        , geType     = "HAS_BODY"
        , geMetadata = Map.empty
        }
    Nothing -> pure ()

  let loopScope = Scope
        { scopeId           = nodeId
        , scopeKind         = LoopScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope loopScope $ do
    mapM_ walkStmt body
    mapM_ walkExpr cond

-- Range-based for statement (C++11)
walkStmt node | nodeKind node == "RangeForStmt" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "LOOP" "range-for" parent (Just hash)
      decl    = lookupNodeField "declaration" node
      range   = lookupNodeField "range" node
      body    = lookupNodeField "body" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "LOOP"
    , gnName      = "range-for"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "range-for")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- ITERATES_OVER edge for the range expression
  case range of
    Just _rangeNode -> do
      let rangeId = nodeId <> "::range"
      emitEdge GraphEdge
        { geSource   = nodeId
        , geTarget   = rangeId
        , geType     = "ITERATES_OVER"
        , geMetadata = Map.empty
        }
    Nothing -> pure ()

  let loopScope = Scope
        { scopeId           = nodeId
        , scopeKind         = LoopScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope loopScope $ do
    mapM_ walkDeclaration decl
    mapM_ walkExpr range
    mapM_ walkStmt body

-- Switch statement
walkStmt node | nodeKind node == "SwitchStmt" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "BRANCH" "switch" parent (Just hash)
      initSt  = lookupNodeField "init" node
      cond    = lookupNodeField "condition" node
      body    = lookupNodeField "body" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = "switch"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "switch")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  mapM_ walkStmt initSt
  mapM_ walkExpr cond

  -- Walk switch body and emit HAS_CASE/HAS_DEFAULT edges
  case body of
    Just bodyNode -> do
      let cases = filter (\c -> nodeKind c == "CaseStmt") (nodeChildren bodyNode)
          defaults = filter (\c -> nodeKind c == "DefaultStmt") (nodeChildren bodyNode)
      mapM_ (\c -> do
        let caseHash = posHash (nodeLine c) (nodeColumn c)
            caseId = semanticId file "CASE" "case" parent (Just caseHash)
        emitEdge GraphEdge
          { geSource   = nodeId
          , geTarget   = caseId
          , geType     = "HAS_CASE"
          , geMetadata = Map.empty
          }) cases
      mapM_ (\c -> do
        let defHash = posHash (nodeLine c) (nodeColumn c)
            defId = semanticId file "CASE" "default" parent (Just defHash)
        emitEdge GraphEdge
          { geSource   = nodeId
          , geTarget   = defId
          , geType     = "HAS_DEFAULT"
          , geMetadata = Map.empty
          }) defaults
      mapM_ walkStmt (nodeChildren bodyNode)
    Nothing -> pure ()

-- Case statement
walkStmt node | nodeKind node == "CaseStmt" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "CASE" "case" parent (Just hash)
      value   = lookupNodeField "value" node
      body    = nodeChildren node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CASE"
    , gnName      = "case"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",      MetaText "case")
        , ("isDefault", MetaBool False)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  mapM_ walkExpr value
  mapM_ walkStmt body

-- Default statement
walkStmt node | nodeKind node == "DefaultStmt" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "CASE" "default" parent (Just hash)
      body    = nodeChildren node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CASE"
    , gnName      = "default"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",      MetaText "case")
        , ("isDefault", MetaBool True)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  mapM_ walkStmt body

-- Return statement
walkStmt node | nodeKind node == "ReturnStmt" = do
  encFn <- askEnclosingFn
  let retExpr = lookupNodeField "expr" node
      line    = nodeLine node

  -- Emit RETURNS edge from the enclosing function
  case encFn of
    Just fnId ->
      emitEdge GraphEdge
        { geSource   = fnId
        , geTarget   = fnId <> "::return[" <> posHash line (nodeColumn node) <> "]"
        , geType     = "RETURNS"
        , geMetadata = Map.fromList
            [ ("line", MetaInt line)
            , ("hasValue", MetaBool (case retExpr of { Just _ -> True; Nothing -> False }))
            ]
        }
    Nothing -> pure ()

  mapM_ walkExpr retExpr

-- Break / Continue / Null statements -> no-op
walkStmt node | nodeKind node == "BreakStmt"    = pure ()
walkStmt node | nodeKind node == "ContinueStmt" = pure ()
walkStmt node | nodeKind node == "NullStmt"     = pure ()

-- Goto statement
walkStmt node | nodeKind node == "GotoStmt" = pure ()

-- Label statement
walkStmt node | nodeKind node == "LabelStmt" = do
  let inner = lookupNodeField "stmt" node
  mapM_ walkStmt inner

-- Declaration statement
walkStmt node | nodeKind node == "DeclStmt" =
  mapM_ walkDeclaration (nodeChildren node)

-- Expression statement
walkStmt node | nodeKind node == "ExprStmt" = do
  let expr = lookupNodeField "expr" node
  mapM_ walkExpr expr

-- Coroutine statements (C++20)
walkStmt node | nodeKind node == "CoReturn" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "EXPRESSION" "co_return" parent (Just hash)
      operand = lookupNodeField "operand" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "EXPRESSION"
    , gnName      = "co_return"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "co_return")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  mapM_ walkExpr operand

walkStmt node | nodeKind node == "CoAwait" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "EXPRESSION" "co_await" parent (Just hash)
      operand = lookupNodeField "operand" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "EXPRESSION"
    , gnName      = "co_await"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "co_await")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  mapM_ walkExpr operand

walkStmt node | nodeKind node == "CoYield" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "EXPRESSION" "co_yield" parent (Just hash)
      operand = lookupNodeField "operand" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "EXPRESSION"
    , gnName      = "co_yield"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "co_yield")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  mapM_ walkExpr operand

-- Fallback: walk children via comprehensive dispatch
walkStmt node = mapM_ walkChild (nodeChildren node)

-- ── Child dispatch ──────────────────────────────────────────────────────

-- | Dispatch a node inside a statement body to the appropriate rule.
-- Delegates to walkBodyChild from Rules.Declarations for comprehensive
-- dispatch across all rule modules (declarations, data types, expressions,
-- statements, templates, preprocessor, imports, error flow, lambdas, etc.).
walkChild :: CppNode -> Analyzer ()
walkChild = walkBodyChild

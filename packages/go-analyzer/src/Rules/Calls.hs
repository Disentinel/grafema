{-# LANGUAGE OverloadedStrings #-}
-- | Expression walker: CALL nodes and recursive expression traversal.
--
-- Handles these Go expression types:
--   * 'CallExprNode'        -> CALL node, deferred CALLS edge
--   * 'SelectorExprNode'    -> walk sub-expression
--   * 'FuncLitNode'         -> FUNCTION node (kind=closure)
--   * 'BinaryExprNode'      -> walk both operands
--   * 'UnaryExprNode'       -> walk operand
--   * 'CompositeLitNode'    -> walk element expressions
--   * 'ParenExprNode'       -> walk inner expression
--   * 'SliceExprNode'       -> walk sub-expressions
--   * 'IndexExprNode'       -> walk x, index
--   * 'IndexListExprNode'   -> walk x, indices
--   * 'KeyValueExprNode'    -> walk key, value
--   * 'TypeAssertNode'      -> walk x
--   * 'StarExprNode'        -> walk x
--
-- Node types: CALL, FUNCTION (closure)
-- Edge types: CONTAINS, CALLS (deferred)
--
-- Called from 'Rules.Declarations' for initializers and from
-- 'Rules.ControlFlow' for expression statements.
module Rules.Calls
  ( walkExpr
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GoAST
import Analysis.Types
    ( GraphNode(..)
    , GraphEdge(..)
    , MetaValue(..)
    , Scope(..)
    , ScopeKind(..)
    , DeferredRef(..)
    , DeferredKind(..)
    )
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , emitDeferred
    , askFile
    , askScopeId
    , askEnclosingFn
    , askIsGoroutine
    , askIsDeferred
    , withScope
    , withEnclosingFn
    )
import Grafema.SemanticId (semanticId, contentHash)
import {-# SOURCE #-} Rules.ControlFlow (walkStmt)
import {-# SOURCE #-} Rules.Declarations (walkParam)

-- ── Span helpers ─────────────────────────────────────────────────────────

spanLC :: Span -> (Int, Int)
spanLC sp = (posLine (spanStart sp), posCol (spanStart sp))

posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- ── Name extraction ──────────────────────────────────────────────────────

-- | Extract a human-readable name from an expression.
exprToName :: GoExpr -> Text
exprToName (IdentNode n _)          = n
exprToName (SelectorExprNode x sel _) = exprToName x <> "." <> sel
exprToName _                         = "<expr>"

-- | Extract the trailing name from a semantic ID.
extractName :: Text -> Maybe Text
extractName sid =
  case T.splitOn "->" sid of
    [] -> Nothing
    parts ->
      let lastPart = last parts
          name = T.takeWhile (/= '[') lastPart
      in if T.null name then Nothing else Just name

-- ── Expression walker ────────────────────────────────────────────────────

-- | Walk a single Go expression, emitting graph nodes and edges.
walkExpr :: GoExpr -> Analyzer ()

-- ── CALL node: function/method call ──────────────────────────────────────

walkExpr (CallExprNode fun args _ellipsis sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn
  isGo    <- askIsGoroutine
  isDefer <- askIsDeferred

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      callName    = exprToName fun
      nodeId      = semanticId file "CALL" callName parent (Just hash)

      -- Extract receiver for method calls
      (receiver, methodName) = case fun of
        SelectorExprNode x sel _ -> (Just (exprToName x), sel)
        _                        -> (Nothing, callName)

  -- Emit CALL node
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CALL"
    , gnName      = callName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("argCount", MetaInt (length args))
        ] ++
        [ ("receiver", MetaText r) | Just r <- [receiver] ] ++
        [ ("goroutine", MetaBool True) | isGo ] ++
        [ ("deferred", MetaBool True) | isDefer ]
    }

  -- CONTAINS edge from scope
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred CALLS edge for resolution
  emitDeferred DeferredRef
    { drKind       = CallResolve
    , drName       = methodName
    , drFromNodeId = nodeId
    , drEdgeType   = "CALLS"
    , drScopeId    = Just scopeId
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = receiver
    , drMetadata   = Map.empty
    }

  -- Walk receiver expression (for nested calls in the receiver)
  case fun of
    SelectorExprNode x _ _ -> walkExpr x
    _                      -> pure ()

  -- Walk arguments
  mapM_ walkExpr args

-- ── Selector expression: walk sub-expression ─────────────────────────────

walkExpr (SelectorExprNode x _sel _sp) =
  walkExpr x

-- ── Function literal (closure) → FUNCTION node with kind=closure ─────────

walkExpr (FuncLitNode funcType body sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "FUNCTION" "<closure>" parent (Just hash)
      (closureParams, closureResults) = case funcType of
        FuncTypeNode params results _ -> (params, results)
        _                             -> ([], [])

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = "<closure>"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",        MetaText "closure")
        , ("paramCount",  MetaInt (length closureParams))
        , ("returnCount", MetaInt (length closureResults))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk closure parameters
  mapM_ (walkParam file nodeId) closureParams

  -- Walk body in closure scope using the full ControlFlow.walkStmt
  let closureScope = Scope
        { scopeId           = nodeId
        , scopeKind         = FunctionScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope closureScope $
    withEnclosingFn nodeId $
      walkStmt body

-- ── Transparent expressions: walk children recursively ───────────────────

walkExpr (BinaryExprNode _op x y _sp) =
  walkExpr x >> walkExpr y

walkExpr (UnaryExprNode op x sp) = do
  case op of
    "<-" -> do
      encFn <- askEnclosingFn
      case encFn of
        Just fnId -> do
          let chanName = exprToName x
          emitEdge GraphEdge
            { geSource   = fnId
            , geTarget   = chanName
            , geType     = "RECEIVES_FROM"
            , geMetadata = Map.fromList
                [ ("line", MetaInt (posLine (spanStart sp)))
                , ("col",  MetaInt (posCol  (spanStart sp)))
                ]
            }
        Nothing -> pure ()
    _ -> pure ()
  walkExpr x

walkExpr (CompositeLitNode _ty elts _sp) =
  mapM_ walkExpr elts

walkExpr (ParenExprNode x _sp) =
  walkExpr x

walkExpr (TypeAssertNode x _ty _sp) =
  walkExpr x

walkExpr (SliceExprNode x mLow mHigh mMax _sp) = do
  walkExpr x
  mapM_ walkExpr mLow
  mapM_ walkExpr mHigh
  mapM_ walkExpr mMax

walkExpr (IndexExprNode x idx _sp) =
  walkExpr x >> walkExpr idx

walkExpr (IndexListExprNode x indices _sp) =
  walkExpr x >> mapM_ walkExpr indices

walkExpr (KeyValueExprNode k v _sp) =
  walkExpr k >> walkExpr v

walkExpr (StarExprNode x _sp) =
  walkExpr x

-- Terminal expressions: no children to walk
walkExpr (IdentNode _ _)     = pure ()
walkExpr (BasicLitNode _ _ _) = pure ()
walkExpr (ExprUnknown _)     = pure ()


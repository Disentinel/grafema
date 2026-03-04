{-# LANGUAGE OverloadedStrings #-}
-- | Phase 10 rule: ownership — BORROW and DEREF nodes.
--
-- Performs BEST-EFFORT syntactic analysis of Rust ownership patterns.
-- This is NOT a borrow checker — it identifies syntactic patterns like
-- @&x@, @&mut x@, and @*x@ and emits graph nodes for them.
--
-- Handles these Rust expression types:
--   * 'ExprReference' (not mutable) -> BORROW node + BORROWS edge
--   * 'ExprReference' (mutable)     -> BORROW node + BORROWS_MUT edge
--   * 'ExprUnary' "*"               -> DEREF node
--
-- All metadata includes @confidence = "syntactic"@ to indicate
-- best-effort analysis.
--
-- Called from 'Rules.Declarations' for expression statements and let
-- binding initializers, running alongside 'walkExpr'.
module Rules.Ownership
  ( walkOwnership
  ) where

import Control.Monad (when)
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import RustAST
import Analysis.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , askFile
    , askScopeId
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Name extraction ──────────────────────────────────────────────────

-- | Extract a human-readable name from an expression (for borrow targets).
--
-- ExprPath "foo" -> "foo"
-- ExprField _ "field" -> "field"
-- Other            -> "<expr>"
exprToName :: RustExpr -> Text
exprToName (ExprPath path _) = path
exprToName (ExprField _ member _) = member
exprToName _ = "<expr>"

-- ── Span helpers ─────────────────────────────────────────────────────

-- | Extract line and col from a Span.
spanLC :: Span -> (Int, Int)
spanLC sp = (posLine (spanStart sp), posCol (spanStart sp))

-- | Build a content hash from line and col for position-based disambiguation.
posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- ── Expression ownership walker ──────────────────────────────────────

-- | Walk a single Rust expression, emitting BORROW and DEREF nodes.
--
-- This walks the expression tree looking for ownership-related patterns:
--
--   * @&x@ -> BORROW node (mutable=False) + BORROWS edge
--   * @&mut x@ -> BORROW node (mutable=True) + BORROWS_MUT edge
--   * @*x@ -> DEREF node
--
-- All other expressions are recursed into transparently.
walkOwnership :: RustExpr -> Analyzer ()

-- ── &x → BORROW node + BORROWS edge ─────────────────────────────────

walkOwnership (ExprReference expr False sp) = do
  file    <- askFile
  scopeId <- askScopeId

  let (line, col) = spanLC sp
      refName     = exprToName expr
      hash        = posHash line col
      nodeId      = semanticId file "BORROW" refName Nothing (Just hash)

  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "BORROW"
    , gnName     = refName
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("mutable",    MetaBool False)
        , ("confidence", MetaText "syntactic")
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- BORROWS edge: borrow -> referenced expression (self-edge with target metadata)
  let targetName = exprToName expr
  when (targetName /= "<expr>") $
    emitEdge GraphEdge
      { geSource   = nodeId
      , geTarget   = nodeId
      , geType     = "BORROWS"
      , geMetadata = Map.fromList [("target", MetaText targetName)]
      }

  -- Recurse into the referenced expression
  walkOwnership expr

-- ── &mut x → BORROW node + BORROWS_MUT edge ─────────────────────────

walkOwnership (ExprReference expr True sp) = do
  file    <- askFile
  scopeId <- askScopeId

  let (line, col) = spanLC sp
      refName     = exprToName expr
      hash        = posHash line col
      nodeId      = semanticId file "BORROW" refName Nothing (Just hash)

  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "BORROW"
    , gnName     = refName
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("mutable",    MetaBool True)
        , ("confidence", MetaText "syntactic")
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- BORROWS_MUT edge: mutable borrow -> referenced expression (self-edge with target metadata)
  let targetName = exprToName expr
  when (targetName /= "<expr>") $
    emitEdge GraphEdge
      { geSource   = nodeId
      , geTarget   = nodeId
      , geType     = "BORROWS_MUT"
      , geMetadata = Map.fromList [("target", MetaText targetName)]
      }

  -- Recurse into the referenced expression
  walkOwnership expr

-- ── *x → DEREF node ─────────────────────────────────────────────────

walkOwnership (ExprUnary op expr sp) | op == "*" = do
  file    <- askFile
  scopeId <- askScopeId

  let (line, col) = spanLC sp
      refName     = exprToName expr
      hash        = posHash line col
      nodeId      = semanticId file "DEREF" refName Nothing (Just hash)

  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "DEREF"
    , gnName     = refName
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("confidence", MetaText "syntactic")
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Recurse into the dereferenced expression
  walkOwnership expr

-- ── Transparent expressions: recurse into children ───────────────────

walkOwnership (ExprCall func args _) =
  walkOwnership func >> mapM_ walkOwnership args

walkOwnership (ExprMethodCall recv _ args _) =
  walkOwnership recv >> mapM_ walkOwnership args

walkOwnership (ExprBinary left _ right _) =
  walkOwnership left >> walkOwnership right

walkOwnership (ExprUnary _ expr _) =
  walkOwnership expr

walkOwnership (ExprIf cond thenBlock mElse _) =
  walkOwnership cond >> walkBlockOwnership thenBlock >> mapM_ walkOwnership mElse

walkOwnership (ExprMatch expr arms _) =
  walkOwnership expr >> mapM_ (walkOwnership . raBody) arms

walkOwnership (ExprLoop body _ _) =
  walkBlockOwnership body

walkOwnership (ExprWhile cond body _ _) =
  walkOwnership cond >> walkBlockOwnership body

walkOwnership (ExprForLoop _ expr body _ _) =
  walkOwnership expr >> walkBlockOwnership body

walkOwnership (ExprAssign left right _) =
  walkOwnership left >> walkOwnership right

walkOwnership (ExprField base _ _) =
  walkOwnership base

walkOwnership (ExprIndex expr idx _) =
  walkOwnership expr >> walkOwnership idx

walkOwnership (ExprTry expr _) =
  walkOwnership expr

walkOwnership (ExprAwait expr _) =
  walkOwnership expr

walkOwnership (ExprCast expr _ _) =
  walkOwnership expr

walkOwnership (ExprTuple elems _) =
  mapM_ walkOwnership elems

walkOwnership (ExprArray elems _) =
  mapM_ walkOwnership elems

walkOwnership (ExprBlock stmts _) =
  mapM_ walkStmtOwnership stmts

walkOwnership (ExprUnsafe blk _) =
  walkBlockOwnership blk

walkOwnership (ExprAsync _ blk _) =
  walkBlockOwnership blk

walkOwnership (ExprClosure _ _ body _ _) =
  walkOwnership body

walkOwnership (ExprReturn mExpr _) =
  mapM_ walkOwnership mExpr

walkOwnership (ExprBreak mExpr _ _) =
  mapM_ walkOwnership mExpr

walkOwnership (ExprRange mStart mEnd _) =
  mapM_ walkOwnership mStart >> mapM_ walkOwnership mEnd

walkOwnership (ExprStruct _ fields mRest _) =
  mapM_ (walkOwnership . snd) fields >> mapM_ walkOwnership mRest

walkOwnership (ExprLet _ expr _) =
  walkOwnership expr

-- ── Terminal expressions: no children ────────────────────────────────

walkOwnership (ExprPath _ _) = pure ()
walkOwnership (ExprLit _ _) = pure ()
walkOwnership (ExprContinue _ _) = pure ()
walkOwnership (ExprUnknown _) = pure ()

-- ── Block & statement helpers ────────────────────────────────────────

-- | Walk all statements in a block for ownership patterns.
walkBlockOwnership :: RustBlock -> Analyzer ()
walkBlockOwnership (RustBlock stmts) = mapM_ walkStmtOwnership stmts

-- | Walk a single statement for ownership patterns.
walkStmtOwnership :: RustStmt -> Analyzer ()
walkStmtOwnership (StmtExpr expr) = walkOwnership expr
walkStmtOwnership (StmtSemi expr) = walkOwnership expr
walkStmtOwnership (StmtLocal _ mInit _) = mapM_ walkOwnership mInit
walkStmtOwnership (StmtItem _) = pure ()
walkStmtOwnership (StmtMacro _) = pure ()

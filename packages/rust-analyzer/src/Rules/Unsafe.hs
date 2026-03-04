{-# LANGUAGE OverloadedStrings #-}
-- | Phase 12 rule: unsafe boundaries — UNSAFE_BLOCK nodes.
--
-- Tracks unsafe boundaries in Rust code:
--   * @unsafe { ... }@ in safe fn -> UNSAFE_BLOCK node + CONTAINS_UNSAFE edge
--   * Safe fn with call inside unsafe block -> WRAPS_UNSAFE edge
--   * @unsafe fn@ -> already handled by Phase 3 (metadata unsafe=true on FUNCTION)
--
-- Emits:
--   * UNSAFE_BLOCK nodes for each @unsafe { ... }@ block
--   * CONTAINS edge from scope to UNSAFE_BLOCK
--   * CONTAINS_UNSAFE edge from enclosing safe function to unsafe block
--   * WRAPS_UNSAFE edge from safe function to calls inside unsafe blocks
--
-- Called from 'Rules.Declarations' for expression statements and let
-- binding initializers, running alongside 'walkExpr', 'walkOwnership',
-- and 'walkErrorFlow'.
module Rules.Unsafe
  ( walkUnsafe
  ) where

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
    , askEnclosingFn
    , askUnsafe
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Name extraction ──────────────────────────────────────────────────

-- | Extract a human-readable name from an expression (for call targets).
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

-- ── Helpers ────────────────────────────────────────────────────────────

-- | Extract the trailing name from a semantic ID.
-- e.g. "src/main.rs->FUNCTION->foo" -> Just "foo"
--      "src/main.rs->FUNCTION->foo[in:bar]" -> Just "foo"
extractName :: Text -> Maybe Text
extractName sid =
  case T.splitOn "->" sid of
    [] -> Nothing
    parts ->
      let lastPart = last parts
          -- Strip any bracket suffix: "foo[in:bar]" -> "foo"
          name = T.takeWhile (/= '[') lastPart
      in if T.null name then Nothing else Just name

-- ── Unsafe expression walker ─────────────────────────────────────────

-- | Walk a single Rust expression, emitting UNSAFE_BLOCK nodes and
-- CONTAINS_UNSAFE / WRAPS_UNSAFE edges.
--
-- This walks the expression tree looking for unsafe blocks:
--
--   * @unsafe { ... }@ in safe fn -> UNSAFE_BLOCK node + CONTAINS_UNSAFE edge
--   * Calls inside unsafe blocks -> WRAPS_UNSAFE edge from enclosing safe fn
--
-- All other expressions are recursed into transparently.
walkUnsafe :: RustExpr -> Analyzer ()

-- ── unsafe { ... } block ─────────────────────────────────────────────

walkUnsafe (ExprUnsafe block sp) = do
  file <- askFile
  scopeId <- askScopeId
  encFn <- askEnclosingFn
  isUnsafe <- askUnsafe

  let (line, col) = spanLC sp
      hash = posHash line col
      nodeId = semanticId file "UNSAFE_BLOCK" "unsafe" Nothing (Just hash)

  -- Emit UNSAFE_BLOCK node
  emitNode GraphNode
    { gnId = nodeId
    , gnType = "UNSAFE_BLOCK"
    , gnName = "unsafe"
    , gnFile = file
    , gnLine = line
    , gnColumn = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.empty
    }

  -- CONTAINS edge from scope to unsafe block
  emitEdge GraphEdge
    { geSource = scopeId
    , geTarget = nodeId
    , geType = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- CONTAINS_UNSAFE edge from enclosing function to this block (if in a safe fn)
  case encFn of
    Just fnId | not isUnsafe ->
      emitEdge GraphEdge
        { geSource = fnId
        , geTarget = nodeId
        , geType = "CONTAINS_UNSAFE"
        , geMetadata = Map.empty
        }
    _ -> pure ()

  -- Walk block contents looking for calls that would produce WRAPS_UNSAFE
  walkBlockUnsafe block encFn (not isUnsafe)

-- ── Transparent expressions: recurse into children ───────────────────

walkUnsafe (ExprCall func args _) =
  walkUnsafe func >> mapM_ walkUnsafe args

walkUnsafe (ExprMethodCall recv _ args _) =
  walkUnsafe recv >> mapM_ walkUnsafe args

walkUnsafe (ExprBinary left _ right _) =
  walkUnsafe left >> walkUnsafe right

walkUnsafe (ExprUnary _ expr _) =
  walkUnsafe expr

walkUnsafe (ExprIf cond thenBlock mElse _) =
  walkUnsafe cond >> walkBlockUnsafeOuter thenBlock >> mapM_ walkUnsafe mElse

walkUnsafe (ExprMatch expr arms _) =
  walkUnsafe expr >> mapM_ (walkUnsafe . raBody) arms

walkUnsafe (ExprBlock stmts _) =
  mapM_ walkStmtUnsafe stmts

walkUnsafe (ExprClosure _ _ body _ _) =
  walkUnsafe body

walkUnsafe (ExprAssign left right _) =
  walkUnsafe left >> walkUnsafe right

walkUnsafe (ExprField base _ _) =
  walkUnsafe base

walkUnsafe (ExprIndex expr idx _) =
  walkUnsafe expr >> walkUnsafe idx

walkUnsafe (ExprTry expr _) =
  walkUnsafe expr

walkUnsafe (ExprAwait expr _) =
  walkUnsafe expr

walkUnsafe (ExprCast expr _ _) =
  walkUnsafe expr

walkUnsafe (ExprTuple elems _) =
  mapM_ walkUnsafe elems

walkUnsafe (ExprArray elems _) =
  mapM_ walkUnsafe elems

walkUnsafe (ExprAsync _ blk _) =
  walkBlockUnsafeOuter blk

walkUnsafe (ExprReturn mExpr _) =
  mapM_ walkUnsafe mExpr

walkUnsafe (ExprBreak mExpr _ _) =
  mapM_ walkUnsafe mExpr

walkUnsafe (ExprRange mStart mEnd _) =
  mapM_ walkUnsafe mStart >> mapM_ walkUnsafe mEnd

walkUnsafe (ExprStruct _ fields mRest _) =
  mapM_ (walkUnsafe . snd) fields >> mapM_ walkUnsafe mRest

walkUnsafe (ExprLet _ expr _) =
  walkUnsafe expr

walkUnsafe (ExprReference expr _ _) =
  walkUnsafe expr

walkUnsafe (ExprLoop body _ _) =
  walkBlockUnsafeOuter body

walkUnsafe (ExprWhile cond body _ _) =
  walkUnsafe cond >> walkBlockUnsafeOuter body

walkUnsafe (ExprForLoop _ expr body _ _) =
  walkUnsafe expr >> walkBlockUnsafeOuter body

-- ── Terminal expressions: no children ────────────────────────────────

walkUnsafe (ExprPath _ _) = pure ()
walkUnsafe (ExprLit _ _) = pure ()
walkUnsafe (ExprContinue _ _) = pure ()
walkUnsafe (ExprUnknown _) = pure ()

-- ── Block & statement helpers (outer: not inside unsafe block) ───────

-- | Walk all statements in a block, looking for unsafe blocks.
-- This is the "outer" version: we are NOT yet inside an unsafe block.
walkBlockUnsafeOuter :: RustBlock -> Analyzer ()
walkBlockUnsafeOuter (RustBlock stmts) = mapM_ walkStmtUnsafe stmts

-- | Walk a single statement for unsafe blocks.
walkStmtUnsafe :: RustStmt -> Analyzer ()
walkStmtUnsafe (StmtExpr expr) = walkUnsafe expr
walkStmtUnsafe (StmtSemi expr) = walkUnsafe expr
walkStmtUnsafe (StmtLocal _ mInit _) = mapM_ walkUnsafe mInit
walkStmtUnsafe (StmtItem _) = pure ()
walkStmtUnsafe (StmtMacro _) = pure ()

-- ── Block walking inside unsafe block ────────────────────────────────

-- | Walk a block inside an unsafe block, emitting WRAPS_UNSAFE for any calls.
--
-- @mFnId@: the enclosing function ID (if any)
-- @isSafeFn@: whether the enclosing function is safe (not unsafe)
walkBlockUnsafe :: RustBlock -> Maybe Text -> Bool -> Analyzer ()
walkBlockUnsafe (RustBlock stmts) mFnId isSafeFn =
  mapM_ (walkStmtUnsafeInner mFnId isSafeFn) stmts

-- | Walk a single statement inside an unsafe block.
walkStmtUnsafeInner :: Maybe Text -> Bool -> RustStmt -> Analyzer ()
walkStmtUnsafeInner mFnId isSafeFn (StmtExpr expr) = walkExprUnsafeInner mFnId isSafeFn expr
walkStmtUnsafeInner mFnId isSafeFn (StmtSemi expr) = walkExprUnsafeInner mFnId isSafeFn expr
walkStmtUnsafeInner mFnId isSafeFn (StmtLocal _ mInit _) = mapM_ (walkExprUnsafeInner mFnId isSafeFn) mInit
walkStmtUnsafeInner _ _ (StmtItem _) = pure ()
walkStmtUnsafeInner _ _ (StmtMacro _) = pure ()

-- ── Expression walking inside unsafe block ───────────────────────────

-- | Walk expressions inside an unsafe block, emitting WRAPS_UNSAFE
-- edges for calls found inside.
walkExprUnsafeInner :: Maybe Text -> Bool -> RustExpr -> Analyzer ()

-- Function call inside unsafe block -> WRAPS_UNSAFE edge (if in safe fn)
walkExprUnsafeInner mFnId isSafeFn (ExprCall func args sp) = do
  case mFnId of
    Just fnId | isSafeFn -> do
      file <- askFile
      let (line, col) = spanLC sp
          callName = exprToName func
          parent = extractName fnId
          hash = posHash line col
          callId = semanticId file "CALL" callName parent (Just hash)
      emitEdge GraphEdge
        { geSource = fnId
        , geTarget = callId
        , geType = "WRAPS_UNSAFE"
        , geMetadata = Map.fromList [("call", MetaText callName)]
        }
    _ -> pure ()
  -- Recurse into subexpressions
  walkExprUnsafeInner mFnId isSafeFn func
  mapM_ (walkExprUnsafeInner mFnId isSafeFn) args

-- Method call inside unsafe block -> WRAPS_UNSAFE edge (if in safe fn)
walkExprUnsafeInner mFnId isSafeFn (ExprMethodCall recv method args sp) = do
  case mFnId of
    Just fnId | isSafeFn -> do
      file <- askFile
      let (line, col) = spanLC sp
          parent = extractName fnId
          hash = posHash line col
          callId = semanticId file "CALL" method parent (Just hash)
      emitEdge GraphEdge
        { geSource = fnId
        , geTarget = callId
        , geType = "WRAPS_UNSAFE"
        , geMetadata = Map.fromList [("call", MetaText method)]
        }
    _ -> pure ()
  -- Recurse into subexpressions
  walkExprUnsafeInner mFnId isSafeFn recv
  mapM_ (walkExprUnsafeInner mFnId isSafeFn) args

-- All other expressions: recurse into children
walkExprUnsafeInner mFnId isSafeFn (ExprBinary left _ right _) =
  walkExprUnsafeInner mFnId isSafeFn left >> walkExprUnsafeInner mFnId isSafeFn right

walkExprUnsafeInner mFnId isSafeFn (ExprUnary _ expr _) =
  walkExprUnsafeInner mFnId isSafeFn expr

walkExprUnsafeInner mFnId isSafeFn (ExprIf cond thenBlock mElse _) = do
  walkExprUnsafeInner mFnId isSafeFn cond
  walkBlockUnsafe thenBlock mFnId isSafeFn
  mapM_ (walkExprUnsafeInner mFnId isSafeFn) mElse

walkExprUnsafeInner mFnId isSafeFn (ExprMatch expr arms _) =
  walkExprUnsafeInner mFnId isSafeFn expr >> mapM_ (walkExprUnsafeInner mFnId isSafeFn . raBody) arms

walkExprUnsafeInner mFnId isSafeFn (ExprBlock stmts _) =
  mapM_ (walkStmtUnsafeInner mFnId isSafeFn) stmts

walkExprUnsafeInner mFnId isSafeFn (ExprClosure _ _ body _ _) =
  walkExprUnsafeInner mFnId isSafeFn body

walkExprUnsafeInner mFnId isSafeFn (ExprAssign left right _) =
  walkExprUnsafeInner mFnId isSafeFn left >> walkExprUnsafeInner mFnId isSafeFn right

walkExprUnsafeInner mFnId isSafeFn (ExprField base _ _) =
  walkExprUnsafeInner mFnId isSafeFn base

walkExprUnsafeInner mFnId isSafeFn (ExprIndex expr idx _) =
  walkExprUnsafeInner mFnId isSafeFn expr >> walkExprUnsafeInner mFnId isSafeFn idx

walkExprUnsafeInner mFnId isSafeFn (ExprTry expr _) =
  walkExprUnsafeInner mFnId isSafeFn expr

walkExprUnsafeInner mFnId isSafeFn (ExprAwait expr _) =
  walkExprUnsafeInner mFnId isSafeFn expr

walkExprUnsafeInner mFnId isSafeFn (ExprCast expr _ _) =
  walkExprUnsafeInner mFnId isSafeFn expr

walkExprUnsafeInner mFnId isSafeFn (ExprTuple elems _) =
  mapM_ (walkExprUnsafeInner mFnId isSafeFn) elems

walkExprUnsafeInner mFnId isSafeFn (ExprArray elems _) =
  mapM_ (walkExprUnsafeInner mFnId isSafeFn) elems

walkExprUnsafeInner mFnId isSafeFn (ExprUnsafe blk sp) = do
  -- Emit UNSAFE_BLOCK node for nested unsafe block too
  walkUnsafe (ExprUnsafe blk sp)
  -- Then walk contents inside the unsafe context for WRAPS_UNSAFE edges
  walkBlockUnsafe blk mFnId isSafeFn

walkExprUnsafeInner mFnId isSafeFn (ExprAsync _ blk _) =
  walkBlockUnsafe blk mFnId isSafeFn

walkExprUnsafeInner mFnId isSafeFn (ExprReturn mExpr _) =
  mapM_ (walkExprUnsafeInner mFnId isSafeFn) mExpr

walkExprUnsafeInner mFnId isSafeFn (ExprBreak mExpr _ _) =
  mapM_ (walkExprUnsafeInner mFnId isSafeFn) mExpr

walkExprUnsafeInner mFnId isSafeFn (ExprRange mStart mEnd _) =
  mapM_ (walkExprUnsafeInner mFnId isSafeFn) mStart >> mapM_ (walkExprUnsafeInner mFnId isSafeFn) mEnd

walkExprUnsafeInner mFnId isSafeFn (ExprStruct _ fields mRest _) =
  mapM_ (walkExprUnsafeInner mFnId isSafeFn . snd) fields >> mapM_ (walkExprUnsafeInner mFnId isSafeFn) mRest

walkExprUnsafeInner mFnId isSafeFn (ExprLet _ expr _) =
  walkExprUnsafeInner mFnId isSafeFn expr

walkExprUnsafeInner mFnId isSafeFn (ExprReference expr _ _) =
  walkExprUnsafeInner mFnId isSafeFn expr

walkExprUnsafeInner mFnId isSafeFn (ExprLoop body _ _) =
  walkBlockUnsafe body mFnId isSafeFn

walkExprUnsafeInner mFnId isSafeFn (ExprWhile cond body _ _) =
  walkExprUnsafeInner mFnId isSafeFn cond >> walkBlockUnsafe body mFnId isSafeFn

walkExprUnsafeInner mFnId isSafeFn (ExprForLoop _ expr body _ _) =
  walkExprUnsafeInner mFnId isSafeFn expr >> walkBlockUnsafe body mFnId isSafeFn

-- Terminal expressions: no children
walkExprUnsafeInner _ _ (ExprPath _ _) = pure ()
walkExprUnsafeInner _ _ (ExprLit _ _) = pure ()
walkExprUnsafeInner _ _ (ExprContinue _ _) = pure ()
walkExprUnsafeInner _ _ (ExprUnknown _) = pure ()

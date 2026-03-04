{-# LANGUAGE OverloadedStrings #-}
-- | Phase 13 rule: closures and captures -- syntactic capture analysis.
--
-- Performs BEST-EFFORT syntactic analysis of closure capture patterns.
-- This is NOT a full borrow-checker-level analysis -- it identifies
-- free variables referenced in closure bodies that are not declared
-- locally or as closure parameters.
--
-- Handles these Rust closure patterns:
--   * @move || x@       -> CAPTURES_MOVE edge (closure -> x)
--   * @|| x@ (read)     -> CAPTURES edge (closure -> x)
--   * @|| { x = 1 }@    -> CAPTURES_MUT edge (closure -> x, mutation detected)
--
-- Edge types emitted:
--   * CAPTURES       -- closure reads an outer variable
--   * CAPTURES_MUT   -- closure mutates an outer variable
--   * CAPTURES_MOVE  -- move closure captures an outer variable
--
-- All edges are self-edges on the CLOSURE node (already emitted by
-- Phase 8 'Rules.Expressions') with @variable@ metadata identifying
-- the captured name.
--
-- Called from 'Rules.Declarations' for expression statements and let
-- binding initializers, running alongside 'walkExpr', 'walkOwnership',
-- 'walkErrorFlow', and 'walkUnsafe'.
module Rules.Closures
  ( walkClosureCaptures
  ) where

import Control.Monad (forM_)
import Data.List (nub)
import Data.Text (Text)
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

-- ── Name extraction ──────────────────────────────────────────────────

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

-- ── Pure helper functions ────────────────────────────────────────────

-- | Extract parameter names from patterns.
-- Closure inputs are patterns; we extract all bound identifiers.
patNames :: RustPat -> [Text]
patNames (PatIdent ident _ _ _)     = [ident]
patNames (PatTuple elems _)         = concatMap patNames elems
patNames (PatStruct _ fields _)     = concatMap (patNames . snd) fields
patNames (PatTupleStruct _ elems _) = concatMap patNames elems
patNames (PatOr cases _)            = concatMap patNames cases
patNames (PatSlice elems _)         = concatMap patNames elems
patNames (PatReference pat _ _)     = patNames pat
patNames _                          = []

-- | Collect all variable references (ExprPath names) from an expression.
-- Traverses the entire expression tree to find all path references.
collectRefs :: RustExpr -> [Text]
collectRefs (ExprPath path _)           = [path]
collectRefs (ExprCall func args _)      = collectRefs func ++ concatMap collectRefs args
collectRefs (ExprMethodCall recv _ args _) = collectRefs recv ++ concatMap collectRefs args
collectRefs (ExprBinary l _ r _)        = collectRefs l ++ collectRefs r
collectRefs (ExprUnary _ e _)           = collectRefs e
collectRefs (ExprBlock stmts _)         = concatMap collectRefsStmt stmts
collectRefs (ExprIf c t me _)           = collectRefs c ++ collectRefsBlock t ++ maybe [] collectRefs me
collectRefs (ExprMatch e arms _)        = collectRefs e ++ concatMap (collectRefs . raBody) arms
collectRefs (ExprLoop body _ _)         = collectRefsBlock body
collectRefs (ExprWhile c body _ _)      = collectRefs c ++ collectRefsBlock body
collectRefs (ExprForLoop _ e body _ _)  = collectRefs e ++ collectRefsBlock body
collectRefs (ExprAssign l r _)          = collectRefs l ++ collectRefs r
collectRefs (ExprField base _ _)        = collectRefs base
collectRefs (ExprIndex e idx _)         = collectRefs e ++ collectRefs idx
collectRefs (ExprTry e _)               = collectRefs e
collectRefs (ExprAwait e _)             = collectRefs e
collectRefs (ExprCast e _ _)            = collectRefs e
collectRefs (ExprTuple elems _)         = concatMap collectRefs elems
collectRefs (ExprArray elems _)         = concatMap collectRefs elems
collectRefs (ExprUnsafe blk _)          = collectRefsBlock blk
collectRefs (ExprAsync _ blk _)         = collectRefsBlock blk
collectRefs (ExprReturn me _)           = maybe [] collectRefs me
collectRefs (ExprBreak me _ _)          = maybe [] collectRefs me
collectRefs (ExprRange ms me _)         = maybe [] collectRefs ms ++ maybe [] collectRefs me
collectRefs (ExprStruct _ fields mr _)  = concatMap (collectRefs . snd) fields ++ maybe [] collectRefs mr
collectRefs (ExprLet _ e _)             = collectRefs e
collectRefs (ExprReference e _ _)       = collectRefs e
collectRefs (ExprClosure _ _ _ _ _)     = []  -- don't look inside nested closures
collectRefs _                           = []  -- Lit, Continue, Unknown

-- | Collect refs from a block.
collectRefsBlock :: RustBlock -> [Text]
collectRefsBlock (RustBlock stmts) = concatMap collectRefsStmt stmts

-- | Collect refs from a statement.
collectRefsStmt :: RustStmt -> [Text]
collectRefsStmt (StmtExpr e)    = collectRefs e
collectRefsStmt (StmtSemi e)    = collectRefs e
collectRefsStmt (StmtLocal _ me _) = maybe [] collectRefs me
collectRefsStmt (StmtItem _)    = []
collectRefsStmt (StmtMacro _)   = []

-- | Collect variables that appear on the left side of assignments (mutation targets).
-- These are variables being mutated in the closure body.
collectMutTargets :: RustExpr -> [Text]
collectMutTargets (ExprAssign (ExprPath name _) r _) = name : collectMutTargets r
collectMutTargets (ExprAssign l r _)          = collectMutTargets l ++ collectMutTargets r
collectMutTargets (ExprCall func args _)      = collectMutTargets func ++ concatMap collectMutTargets args
collectMutTargets (ExprMethodCall recv _ args _) = collectMutTargets recv ++ concatMap collectMutTargets args
collectMutTargets (ExprBinary l _ r _)        = collectMutTargets l ++ collectMutTargets r
collectMutTargets (ExprUnary _ e _)           = collectMutTargets e
collectMutTargets (ExprBlock stmts _)         = concatMap collectMutTargetsStmt stmts
collectMutTargets (ExprIf c t me _)           = collectMutTargets c ++ collectMutTargetsBlock t ++ maybe [] collectMutTargets me
collectMutTargets (ExprMatch e arms _)        = collectMutTargets e ++ concatMap (collectMutTargets . raBody) arms
collectMutTargets (ExprLoop body _ _)         = collectMutTargetsBlock body
collectMutTargets (ExprWhile c body _ _)      = collectMutTargets c ++ collectMutTargetsBlock body
collectMutTargets (ExprForLoop _ e body _ _)  = collectMutTargets e ++ collectMutTargetsBlock body
collectMutTargets (ExprField _ _ _)           = []
collectMutTargets (ExprIndex e idx _)         = collectMutTargets e ++ collectMutTargets idx
collectMutTargets (ExprTry e _)               = collectMutTargets e
collectMutTargets (ExprAwait e _)             = collectMutTargets e
collectMutTargets (ExprCast e _ _)            = collectMutTargets e
collectMutTargets (ExprTuple elems _)         = concatMap collectMutTargets elems
collectMutTargets (ExprArray elems _)         = concatMap collectMutTargets elems
collectMutTargets (ExprUnsafe blk _)          = collectMutTargetsBlock blk
collectMutTargets (ExprAsync _ blk _)         = collectMutTargetsBlock blk
collectMutTargets (ExprReturn me _)           = maybe [] collectMutTargets me
collectMutTargets (ExprBreak me _ _)          = maybe [] collectMutTargets me
collectMutTargets (ExprRange ms me _)         = maybe [] collectMutTargets ms ++ maybe [] collectMutTargets me
collectMutTargets (ExprStruct _ fields mr _)  = concatMap (collectMutTargets . snd) fields ++ maybe [] collectMutTargets mr
collectMutTargets (ExprLet _ e _)             = collectMutTargets e
collectMutTargets (ExprReference e _ _)       = collectMutTargets e
collectMutTargets (ExprClosure _ _ _ _ _)     = []  -- don't look inside nested closures
collectMutTargets _                           = []  -- Path, Lit, Continue, Unknown

-- | Collect mutation targets from a block.
collectMutTargetsBlock :: RustBlock -> [Text]
collectMutTargetsBlock (RustBlock stmts) = concatMap collectMutTargetsStmt stmts

-- | Collect mutation targets from a statement.
collectMutTargetsStmt :: RustStmt -> [Text]
collectMutTargetsStmt (StmtExpr e)      = collectMutTargets e
collectMutTargetsStmt (StmtSemi e)      = collectMutTargets e
collectMutTargetsStmt (StmtLocal _ me _) = maybe [] collectMutTargets me
collectMutTargetsStmt (StmtItem _)      = []
collectMutTargetsStmt (StmtMacro _)     = []

-- | Collect locally declared variable names (let bindings in the body).
-- These are NOT captures -- they are declared inside the closure.
collectLocalDecls :: RustExpr -> [Text]
collectLocalDecls (ExprBlock stmts _)         = concatMap collectLocalDeclsStmt stmts
collectLocalDecls (ExprIf _ t me _)           = collectLocalDeclsBlock t ++ maybe [] collectLocalDecls me
collectLocalDecls (ExprMatch _ arms _)        = concatMap (collectLocalDecls . raBody) arms
collectLocalDecls (ExprLoop body _ _)         = collectLocalDeclsBlock body
collectLocalDecls (ExprWhile _ body _ _)      = collectLocalDeclsBlock body
collectLocalDecls (ExprForLoop pat _ body _ _) = patNames pat ++ collectLocalDeclsBlock body
collectLocalDecls (ExprUnsafe blk _)          = collectLocalDeclsBlock blk
collectLocalDecls (ExprAsync _ blk _)         = collectLocalDeclsBlock blk
collectLocalDecls (ExprClosure _ _ _ _ _)     = []  -- don't look inside nested closures
collectLocalDecls _                           = []

-- | Collect local declarations from a block.
collectLocalDeclsBlock :: RustBlock -> [Text]
collectLocalDeclsBlock (RustBlock stmts) = concatMap collectLocalDeclsStmt stmts

-- | Collect local declarations from a statement.
-- StmtLocal (let bindings) produce local declarations.
collectLocalDeclsStmt :: RustStmt -> [Text]
collectLocalDeclsStmt (StmtLocal pat _ _) = patNames pat
collectLocalDeclsStmt (StmtExpr e)        = collectLocalDecls e
collectLocalDeclsStmt (StmtSemi e)        = collectLocalDecls e
collectLocalDeclsStmt (StmtItem _)        = []
collectLocalDeclsStmt (StmtMacro _)       = []

-- ── Closure capture walker ──────────────────────────────────────────

-- | Walk an expression tree looking for closures and analyze their captures.
--
-- For each closure found, determines free variables (referenced in body
-- but not declared locally or as parameters) and emits capture edges:
--
--   * @move@ closure -> CAPTURES_MOVE for all free variables
--   * Non-move, variable mutated -> CAPTURES_MUT
--   * Non-move, variable read-only -> CAPTURES
--
-- Edges are self-edges on the CLOSURE node with @variable@ metadata.
--
-- This walker recurses into all expression children looking for closures,
-- including nested closures (which get their own capture analysis).
walkClosureCaptures :: RustExpr -> Analyzer ()

-- ── Closure expression ──────────────────────────────────────────────

walkClosureCaptures (ExprClosure inputs _output body isMove sp) = do
  file  <- askFile
  encFn <- askEnclosingFn

  let (line, col) = spanLC sp
      parent = encFn >>= extractName
      hash = posHash line col
      closureId = semanticId file "CLOSURE" "<closure>" parent (Just hash)
      -- Collect parameter names (these are NOT captures)
      paramNameList = concatMap patNames inputs
      -- Find all variable references in the body
      bodyRefs = collectRefs body
      -- Find mutation targets in the body (left side of ExprAssign)
      mutTargets = collectMutTargets body
      -- Find all locally declared variables
      localDecls = collectLocalDecls body
      -- Free variables = referenced but not declared locally and not parameters
      freeVars = filter (\name -> name `notElem` paramNameList && name `notElem` localDecls) bodyRefs

  -- Emit capture edges for each unique free variable
  forM_ (nub freeVars) $ \varName -> do
    let edgeType
          | isMove                 = "CAPTURES_MOVE"
          | varName `elem` mutTargets = "CAPTURES_MUT"
          | otherwise              = "CAPTURES"
    emitEdge GraphEdge
      { geSource   = closureId
      , geTarget   = closureId  -- self-edge with metadata
      , geType     = edgeType
      , geMetadata = Map.fromList [("variable", MetaText varName)]
      }

  -- Recurse into body for nested closures
  walkClosureCaptures body

-- ── Transparent expressions: recurse into children ───────────────────

walkClosureCaptures (ExprCall func args _) =
  walkClosureCaptures func >> mapM_ walkClosureCaptures args

walkClosureCaptures (ExprMethodCall recv _ args _) =
  walkClosureCaptures recv >> mapM_ walkClosureCaptures args

walkClosureCaptures (ExprBinary left _ right _) =
  walkClosureCaptures left >> walkClosureCaptures right

walkClosureCaptures (ExprUnary _ expr _) =
  walkClosureCaptures expr

walkClosureCaptures (ExprIf cond thenBlock mElse _) =
  walkClosureCaptures cond >> walkBlockCC thenBlock >> mapM_ walkClosureCaptures mElse

walkClosureCaptures (ExprMatch expr arms _) =
  walkClosureCaptures expr >> mapM_ (walkClosureCaptures . raBody) arms

walkClosureCaptures (ExprBlock stmts _) =
  mapM_ walkStmtCC stmts

walkClosureCaptures (ExprAssign left right _) =
  walkClosureCaptures left >> walkClosureCaptures right

walkClosureCaptures (ExprField base _ _) =
  walkClosureCaptures base

walkClosureCaptures (ExprIndex expr idx _) =
  walkClosureCaptures expr >> walkClosureCaptures idx

walkClosureCaptures (ExprTry expr _) =
  walkClosureCaptures expr

walkClosureCaptures (ExprAwait expr _) =
  walkClosureCaptures expr

walkClosureCaptures (ExprCast expr _ _) =
  walkClosureCaptures expr

walkClosureCaptures (ExprTuple elems _) =
  mapM_ walkClosureCaptures elems

walkClosureCaptures (ExprArray elems _) =
  mapM_ walkClosureCaptures elems

walkClosureCaptures (ExprUnsafe blk _) =
  walkBlockCC blk

walkClosureCaptures (ExprAsync _ blk _) =
  walkBlockCC blk

walkClosureCaptures (ExprReturn mExpr _) =
  mapM_ walkClosureCaptures mExpr

walkClosureCaptures (ExprBreak mExpr _ _) =
  mapM_ walkClosureCaptures mExpr

walkClosureCaptures (ExprRange mStart mEnd _) =
  mapM_ walkClosureCaptures mStart >> mapM_ walkClosureCaptures mEnd

walkClosureCaptures (ExprStruct _ fields mRest _) =
  mapM_ (walkClosureCaptures . snd) fields >> mapM_ walkClosureCaptures mRest

walkClosureCaptures (ExprLet _ expr _) =
  walkClosureCaptures expr

walkClosureCaptures (ExprReference expr _ _) =
  walkClosureCaptures expr

walkClosureCaptures (ExprLoop body _ _) =
  walkBlockCC body

walkClosureCaptures (ExprWhile cond body _ _) =
  walkClosureCaptures cond >> walkBlockCC body

walkClosureCaptures (ExprForLoop _ expr body _ _) =
  walkClosureCaptures expr >> walkBlockCC body

-- ── Terminal expressions: no children ────────────────────────────────

walkClosureCaptures (ExprPath _ _) = pure ()
walkClosureCaptures (ExprLit _ _) = pure ()
walkClosureCaptures (ExprContinue _ _) = pure ()
walkClosureCaptures (ExprUnknown _) = pure ()

-- ── Block & statement helpers ────────────────────────────────────────

-- | Walk all statements in a block for closure captures.
walkBlockCC :: RustBlock -> Analyzer ()
walkBlockCC (RustBlock stmts) = mapM_ walkStmtCC stmts

-- | Walk a single statement for closure captures.
walkStmtCC :: RustStmt -> Analyzer ()
walkStmtCC (StmtExpr expr)      = walkClosureCaptures expr
walkStmtCC (StmtSemi expr)      = walkClosureCaptures expr
walkStmtCC (StmtLocal _ mInit _) = mapM_ walkClosureCaptures mInit
walkStmtCC (StmtItem _)         = pure ()
walkStmtCC (StmtMacro _)        = pure ()

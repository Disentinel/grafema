{-# LANGUAGE OverloadedStrings #-}
-- | Phase 4 & 5 rule: expression-level graph nodes and DFG edges.
--
-- Walks GHC 'HsExpr GhcPs' constructors and emits expression-level
-- graph nodes: REFERENCE, CALL, LAMBDA, BRANCH, DO_BLOCK, LET_BLOCK.
--
-- Phase 5 adds Data Flow Graph (DFG) edges:
--   * 'DERIVES_FROM' — value derivation (argument → operator result, etc.)
--
-- Called from 'Analysis.Walker' when walking into function bodies,
-- match RHSes, and other expression contexts.
--
-- Priority constructors handled:
--   * 'HsVar'       -> REFERENCE node
--   * 'HsApp'       -> CALL node (function application) + DERIVES_FROM edges
--   * 'OpApp'       -> CALL node (operator application) + DERIVES_FROM edges
--   * 'HsLam'       -> LAMBDA node + DERIVES_FROM from body
--   * 'HsLamCase'   -> LAMBDA node
--   * 'HsCase'      -> BRANCH node + DERIVES_FROM from alternatives
--   * 'HsIf'        -> BRANCH node + DERIVES_FROM from branches
--   * 'HsMultiIf'   -> BRANCH node
--   * 'HsDo'        -> DO_BLOCK node + DERIVES_FROM from last statement
--   * 'HsLet'       -> LET_BLOCK node + DERIVES_FROM from body
--   * 'HsPar'       -> transparent (recurse through, pass node ID)
--   * 'ExplicitList' -> recurse into elements
--   * 'ExplicitTuple' -> recurse into present elements
--   * 'NegApp'      -> recurse into negated expression
--   * 'SectionL'/'SectionR' -> recurse into children
--   * 'ExprWithTySig' -> recurse into expression
--   * 'HsAppType'   -> recurse into expression
--   * Literals      -> skip (no nodes emitted)
--   * Everything else -> skip via catch-all
module Rules.Expressions
  ( walkExpr
  , walkMatchGroup
  , walkGRHSs
  , MatchScopeTag
  , functionClauseTag
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GHC.Hs (GhcPs)
import GHC.Hs.Expr
  ( HsExpr(..)
  , LHsExpr
  , MatchGroup(..)
  , GRHSs(..)
  , GRHS(..)
  , Match(..)
  , StmtLR(..)
  , LamCaseVariant(..)
  , HsTupArg(..)
  )
import GHC.Hs.Binds
  ( HsLocalBindsLR(..)
  , HsValBindsLR(..)
  , HsBindLR(..)
  )
import GHC.Data.Bag (bagToList)
import GHC.Types.SrcLoc (GenLocated(..), unLoc)
import GHC.Parser.Annotation (SrcSpanAnnA)
import GHC.Types.Name.Reader (rdrNameOcc)
import GHC.Types.Name.Occurrence (occNameString)

import Analysis.Context
  ( Analyzer
  , emitNode
  , emitEdge
  , askFile
  , askScopeId
  , withEnclosingFn
  )
import Analysis.Scope (withScopeNode)
import Analysis.Types (GraphNode(..), GraphEdge(..), MetaValue(..), ScopeKind(..))
import Grafema.SemanticId (semanticId)
import Loc (getLoc)

import Rules.Patterns (walkPat)
import Rules.Declarations (walkFunBind, walkPatBind)

-- | Emit a DERIVES_FROM edge from a child node to a parent node.
-- No-op if the child ID is Nothing.
emitDerivedFrom :: Maybe T.Text -> T.Text -> Analyzer ()
emitDerivedFrom Nothing _ = pure ()
emitDerivedFrom (Just childId) parentId =
  emitEdge GraphEdge
    { geSource   = childId
    , geTarget   = parentId
    , geType     = "DERIVES_FROM"
    , geMetadata = Map.empty
    }

-- | Walk a located expression, emitting expression-level graph nodes
-- and DFG edges.
--
-- This is the main entry point for Phase 4/5 expression walking. It
-- unwraps the location annotation and dispatches to the appropriate
-- handler based on the 'HsExpr' constructor.
--
-- Returns 'Just nodeId' if a graph node was emitted for this expression,
-- 'Nothing' for transparent or skipped expressions (literals, parentheses).
-- Parent expressions use the returned ID to emit DERIVES_FROM edges.
--
-- The function is recursive: composite expressions (application,
-- case, if, do, let) walk into their children.
walkExpr :: LHsExpr GhcPs -> Analyzer (Maybe T.Text)
walkExpr (L ann expr) = do
  let (line, col, endLine, endCol) = getLoc (L ann expr)
  case expr of
    -- ── Variable reference ─────────────────────────────────────────
    HsVar _ (L _ name) -> do
      file <- askFile
      scopeId <- askScopeId
      let refName = T.pack (occNameString (rdrNameOcc name))
      let nodeId = semanticId file "REFERENCE" refName Nothing
                     (Just (T.pack (show line <> ":" <> show col)))
      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "REFERENCE"
        , gnName      = refName
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = endLine
        , gnEndColumn = endCol
        , gnExported  = False
        , gnMetadata  = Map.empty
        }
      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }
      return (Just nodeId)

    -- ── Function application ───────────────────────────────────────
    HsApp _ fun arg -> do
      let mbCallName = extractCallName (unLoc fun)
      mbNodeId <- case mbCallName of
        Just callName -> do
          file <- askFile
          scopeId <- askScopeId
          let nodeId = semanticId file "CALL" callName Nothing
                         (Just (T.pack (show line <> ":" <> show col)))
          emitNode GraphNode
            { gnId        = nodeId
            , gnType      = "CALL"
            , gnName      = callName
            , gnFile      = file
            , gnLine      = line
            , gnColumn    = col
            , gnEndLine   = endLine
            , gnEndColumn = endCol
            , gnExported  = False
            , gnMetadata  = Map.empty
            }
          emitEdge GraphEdge
            { geSource   = scopeId
            , geTarget   = nodeId
            , geType     = "CONTAINS"
            , geMetadata = Map.empty
            }
          return (Just nodeId)
        Nothing -> return Nothing
      -- Recurse into function and argument
      _ <- walkExpr fun
      argResult <- walkExpr arg
      -- DFG: argument flows into call result
      case mbNodeId of
        Just nid -> emitDerivedFrom argResult nid
        Nothing  -> pure ()
      return mbNodeId

    -- ── Visible type application ───────────────────────────────────
    HsAppType _ e _ _ ->
      walkExpr e

    -- ── Operator application ───────────────────────────────────────
    OpApp _ left op right -> do
      let mbOpName = extractCallName (unLoc op)
      mbNodeId <- case mbOpName of
        Just opName -> do
          file <- askFile
          scopeId <- askScopeId
          let nodeId = semanticId file "CALL" opName Nothing
                         (Just (T.pack (show line <> ":" <> show col)))
          emitNode GraphNode
            { gnId        = nodeId
            , gnType      = "CALL"
            , gnName      = opName
            , gnFile      = file
            , gnLine      = line
            , gnColumn    = col
            , gnEndLine   = endLine
            , gnEndColumn = endCol
            , gnExported  = False
            , gnMetadata  = Map.singleton "operator" (MetaText opName)
            }
          emitEdge GraphEdge
            { geSource   = scopeId
            , geTarget   = nodeId
            , geType     = "CONTAINS"
            , geMetadata = Map.empty
            }
          return (Just nodeId)
        Nothing -> return Nothing
      leftResult <- walkExpr left
      _ <- walkExpr op
      rightResult <- walkExpr right
      -- DFG: both operands flow into operator result
      case mbNodeId of
        Just nid -> do
          emitDerivedFrom leftResult nid
          emitDerivedFrom rightResult nid
        Nothing -> pure ()
      return mbNodeId

    -- ── Negation ───────────────────────────────────────────────────
    NegApp _ e _ ->
      walkExpr e

    -- ── Lambda ─────────────────────────────────────────────────────
    HsLam _ mg -> do
      file <- askFile
      scopeId <- askScopeId
      let nodeId = semanticId file "LAMBDA" "lambda" Nothing
                     (Just (T.pack (show line <> ":" <> show col)))
      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "LAMBDA"
        , gnName      = "lambda"
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = endLine
        , gnEndColumn = endCol
        , gnExported  = False
        , gnMetadata  = Map.empty
        }
      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }
      bodyResults <- walkMatchGroupResults lambdaMatchTag nodeId mg
      -- DFG: match bodies flow into lambda result
      mapM_ (\r -> emitDerivedFrom r nodeId) bodyResults
      return (Just nodeId)

    -- ── Lambda case / Lambda cases ─────────────────────────────────
    HsLamCase _ variant mg -> do
      file <- askFile
      scopeId <- askScopeId
      let variantName = case variant of
            LamCase  -> "lambda-case"
            LamCases -> "lambda-cases"
      let nodeId = semanticId file "LAMBDA" variantName Nothing
                     (Just (T.pack (show line <> ":" <> show col)))
      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "LAMBDA"
        , gnName      = variantName
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = endLine
        , gnEndColumn = endCol
        , gnExported  = False
        , gnMetadata  = Map.singleton "variant" (MetaText variantName)
        }
      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }
      bodyResults <- walkMatchGroupResults lambdaMatchTag nodeId mg
      -- DFG: match bodies flow into lambda-case result
      mapM_ (\r -> emitDerivedFrom r nodeId) bodyResults
      return (Just nodeId)

    -- ── Case expression ────────────────────────────────────────────
    HsCase _ scrut mg -> do
      file <- askFile
      scopeId <- askScopeId
      let nodeId = semanticId file "BRANCH" "case" Nothing
                     (Just (T.pack (show line <> ":" <> show col)))
      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "BRANCH"
        , gnName      = "case"
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = endLine
        , gnEndColumn = endCol
        , gnExported  = False
        , gnMetadata  = Map.singleton "kind" (MetaText "case")
        }
      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }
      _ <- walkExpr scrut
      bodyResults <- walkMatchGroupResults caseAltTag nodeId mg
      -- DFG: each case alternative body flows into the BRANCH result
      mapM_ (\r -> emitDerivedFrom r nodeId) bodyResults
      return (Just nodeId)

    -- ── If expression ──────────────────────────────────────────────
    HsIf _ cond thenE elseE -> do
      file <- askFile
      scopeId <- askScopeId
      let nodeId = semanticId file "BRANCH" "if" Nothing
                     (Just (T.pack (show line <> ":" <> show col)))
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
        , gnMetadata  = Map.singleton "kind" (MetaText "if")
        }
      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }
      _ <- walkExpr cond
      thenResult <- walkExpr thenE
      elseResult <- walkExpr elseE
      -- DFG: both branches flow into the BRANCH result
      emitDerivedFrom thenResult nodeId
      emitDerivedFrom elseResult nodeId
      return (Just nodeId)

    -- ── Multi-way if ───────────────────────────────────────────────
    HsMultiIf _ grhss -> do
      file <- askFile
      scopeId <- askScopeId
      let nodeId = semanticId file "BRANCH" "multi-if" Nothing
                     (Just (T.pack (show line <> ":" <> show col)))
      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "BRANCH"
        , gnName      = "multi-if"
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = endLine
        , gnEndColumn = endCol
        , gnExported  = False
        , gnMetadata  = Map.singleton "kind" (MetaText "multi-if")
        }
      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }
      bodyResults <- mapM walkGRHSResult grhss
      -- DFG: each guard body flows into the multi-if result
      mapM_ (\r -> emitDerivedFrom r nodeId) bodyResults
      return (Just nodeId)

    -- ── Do expression ──────────────────────────────────────────────
    HsDo _ _ctxt (L _ stmts) -> do
      file <- askFile
      scopeId <- askScopeId
      let nodeId = semanticId file "DO_BLOCK" "do" Nothing
                     (Just (T.pack (show line <> ":" <> show col)))
      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "DO_BLOCK"
        , gnName      = "do"
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = endLine
        , gnEndColumn = endCol
        , gnExported  = False
        , gnMetadata  = Map.empty
        }
      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }
      lastResult <- walkStmtsResult stmts
      -- DFG: last statement flows into DO_BLOCK result
      emitDerivedFrom lastResult nodeId
      return (Just nodeId)

    -- ── Let expression ─────────────────────────────────────────────
    -- GHC 9.8: HsLet _ tkLet binds tkIn body
    HsLet _ _tkLet binds _tkIn body -> do
      file <- askFile
      scopeId <- askScopeId
      let nodeId = semanticId file "LET_BLOCK" "let" Nothing
                     (Just (T.pack (show line <> ":" <> show col)))
      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "LET_BLOCK"
        , gnName      = "let"
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = endLine
        , gnEndColumn = endCol
        , gnExported  = False
        , gnMetadata  = Map.empty
        }
      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }
      -- let-bound names are visible in BOTH the binds and the body, so
      -- wrap both in a single LetScope anchored on the LET_BLOCK node id.
      bodyResult <- withScopeNode LetScope nodeId $ do
        walkLocalBinds binds
        walkExpr body
      -- DFG: body expression flows into LET_BLOCK result
      emitDerivedFrom bodyResult nodeId
      return (Just nodeId)

    -- ── Parenthesized expression (transparent) ─────────────────────
    -- GHC 9.8: HsPar _ tkOpen expr tkClose
    HsPar _ _ e _ ->
      walkExpr e

    -- ── Explicit list ──────────────────────────────────────────────
    ExplicitList _ elems -> do
      mapM_ walkExpr elems
      return Nothing

    -- ── Explicit tuple ─────────────────────────────────────────────
    ExplicitTuple _ args _ -> do
      mapM_ walkTupArg args
      return Nothing

    -- ── Sections ───────────────────────────────────────────────────
    SectionL _ e op -> do
      _ <- walkExpr e
      walkExpr op

    SectionR _ op e -> do
      _ <- walkExpr op
      walkExpr e

    -- ── Record construction ────────────────────────────────────────
    RecordCon _ _name _fields ->
      return Nothing  -- Record field walking deferred to later phase

    -- ── Record update ──────────────────────────────────────────────
    RecordUpd _ e _fields ->
      walkExpr e

    -- ── Expression with type signature ─────────────────────────────
    ExprWithTySig _ e _ ->
      walkExpr e

    -- ── Arithmetic sequence ────────────────────────────────────────
    ArithSeq _ _ _info ->
      return Nothing  -- Deferred to later phase

    -- ── Literals ───────────────────────────────────────────────────
    HsLit _ _    -> return Nothing
    HsOverLit _ _ -> return Nothing

    -- ── Catch-all for unhandled constructors ───────────────────────
    _ -> return Nothing

-- ── Helpers ──────────────────────────────────────────────────────────

-- | Extract the function name from the leftmost 'HsVar' in an
-- application chain.
--
-- @f x y@ is represented as @HsApp (HsApp (HsVar f) x) y@.
-- This function traverses the left spine to extract @\"f\"@.
extractCallName :: HsExpr GhcPs -> Maybe T.Text
extractCallName (HsVar _ (L _ name)) =
  Just (T.pack (occNameString (rdrNameOcc name)))
extractCallName (HsApp _ (L _ fun) _) =
  extractCallName fun
extractCallName (HsPar _ _ (L _ e) _) =
  extractCallName e
extractCallName _ = Nothing

-- | Tag identifying what kind of lexical block a per-'Match' scope is.
-- The pair carries both the 'ScopeKind' stamped onto the SCOPE node and
-- the textual tag woven into its anchor id (so sibling clauses\/alts
-- never collide).
data MatchScopeTag = MatchScopeTag !ScopeKind !T.Text

functionClauseTag :: MatchScopeTag
functionClauseTag = MatchScopeTag FunctionScope "clause"

caseAltTag :: MatchScopeTag
caseAltTag = MatchScopeTag CaseScope "alt"

lambdaMatchTag :: MatchScopeTag
lambdaMatchTag = MatchScopeTag LambdaScope "lam"

-- | Build the per-'Match' scope anchor id: @\<base\>:\<tag\>@\<line\>:\<col\>@.
-- Position-stamped so sibling clauses\/alternatives of the same owner
-- never produce the same SCOPE node id.
matchScopeAnchor :: T.Text -> T.Text -> Int -> Int -> T.Text
matchScopeAnchor base tag line col =
  base <> ":" <> tag <> "@" <> T.pack (show line) <> ":" <> T.pack (show col)

-- | Wrap a per-'Match' action in its own lexical SCOPE.
-- The scope kind\/tag come from the 'MatchScopeTag'; the anchor base is
-- the enclosing owner id (function id, case BRANCH id, lambda id).
withMatchScope
  :: MatchScopeTag
  -> T.Text                                  -- ^ anchor base (owner id)
  -> GenLocated SrcSpanAnnA (Match GhcPs (LHsExpr GhcPs))
  -> Analyzer a
  -> Analyzer a
withMatchScope (MatchScopeTag kind tag) base lmatch inner =
  let (line, col, _, _) = getLoc lmatch
  in withScopeNode kind (matchScopeAnchor base tag line col) inner

-- | Walk a 'MatchGroup', recursing into each alternative's RHS, pushing
-- a per-'Match' lexical SCOPE around each clause\/alternative so its
-- params and body occurrences are CONTAINS'd from the finer scope.
-- Discards per-match results (use 'walkMatchGroupResults' when
-- DFG edges are needed from the caller).
walkMatchGroup :: MatchScopeTag -> T.Text -> MatchGroup GhcPs (LHsExpr GhcPs) -> Analyzer ()
walkMatchGroup mtag base mg =
  let alts = unLoc (mg_alts mg)
  in  mapM_ (walkMatch mtag base) alts

-- | Walk a 'MatchGroup', returning the body result IDs from each
-- alternative. Used by LAMBDA, CASE, etc. to emit DERIVES_FROM edges.
-- Pushes a per-'Match' lexical SCOPE around each alternative.
walkMatchGroupResults :: MatchScopeTag -> T.Text -> MatchGroup GhcPs (LHsExpr GhcPs) -> Analyzer [Maybe T.Text]
walkMatchGroupResults mtag base mg =
  let alts = unLoc (mg_alts mg)
  in  mapM (walkMatchResult mtag base) alts

-- | Walk a single 'Match', recursing into patterns and guarded RHSes,
-- inside its own per-clause lexical SCOPE. The patterns (params) and the
-- body refs\/calls are CONTAINS'd from this scope, not the enclosing
-- function\/branch.
walkMatch :: MatchScopeTag -> T.Text -> GenLocated SrcSpanAnnA (Match GhcPs (LHsExpr GhcPs)) -> Analyzer ()
walkMatch mtag base lmatch@(L _ (Match _ _ctx pats grhss)) =
  withMatchScope mtag base lmatch $ do
    mapM_ walkPat pats
    walkGRHSs grhss

-- | Walk a single 'Match', returning the body result ID from the
-- first GRHS. Used for DFG edge emission. Pushes the per-clause scope.
walkMatchResult :: MatchScopeTag -> T.Text -> GenLocated SrcSpanAnnA (Match GhcPs (LHsExpr GhcPs)) -> Analyzer (Maybe T.Text)
walkMatchResult mtag base lmatch@(L _ (Match _ _ctx pats grhss)) =
  withMatchScope mtag base lmatch $ do
    mapM_ walkPat pats
    walkGRHSsResult grhss

-- | Walk guarded RHSes, including local binds (where clause).
-- When the @where@ block is non-empty, both the guarded bodies AND the
-- where bindings are wrapped in a single child 'WhereScope' (Haskell
-- scoping: where-bound names are visible in all guards\/RHS of the clause
-- and in the where bindings themselves). The where anchor is derived from
-- the current (clause) scope id.
walkGRHSs :: GRHSs GhcPs (LHsExpr GhcPs) -> Analyzer ()
walkGRHSs (GRHSs _ grhsList localBinds)
  | isEmptyLocalBinds localBinds =
      mapM_ walkGRHS grhsList
  | otherwise = do
      anchor <- whereScopeAnchor
      withScopeNode WhereScope anchor $ do
        mapM_ walkGRHS grhsList
        walkLocalBinds localBinds

-- | Walk guarded RHSes, returning the body result ID from the first
-- GRHS. Used for DFG edge emission. Mirrors 'walkGRHSs' for the where
-- block: a non-empty @where@ wraps bodies + binds in a 'WhereScope'.
walkGRHSsResult :: GRHSs GhcPs (LHsExpr GhcPs) -> Analyzer (Maybe T.Text)
walkGRHSsResult (GRHSs _ grhsList localBinds)
  | isEmptyLocalBinds localBinds = do
      results <- mapM walkGRHSResult grhsList
      return (firstResult results)
  | otherwise = do
      anchor <- whereScopeAnchor
      withScopeNode WhereScope anchor $ do
        results <- mapM walkGRHSResult grhsList
        walkLocalBinds localBinds
        return (firstResult results)

-- | Return the first non-Nothing body result (typically only one GRHS for
-- unguarded equations; for guarded equations, any branch suffices).
firstResult :: [Maybe T.Text] -> Maybe T.Text
firstResult results = case filter (/= Nothing) results of
  (r:_) -> r
  []    -> Nothing

-- | The anchor for a clause's @where@ scope: @\<clauseScopeId\>:where@.
-- Derived from the enclosing (clause) scope id so it nests under it.
whereScopeAnchor :: Analyzer T.Text
whereScopeAnchor = do
  parent <- askScopeId
  return (parent <> ":where")

-- | True for an absent\/empty @where@\/@let@ binding block.
isEmptyLocalBinds :: HsLocalBindsLR GhcPs GhcPs -> Bool
isEmptyLocalBinds (EmptyLocalBinds _)        = True
isEmptyLocalBinds (HsValBinds _ (ValBinds _ binds sigs)) =
  null (bagToList binds) && null sigs
isEmptyLocalBinds _                          = False

-- | Walk a single guarded RHS. Guards are not walked (deferred to
-- Rules.Guards). The body expression is walked.
walkGRHS :: GenLocated l (GRHS GhcPs (LHsExpr GhcPs)) -> Analyzer ()
walkGRHS (L _ (GRHS _ _guards body)) = do
  _ <- walkExpr body
  pure ()

-- | Walk a single guarded RHS, returning the body result ID.
walkGRHSResult :: GenLocated l (GRHS GhcPs (LHsExpr GhcPs)) -> Analyzer (Maybe T.Text)
walkGRHSResult (L _ (GRHS _ _guards body)) =
  walkExpr body

-- | Walk do-block statements, returning the result ID from the last
-- statement. Used for DFG edge emission on DO_BLOCK nodes.
walkStmtsResult :: [GenLocated l (StmtLR GhcPs GhcPs (LHsExpr GhcPs))] -> Analyzer (Maybe T.Text)
walkStmtsResult [] = return Nothing
walkStmtsResult [s] = walkStmtResult s
walkStmtsResult (s:ss) = do
  _ <- walkStmtResult s
  walkStmtsResult ss

-- | Walk a do-block statement, recursing into contained expressions.
-- Returns the result ID of the statement's expression (if any).
walkStmtResult :: GenLocated l (StmtLR GhcPs GhcPs (LHsExpr GhcPs)) -> Analyzer (Maybe T.Text)
walkStmtResult (L _ stmt) = case stmt of
  -- x <- expr
  BindStmt _ pat body -> do
    walkPat pat
    walkExpr body
  -- expr (as statement)
  BodyStmt _ body _ _ ->
    walkExpr body
  -- let binds
  LetStmt _ binds -> do
    walkLocalBinds binds
    return Nothing
  -- last statement in do block
  LastStmt _ body _ _ ->
    walkExpr body
  -- Other statement types (TransStmt, ParStmt, etc.)
  _ -> return Nothing

-- | Walk local bindings (where clauses, let bindings).
-- Recurses into the RHS expressions of each binding.
walkLocalBinds :: HsLocalBindsLR GhcPs GhcPs -> Analyzer ()
walkLocalBinds (HsValBinds _ vb) = walkValBinds vb
walkLocalBinds (HsIPBinds _ _)   = pure ()  -- Implicit parameter binds
walkLocalBinds (EmptyLocalBinds _) = pure ()

-- | Walk value bindings, recursing into each binding's RHS.
walkValBinds :: HsValBindsLR GhcPs GhcPs -> Analyzer ()
walkValBinds (ValBinds _ binds _sigs) =
  mapM_ walkBind (bagToList binds)
walkValBinds (XValBindsLR _) = pure ()

-- | Walk a single local binding: emit the declaration node, then
-- recurse into the body expressions.
walkBind :: GenLocated l (HsBindLR GhcPs GhcPs) -> Analyzer ()
walkBind (L _ (FunBind { fun_id = funId, fun_matches = mg })) = do
  fnId <- walkFunBind funId mg   -- emit FUNCTION node for local binding
  -- Walk each clause inside its OWN per-clause scope (anchored on this
  -- local function id) so its params/refs/calls attach to the clause,
  -- not the enclosing module/function. The FUNCTION node itself stays
  -- MODULE-CONTAINS'd (emitted by walkFunBind).
  withEnclosingFn fnId $ walkMatchGroup functionClauseTag fnId mg
walkBind (L _ (PatBind { pat_lhs = pat, pat_rhs = grhss })) = do
  walkPatBind pat grhss     -- emit VARIABLE node for local binding
  walkGRHSs grhss           -- walk into the body
walkBind _ = pure ()

-- | Walk a tuple argument. 'Present' arguments contain an expression;
-- 'Missing' arguments (tuple sections) are skipped.
walkTupArg :: HsTupArg GhcPs -> Analyzer ()
walkTupArg (Present _ e) = do { _ <- walkExpr e; pure () }
walkTupArg (Missing _)   = pure ()

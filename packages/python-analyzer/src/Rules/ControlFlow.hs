{-# LANGUAGE OverloadedStrings #-}
-- | Control flow rule: emits LOOP, BRANCH, VARIABLE, and CASE nodes
-- for Python control flow statements.
--
-- Handles these Python statement types:
--   * 'ForStmt'    -> LOOP node (kind=for / async_for) + loop VARIABLE
--   * 'WhileStmt'  -> LOOP node (kind=while)
--   * 'IfStmt'     -> BRANCH node (kind=if)
--   * 'MatchStmt'  -> BRANCH node (kind=match) + CASE nodes
--   * 'WithStmt'   -> walks context expressions, emits VARIABLE for optional_vars
--
-- Node types: LOOP, BRANCH, VARIABLE, CASE
-- Edge types: CONTAINS, HAS_CASE
--
-- Called from the Walker for statement-level control flow analysis.
module Rules.ControlFlow
  ( walkControlFlow
  , walkComprehension
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import PythonAST
import Analysis.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , askFile
    , askScopeId
    , askNamedParent
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Span helpers ───────────────────────────────────────────────────────

spanLC :: Span -> (Int, Int)
spanLC sp = (posLine (spanStart sp), posCol (spanStart sp))

posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- ── Control flow walker ────────────────────────────────────────────────

-- | Walk a statement for control flow analysis. Emits LOOP, BRANCH,
-- VARIABLE, and CASE nodes as appropriate.
walkControlFlow :: PythonStmt -> Analyzer ()

-- ── LOOP: for / async for ──────────────────────────────────────────────

walkControlFlow (ForStmt target _iter body orelse isAsync sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let kind = if isAsync then "async_for" else "for" :: Text
      (line, col) = spanLC sp
      hash   = posHash line col
      nodeId = semanticId file "LOOP" kind parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "LOOP"
    , gnName      = kind
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",  MetaText kind)
        , ("async", MetaBool isAsync)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit VARIABLE node(s) for loop target
  walkLoopTarget file nodeId parent target

  -- Walk body and else statements
  mapM_ walkControlFlow body
  mapM_ walkControlFlow orelse

-- ── LOOP: while ────────────────────────────────────────────────────────

walkControlFlow (WhileStmt _test body orelse sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let (line, col) = spanLC sp
      hash   = posHash line col
      nodeId = semanticId file "LOOP" "while" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "LOOP"
    , gnName      = "while"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind", MetaText "while")
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk body and else statements
  mapM_ walkControlFlow body
  mapM_ walkControlFlow orelse

-- ── BRANCH: if/elif/else ───────────────────────────────────────────────

walkControlFlow (IfStmt _test body orelse sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let (line, col) = spanLC sp
      hash   = posHash line col
      nodeId = semanticId file "BRANCH" "if" parent (Just hash)

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
        [ ("kind",    MetaText "if")
        , ("hasElse", MetaBool (not (null orelse)))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk body and else statements
  mapM_ walkControlFlow body
  mapM_ walkControlFlow orelse

-- ── BRANCH: match/case ─────────────────────────────────────────────────

walkControlFlow (MatchStmt _subject cases sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let (line, col) = spanLC sp
      hash   = posHash line col
      nodeId = semanticId file "BRANCH" "match" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = "match"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",      MetaText "match")
        , ("caseCount", MetaInt (length cases))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit CASE nodes for each match case
  mapM_ (walkMatchCase file nodeId parent) (zip [0..] cases)

-- ── WITH statement: context manager ────────────────────────────────────

walkControlFlow (WithStmt items body _isAsync sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  -- Emit VARIABLE for each with-item that has optional_vars
  mapM_ (walkWithItem file scopeId parent sp) items

  -- Walk body statements
  mapM_ walkControlFlow body

-- ── TRY statement: walk body, handlers, else, finally ──────────────────

walkControlFlow (TryStmt tryBody handlers orelse finalBody sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let (line, col) = spanLC sp
      hash   = posHash line col
      nodeId = semanticId file "SCOPE" "try" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "SCOPE"
    , gnName      = "try"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",        MetaText "try")
        , ("handlerCount", MetaInt (length handlers))
        , ("hasElse",      MetaBool (not (null orelse)))
        , ("hasFinally",   MetaBool (not (null finalBody)))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk all sub-blocks
  mapM_ walkControlFlow tryBody
  mapM_ walkExceptHandler handlers
  mapM_ walkControlFlow orelse
  mapM_ walkControlFlow finalBody

-- ── Passthrough: walk sub-statements for nested control flow ───────────

-- Expression statements: may contain calls etc. but that is handled by
-- the expression walker; we only look for nested control flow here.
walkControlFlow (ExprStmt {})       = pure ()
walkControlFlow (ReturnStmt {})     = pure ()
walkControlFlow (AssignStmt {})     = pure ()
walkControlFlow (AugAssignStmt {})  = pure ()
walkControlFlow (AnnAssignStmt {})  = pure ()
walkControlFlow (DeleteStmt {})     = pure ()
walkControlFlow (ImportStmt {})     = pure ()
walkControlFlow (ImportFromStmt {}) = pure ()
walkControlFlow (GlobalStmt {})     = pure ()
walkControlFlow (NonlocalStmt {})   = pure ()
walkControlFlow (RaiseStmt {})      = pure ()
walkControlFlow (AssertStmt {})     = pure ()
walkControlFlow (PassStmt {})       = pure ()
walkControlFlow (BreakStmt {})      = pure ()
walkControlFlow (ContinueStmt {})   = pure ()
walkControlFlow (StmtUnknown {})    = pure ()

-- FunctionDef and ClassDef: their bodies are separate scopes handled by
-- Rules.Declarations, not by control flow walking.
walkControlFlow (FunctionDef {})    = pure ()
walkControlFlow (ClassDef {})       = pure ()

-- ── Loop target walker ─────────────────────────────────────────────────

-- | Extract names from a loop target expression and emit VARIABLE nodes.
-- Supports simple names, tuple/list unpacking.
walkLoopTarget :: Text -> Text -> Maybe Text -> PythonExpr -> Analyzer ()
walkLoopTarget file loopId parent (NameExpr name sp) = do
  let (line, col) = spanLC sp
      hash   = contentHash [("scope", loopId), ("name", name)]
      varId  = semanticId file "VARIABLE" name parent (Just hash)

  emitNode GraphNode
    { gnId        = varId
    , gnType      = "VARIABLE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "loop_variable")
    }

  emitEdge GraphEdge
    { geSource   = loopId
    , geTarget   = varId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

walkLoopTarget file loopId parent (TupleExpr elts _) =
  mapM_ (walkLoopTarget file loopId parent) elts

walkLoopTarget file loopId parent (ListExpr elts _) =
  mapM_ (walkLoopTarget file loopId parent) elts

walkLoopTarget file loopId parent (StarredExpr val _) =
  walkLoopTarget file loopId parent val

walkLoopTarget _ _ _ _ = pure ()

-- ── Match case walker ──────────────────────────────────────────────────

-- | Emit a CASE node for a match case and a HAS_CASE edge from the match branch.
walkMatchCase :: Text -> Text -> Maybe Text -> (Int, PythonMatchCase) -> Analyzer ()
walkMatchCase file matchId parent (idx, mc) = do
  let hash   = contentHash [("match", matchId), ("idx", T.pack (show idx))]
      caseId = semanticId file "CASE" (patternLabel (pmcPattern mc)) parent (Just hash)

  emitNode GraphNode
    { gnId        = caseId
    , gnType      = "CASE"
    , gnName      = patternLabel (pmcPattern mc)
    , gnFile      = file
    , gnLine      = 0
    , gnColumn    = 0
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("index",    MetaInt idx)
        , ("hasGuard", MetaBool (case pmcGuard mc of { Just _ -> True; Nothing -> False }))
        ]
    }

  emitEdge GraphEdge
    { geSource   = matchId
    , geTarget   = caseId
    , geType     = "HAS_CASE"
    , geMetadata = Map.empty
    }

  -- Walk body statements of the case
  mapM_ walkControlFlow (pmcBody mc)

-- | Generate a label for a pattern (for the CASE node name).
patternLabel :: PythonPattern -> Text
patternLabel (MatchValue _)       = "value"
patternLabel (MatchSingleton _)   = "singleton"
patternLabel (MatchSequence _)    = "sequence"
patternLabel (MatchMapping {})    = "mapping"
patternLabel (MatchClass {})      = "class"
patternLabel (MatchStar mName)    = case mName of
  Just n  -> "*" <> n
  Nothing -> "*_"
patternLabel (MatchAs _ mName)    = case mName of
  Just n  -> n
  Nothing -> "_"
patternLabel (MatchOr _)          = "or"
patternLabel PatternUnknown       = "<unknown>"

-- ── With-item walker ───────────────────────────────────────────────────

-- | Walk a with-item, emitting a VARIABLE node if optional_vars is present.
walkWithItem :: Text -> Text -> Maybe Text -> Span -> PythonWithItem -> Analyzer ()
walkWithItem file scopeId parent _sp item =
  case pwiOptionalVars item of
    Just varExpr -> walkWithVar file scopeId parent varExpr
    Nothing      -> pure ()

-- | Emit VARIABLE for a with-statement's optional_vars target.
walkWithVar :: Text -> Text -> Maybe Text -> PythonExpr -> Analyzer ()
walkWithVar file scopeId parent (NameExpr name sp) = do
  let (line, col) = spanLC sp
      hash   = contentHash [("scope", scopeId), ("name", name)]
      varId  = semanticId file "VARIABLE" name parent (Just hash)

  emitNode GraphNode
    { gnId        = varId
    , gnType      = "VARIABLE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.singleton "kind" (MetaText "with_variable")
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = varId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

walkWithVar file scopeId parent (TupleExpr elts _) =
  mapM_ (walkWithVar file scopeId parent) elts

walkWithVar file scopeId parent (ListExpr elts _) =
  mapM_ (walkWithVar file scopeId parent) elts

walkWithVar _ _ _ _ = pure ()

-- ── Except handler walker ──────────────────────────────────────────────

-- | Walk an except handler, emitting a VARIABLE for the bound exception name.
walkExceptHandler :: PythonExceptHandler -> Analyzer ()
walkExceptHandler handler = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  -- Emit VARIABLE for exception name (e.g., `except ValueError as e:`)
  case pehName handler of
    Just name -> do
      let sp = pehSpan handler
          (line, col) = spanLC sp
          hash   = contentHash [("scope", scopeId), ("name", name)]
          varId  = semanticId file "VARIABLE" name parent (Just hash)

      emitNode GraphNode
        { gnId        = varId
        , gnType      = "VARIABLE"
        , gnName      = name
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = posLine (spanEnd sp)
        , gnEndColumn = posCol  (spanEnd sp)
        , gnExported  = False
        , gnMetadata  = Map.singleton "kind" (MetaText "except_variable")
        }

      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = varId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }
    Nothing -> pure ()

  -- Walk handler body
  mapM_ walkControlFlow (pehBody handler)

-- ── Comprehension walker ───────────────────────────────────────────────

-- | Walk a comprehension generator, emitting VARIABLE nodes for targets.
-- Used by both ControlFlow and Calls modules for comprehension expressions.
walkComprehension :: PythonComprehension -> Analyzer ()
walkComprehension comp = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  -- Emit VARIABLE for comprehension target
  walkLoopTarget file scopeId parent (pcTarget comp)

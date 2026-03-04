{-# LANGUAGE OverloadedStrings #-}
-- | Phase 8 rule: expressions — REFERENCE, CALL, BRANCH, CLOSURE nodes.
--
-- Handles these Rust expression types:
--   * 'ExprCall'       -> CALL node (function call)
--   * 'ExprMethodCall' -> CALL node (method=True)
--   * 'ExprIf'         -> BRANCH node (kind=if)
--   * 'ExprMatch'      -> BRANCH node (kind=match)
--   * 'ExprLoop'       -> BRANCH node (kind=loop)
--   * 'ExprWhile'      -> BRANCH node (kind=while)
--   * 'ExprForLoop'    -> BRANCH node (kind=for)
--   * 'ExprClosure'    -> CLOSURE node
--   * 'ExprPath'       -> REFERENCE node (variable/function reference)
--   * 'ExprField'      -> REFERENCE node (field=True)
--   * 'ExprTry'        -> CALL node (name="?", try operator)
--
-- "Transparent" expressions (binary, unary, block, reference, struct, tuple,
-- array, await, cast, unsafe, async) just walk their children recursively
-- without emitting a new node.
--
-- Also emits CONTAINS edges from the enclosing scope to each emitted node,
-- and DERIVED_FROM edges for data flow.
--
-- Called from 'Rules.Declarations' for expression statements and let
-- binding initializers.
module Rules.Expressions
  ( walkExpr
  , walkBlockExprs
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import RustAST
import Analysis.Types
    ( GraphNode(..)
    , GraphEdge(..)
    , MetaValue(..)
    , Scope(..)
    , ScopeKind(..)
    )
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , askFile
    , askScopeId
    , askEnclosingFn
    , withScope
    , withUnsafe
    , withAsync
    )
import Grafema.SemanticId (semanticId, contentHash)
import {-# SOURCE #-} Rules.Patterns (walkMatchArms)

-- ── Name extraction ──────────────────────────────────────────────────

-- | Extract a human-readable name from an expression (for CALL targets etc.).
--
-- ExprPath "foo::bar" -> "foo::bar"
-- ExprField _ "field" -> "field"
-- Other               -> "<expr>"
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

-- ── Expression walker ────────────────────────────────────────────────

-- | Walk a single Rust expression, emitting graph nodes and edges.
--
-- Node-emitting expressions (CALL, BRANCH, CLOSURE, REFERENCE) create
-- a new graph node plus a CONTAINS edge from the current scope.
-- Transparent expressions just recurse into their children.
walkExpr :: RustExpr -> Analyzer ()

-- ── CALL node: function call ─────────────────────────────────────────

walkExpr (ExprCall func args sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      funcName    = exprToName func
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "CALL" funcName parent (Just hash)

  -- Emit CALL node
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "CALL"
    , gnName     = funcName
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("method", MetaBool False)
        ]
    }

  -- Emit CONTAINS edge from scope to CALL
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk subexpressions
  walkExpr func
  mapM_ walkExpr args

-- ── CALL node: method call ───────────────────────────────────────────

walkExpr (ExprMethodCall receiver method args sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "CALL" method parent (Just hash)

  -- Emit CALL node with method=True
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "CALL"
    , gnName     = method
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("method",   MetaBool True)
        , ("receiver", MetaText (exprToName receiver))
        ]
    }

  -- Emit CONTAINS edge from scope to CALL
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk subexpressions
  walkExpr receiver
  mapM_ walkExpr args

-- ── BRANCH node: if/else ─────────────────────────────────────────────

walkExpr (ExprIf cond thenBlock mElse sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "if" parent (Just hash)

  -- Emit BRANCH node
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "BRANCH"
    , gnName     = "if"
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "if")
        ]
    }

  -- Emit CONTAINS edge from scope to BRANCH
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk subexpressions
  walkExpr cond
  walkBlockExprs thenBlock
  mapM_ walkExpr mElse

-- ── BRANCH node: match ───────────────────────────────────────────────

walkExpr (ExprMatch expr arms sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "match" parent (Just hash)

  -- Emit BRANCH node
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "BRANCH"
    , gnName     = "match"
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "match")
        ]
    }

  -- Emit CONTAINS edge from scope to BRANCH
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk subexpressions
  walkExpr expr
  -- Phase 9: delegate arm walking to Patterns (emits MATCH_ARM + HANDLES_VARIANT)
  walkMatchArms arms

-- ── BRANCH node: loop ────────────────────────────────────────────────

walkExpr (ExprLoop body _label sp) = do
  walkBranch "loop" sp
  walkBlockExprs body

-- ── BRANCH node: while ───────────────────────────────────────────────

walkExpr (ExprWhile cond body _label sp) = do
  walkBranch "while" sp
  walkExpr cond
  walkBlockExprs body

-- ── BRANCH node: for ─────────────────────────────────────────────────

walkExpr (ExprForLoop _pat expr body _label sp) = do
  walkBranch "for" sp
  walkExpr expr
  walkBlockExprs body

-- ── CLOSURE node ─────────────────────────────────────────────────────

walkExpr (ExprClosure _inputs _output body capture sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "CLOSURE" "<closure>" parent (Just hash)

  -- Emit CLOSURE node
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "CLOSURE"
    , gnName     = "<closure>"
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("capture", MetaBool capture)
        ]
    }

  -- Emit CONTAINS edge from scope to CLOSURE
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk body in a ClosureScope
  let closureScope = Scope
        { scopeId           = nodeId
        , scopeKind         = ClosureScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope closureScope $
    walkExpr body

-- ── REFERENCE node: variable/function path ───────────────────────────

walkExpr (ExprPath path sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "REFERENCE" path parent (Just hash)

  -- Emit REFERENCE node
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "REFERENCE"
    , gnName     = path
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("field", MetaBool False)
        ]
    }

  -- Emit CONTAINS edge from scope to REFERENCE
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- ── REFERENCE node: field access ─────────────────────────────────────

walkExpr (ExprField base member sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "REFERENCE" member parent (Just hash)

  -- Emit REFERENCE node with field=True
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "REFERENCE"
    , gnName     = member
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("field", MetaBool True)
        , ("base",  MetaText (exprToName base))
        ]
    }

  -- Emit CONTAINS edge from scope to REFERENCE
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk base expression
  walkExpr base

-- ── CALL node: ? (try) operator ──────────────────────────────────────

walkExpr (ExprTry expr sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "CALL" "?" parent (Just hash)

  -- Emit CALL node for ? operator
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "CALL"
    , gnName     = "?"
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("method", MetaBool False)
        , ("try",    MetaBool True)
        ]
    }

  -- Emit CONTAINS edge from scope to CALL
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk inner expression
  walkExpr expr

-- ── Transparent expressions: walk children only ──────────────────────

walkExpr (ExprBinary left _op right _sp) =
  walkExpr left >> walkExpr right

walkExpr (ExprUnary _op expr _sp) =
  walkExpr expr

walkExpr (ExprBlock stmts _sp) =
  mapM_ walkStmtExpr stmts

walkExpr (ExprReference expr _mut _sp) =
  walkExpr expr

walkExpr (ExprStruct _path fields mRest _sp) =
  mapM_ (walkExpr . snd) fields >> mapM_ walkExpr mRest

walkExpr (ExprTuple elems _sp) =
  mapM_ walkExpr elems

walkExpr (ExprArray elems _sp) =
  mapM_ walkExpr elems

walkExpr (ExprAwait base _sp) =
  walkExpr base

walkExpr (ExprCast expr _ty _sp) =
  walkExpr expr

walkExpr (ExprUnsafe block _sp) =
  withUnsafe $ walkBlockExprs block

walkExpr (ExprAsync _capture block _sp) =
  withAsync $ walkBlockExprs block

walkExpr (ExprReturn mExpr _sp) =
  mapM_ walkExpr mExpr

walkExpr (ExprBreak mExpr _label _sp) =
  mapM_ walkExpr mExpr

walkExpr (ExprAssign left right _sp) =
  walkExpr left >> walkExpr right

walkExpr (ExprRange mStart mEnd _sp) =
  mapM_ walkExpr mStart >> mapM_ walkExpr mEnd

walkExpr (ExprIndex expr idx _sp) =
  walkExpr expr >> walkExpr idx

walkExpr (ExprLet _pat expr _sp) =
  walkExpr expr

-- ── Terminal expressions: no children ────────────────────────────────

walkExpr (ExprLit _ _) = pure ()

walkExpr (ExprContinue _ _) = pure ()

walkExpr (ExprUnknown _) = pure ()

-- ── Block expression walker ──────────────────────────────────────────

-- | Walk all statements in a block, dispatching expressions to 'walkExpr'.
-- This is separate from 'Rules.Declarations.walkBlock' to avoid circular
-- dependencies: Declarations imports Expressions, not the reverse.
walkBlockExprs :: RustBlock -> Analyzer ()
walkBlockExprs (RustBlock stmts) = mapM_ walkStmtExpr stmts

-- | Walk a single statement for its expression content.
-- Let bindings: walk the init expression (if present).
-- Expression/Semi statements: walk the expression.
-- Item statements: silently skip (handled by Declarations).
walkStmtExpr :: RustStmt -> Analyzer ()
walkStmtExpr (StmtExpr expr) = walkExpr expr
walkStmtExpr (StmtSemi expr) = walkExpr expr
walkStmtExpr (StmtLocal _ mInit _) = mapM_ walkExpr mInit
walkStmtExpr (StmtItem _) = pure ()
walkStmtExpr (StmtMacro _) = pure ()

-- ── Branch helper ────────────────────────────────────────────────────

-- | Emit a BRANCH node with the given kind at the given span.
-- Used for loop/while/for which all follow the same pattern.
walkBranch :: Text -> Span -> Analyzer ()
walkBranch kind sp = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" kind parent (Just hash)

  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "BRANCH"
    , gnName     = kind
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("kind", MetaText kind)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- ── Helpers ──────────────────────────────────────────────────────────

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

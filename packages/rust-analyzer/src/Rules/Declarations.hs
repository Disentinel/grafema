{-# LANGUAGE OverloadedStrings #-}
-- | Phase 3 rule: declarations — FUNCTION and VARIABLE nodes.
--
-- Handles these Rust AST constructs:
--   * 'ItemFn'     -> FUNCTION node
--   * 'ItemConst'  -> VARIABLE node (kind=const)
--   * 'ItemStatic' -> VARIABLE node (kind=static)
--   * 'StmtLocal'  -> VARIABLE node (kind=let) via block walking
--
-- Also emits CONTAINS edges from the enclosing scope (module or parent)
-- to each declared node.
--
-- Called from 'Analysis.Walker.walkFile' for each top-level item.
-- Block-level items (functions inside blocks, let bindings) are discovered
-- by recursively walking 'RustBlock' contents.
module Rules.Declarations
  ( walkDeclarations
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import RustAST
import Analysis.Types (GraphNode(..), GraphEdge(..), MetaValue(..), Scope(..), ScopeKind(..))
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , askFile
    , askScopeId
    , askExported
    , askEnclosingFn
    , askNamedParent
    , withScope
    , withEnclosingFn
    , withNamedParent
    , withExported
    , withUnsafe
    )
import Grafema.SemanticId (semanticId, contentHash)
import Rules.Expressions (walkExpr)
import Rules.Patterns (walkFnParams)
import Rules.Ownership (walkOwnership)
import Rules.ErrorFlow (walkErrorFlow, countErrorExits)
import Rules.Unsafe (walkUnsafe)
import Rules.Closures (walkClosureCaptures)

-- ── Visibility helpers ─────────────────────────────────────────────────

-- | Convert a 'Vis' to its text representation for metadata.
visToText :: Vis -> Text
visToText VisPub        = "pub"
visToText VisPubCrate   = "pub(crate)"
visToText VisPubSuper   = "pub(super)"
visToText (VisPubIn t)  = "pub(in " <> t <> ")"
visToText VisPrivate    = "private"

-- | Is this visibility public (exported)?
isPub :: Vis -> Bool
isPub VisPub      = True
isPub VisPubCrate = True
isPub _           = False

-- ── Top-level item walker ──────────────────────────────────────────────

-- | Walk a single top-level (or nested) Rust item, emitting declaration
-- nodes and CONTAINS edges.
--
-- Handles ItemFn, ItemConst, ItemStatic. Other item types are silently
-- ignored (handled by later phases).
walkDeclarations :: RustItem -> Analyzer ()

-- Function declaration
walkDeclarations (ItemFn ident vis sig block _attrs sp) = do
  file     <- askFile
  scopeId  <- askScopeId
  parent   <- askNamedParent
  exported <- askExported

  let fnExported = exported || isPub vis
      nodeId = semanticId file "FUNCTION" ident parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)
      errCount = countErrorExits block

  -- Emit FUNCTION node with metadata
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "FUNCTION"
    , gnName     = ident
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = fnExported
    , gnMetadata = Map.fromList
        [ ("async",            MetaBool (fsAsync sig))
        , ("unsafe",           MetaBool (fsUnsafe sig))
        , ("const",            MetaBool (fsConst sig))
        , ("visibility",       MetaText (visToText vis))
        , ("error_exit_count", MetaInt errCount)
        ]
    }

  -- Emit CONTAINS edge from parent scope to this function
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk the function body in a new scope
  let fnScope = Scope
        { scopeId           = nodeId
        , scopeKind         = FunctionScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  let bodyAction = if fnExported then withExported else id
      unsafeAction = if fsUnsafe sig then withUnsafe else id
  bodyAction $ unsafeAction $
    withScope fnScope $
    withEnclosingFn nodeId $
    withNamedParent ident $ do
      -- Phase 9: walk function parameters
      walkFnParams (fsInputs sig)
      walkBlock block

-- Const item
walkDeclarations (ItemConst ident vis _ty expr sp _attrs) = do
  file     <- askFile
  scopeId  <- askScopeId
  exported <- askExported

  let constExported = exported || isPub vis
      nodeId = semanticId file "VARIABLE" ident Nothing Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "VARIABLE"
    , gnName     = ident
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = constExported
    , gnMetadata = Map.fromList
        [ ("kind",       MetaText "const")
        , ("mutable",    MetaBool False)
        , ("visibility", MetaText (visToText vis))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk init expression (Phase 8 + Phase 10 + Phase 11 + Phase 12 + Phase 13)
  walkExpr expr
  walkOwnership expr
  walkErrorFlow expr
  walkUnsafe expr
  walkClosureCaptures expr

-- Static item
walkDeclarations (ItemStatic ident vis _ty mut expr sp _attrs) = do
  file     <- askFile
  scopeId  <- askScopeId
  exported <- askExported

  let staticExported = exported || isPub vis
      nodeId = semanticId file "VARIABLE" ident Nothing Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "VARIABLE"
    , gnName     = ident
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = staticExported
    , gnMetadata = Map.fromList
        [ ("kind",       MetaText "static")
        , ("mutable",    MetaBool mut)
        , ("visibility", MetaText (visToText vis))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk init expression (Phase 8 + Phase 10 + Phase 11 + Phase 12 + Phase 13)
  walkExpr expr
  walkOwnership expr
  walkErrorFlow expr
  walkUnsafe expr
  walkClosureCaptures expr

-- All other items: silently skip (handled by later phases)
walkDeclarations _ = pure ()

-- ── Block & statement walking ──────────────────────────────────────────

-- | Walk all statements in a block.
walkBlock :: RustBlock -> Analyzer ()
walkBlock (RustBlock stmts) = mapM_ walkStmt stmts

-- | Walk a single statement.
walkStmt :: RustStmt -> Analyzer ()
walkStmt (StmtLocal pat mInit sp) = walkLetBinding pat mInit sp
walkStmt (StmtItem item)          = walkDeclarations item
walkStmt (StmtExpr expr)          = walkExpr expr >> walkOwnership expr >> walkErrorFlow expr >> walkUnsafe expr >> walkClosureCaptures expr
walkStmt (StmtSemi expr)          = walkExpr expr >> walkOwnership expr >> walkErrorFlow expr >> walkUnsafe expr >> walkClosureCaptures expr
walkStmt (StmtMacro _)            = pure ()

-- ── Let binding ────────────────────────────────────────────────────────

-- | Walk a let binding, emitting a VARIABLE node with kind=let.
--
-- Only handles simple 'PatIdent' patterns. Complex destructuring patterns
-- (tuples, structs) are deferred to Phase 9 (Patterns).
--
-- Uses a content hash based on line:col for uniqueness, since multiple
-- let bindings with the same name can exist in different scopes.
walkLetBinding :: RustPat -> Maybe RustExpr -> Span -> Analyzer ()
walkLetBinding (PatIdent ident isMut _byRef _patSpan) mInit sp = do
  file     <- askFile
  scopeId  <- askScopeId
  encFn    <- askEnclosingFn

  let line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)
      -- Parent context for the semantic ID
      parent = encFn >>= extractName
      -- Content hash for uniqueness (multiple lets with same name)
      hash = contentHash [("line", T.pack (show line)), ("col", T.pack (show col))]
      nodeId = semanticId file "VARIABLE" ident parent (Just hash)

  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "VARIABLE"
    , gnName     = ident
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False  -- let bindings are never exported
    , gnMetadata = Map.fromList
        [ ("kind",    MetaText "let")
        , ("mutable", MetaBool isMut)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk init expression (Phase 8 + Phase 10 + Phase 11 + Phase 12 + Phase 13)
  mapM_ (\e -> walkExpr e >> walkOwnership e >> walkErrorFlow e >> walkUnsafe e >> walkClosureCaptures e) mInit

-- Complex patterns: silently skip (Phase 9), but still walk init expression
walkLetBinding _ mInit _ = mapM_ (\e -> walkExpr e >> walkOwnership e >> walkErrorFlow e >> walkUnsafe e >> walkClosureCaptures e) mInit

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

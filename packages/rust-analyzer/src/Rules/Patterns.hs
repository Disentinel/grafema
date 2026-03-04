{-# LANGUAGE OverloadedStrings #-}
-- | Phase 9 rule: patterns -- PARAMETER, PATTERN, MATCH_ARM nodes.
--
-- Handles these Rust pattern constructs:
--   * Function parameters (self, typed) -> PARAMETER nodes
--   * PatStruct, PatTupleStruct, PatPath -> PATTERN nodes with constructor
--   * Match arms -> MATCH_ARM nodes with HANDLES_VARIANT edges
--   * PatTuple, PatOr, PatSlice, PatReference -> transparent (walk children)
--   * PatWild, PatLit, PatRange, PatUnknown -> skip
--
-- Also emits CONTAINS edges from the enclosing scope to each emitted node.
--
-- Called from 'Rules.Declarations' for function parameters and from
-- 'Rules.Expressions' for match arms.
module Rules.Patterns
  ( walkPat
  , walkFnParams
  , walkMatchArms
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
    , askEnclosingFn
    , withScope
    )
import Grafema.SemanticId (semanticId, contentHash)
import Rules.Expressions (walkExpr)

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

-- ── Function parameter walking ──────────────────────────────────────

-- | Walk function parameters, emitting PARAMETER nodes with index metadata.
walkFnParams :: [RustFnArg] -> Analyzer ()
walkFnParams args = mapM_ (uncurry walkFnParam) (zip [0..] args)

-- | Walk a single function parameter.
walkFnParam :: Int -> RustFnArg -> Analyzer ()

-- self parameter
walkFnParam idx (FnArgSelf isMut) = do
  file    <- askFile
  encFn   <- askEnclosingFn
  scopeId <- askScopeId

  let parent = encFn >>= extractName
      hash   = contentHash [("index", T.pack (show idx))]
      nodeId = semanticId file "PARAMETER" "self" parent (Just hash)

  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "PARAMETER"
    , gnName     = "self"
    , gnFile     = file
    , gnLine     = 1
    , gnColumn   = 0  -- self doesn't have a span in our AST
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("mutable", MetaBool isMut)
        , ("by_ref",  MetaBool False)
        , ("index",   MetaInt idx)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- typed parameter
walkFnParam idx (FnArgTyped pat _ty) = case pat of
  PatIdent ident isMut isByRef sp -> do
    file    <- askFile
    encFn   <- askEnclosingFn
    scopeId <- askScopeId

    let parent = encFn >>= extractName
        (line, col) = spanLC sp
        hash   = contentHash [("index", T.pack (show idx)), ("line", T.pack (show line))]
        nodeId = semanticId file "PARAMETER" ident parent (Just hash)

    emitNode GraphNode
      { gnId       = nodeId
      , gnType     = "PARAMETER"
      , gnName     = ident
      , gnFile     = file
      , gnLine     = line
      , gnColumn   = col
      , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
      , gnMetadata = Map.fromList
          [ ("mutable", MetaBool isMut)
          , ("by_ref",  MetaBool isByRef)
          , ("index",   MetaInt idx)
          ]
      }

    emitEdge GraphEdge
      { geSource   = scopeId
      , geTarget   = nodeId
      , geType     = "CONTAINS"
      , geMetadata = Map.empty
      }

  -- Complex pattern in parameter position: walk it for PATTERN nodes
  _ -> walkPat pat

-- ── Pattern walking ─────────────────────────────────────────────────

-- | Walk a pattern, emitting PATTERN nodes for constructor patterns.
--
-- Constructor patterns (PatStruct, PatTupleStruct, PatPath) emit a
-- PATTERN node with constructor metadata.
-- Transparent patterns (PatTuple, PatOr, PatSlice, PatReference) just
-- recurse into their children.
-- Terminal patterns (PatWild, PatLit, PatRange, PatIdent, PatUnknown)
-- are silently skipped (PatIdent in non-parameter positions is handled
-- by Declarations as VARIABLE).
walkPat :: RustPat -> Analyzer ()

-- Struct pattern: Foo { x, y }
walkPat (PatStruct path _fields sp) = emitPattern path sp

-- Tuple struct pattern: Some(x)
walkPat (PatTupleStruct path _elems sp) = emitPattern path sp

-- Path pattern: None
walkPat (PatPath path sp) = emitPattern path sp

-- Transparent: walk children
walkPat (PatTuple elems _sp) = mapM_ walkPat elems
walkPat (PatOr cases _sp) = mapM_ walkPat cases
walkPat (PatSlice elems _sp) = mapM_ walkPat elems
walkPat (PatReference pat _mut _sp) = walkPat pat

-- Terminal patterns: skip
walkPat (PatIdent _ _ _ _) = pure ()
walkPat (PatWild _) = pure ()
walkPat (PatLit _ _) = pure ()
walkPat (PatRange _ _ _) = pure ()
walkPat (PatUnknown _) = pure ()

-- | Emit a PATTERN node with the given constructor name.
emitPattern :: Text -> Span -> Analyzer ()
emitPattern constructor sp = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent = encFn >>= extractName
      hash   = contentHash [("line", T.pack (show line)), ("col", T.pack (show col))]
      nodeId = semanticId file "PATTERN" constructor parent (Just hash)

  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "PATTERN"
    , gnName     = constructor
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("constructor", MetaText constructor)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- ── Match arm walking ───────────────────────────────────────────────

-- | Walk match arms, emitting MATCH_ARM nodes with HANDLES_VARIANT edges.
walkMatchArms :: [RustMatchArm] -> Analyzer ()
walkMatchArms arms = mapM_ (uncurry walkArm) (zip [0..] arms)

-- | Walk a single match arm.
walkArm :: Int -> RustMatchArm -> Analyzer ()
walkArm idx arm = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let sp = raSpan arm
      (line, col) = spanLC sp
      parent = encFn >>= extractName
      armName = "#" <> T.pack (show idx)
      hash   = contentHash [("index", T.pack (show idx)), ("line", T.pack (show line))]
      nodeId = semanticId file "MATCH_ARM" armName parent (Just hash)

  -- Emit MATCH_ARM node
  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "MATCH_ARM"
    , gnName     = armName
    , gnFile     = file
    , gnLine     = line
    , gnColumn   = col
    , gnEndLine   = 0
    , gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("index", MetaInt idx)
        ]
    }

  -- Emit CONTAINS edge from scope to MATCH_ARM
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit HANDLES_VARIANT edge if the pattern is a constructor pattern
  emitHandlesVariant nodeId (raPat arm)

  -- Walk the pattern for PATTERN nodes
  let armScope = Scope
        { scopeId           = nodeId
        , scopeKind         = MatchArmScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope armScope $ do
    walkPat (raPat arm)

    -- Walk guard expression (if present)
    mapM_ walkExpr (raGuard arm)

    -- Walk the body expression
    walkExpr (raBody arm)

-- | Emit HANDLES_VARIANT edge from a match arm if the pattern is a constructor.
-- Handles PatPath, PatTupleStruct, PatStruct directly, and recurses
-- into PatOr to emit multiple HANDLES_VARIANT edges.
emitHandlesVariant :: Text -> RustPat -> Analyzer ()
emitHandlesVariant matchArmId (PatPath name _) =
  emitEdge GraphEdge
    { geSource   = matchArmId
    , geTarget   = matchArmId
    , geType     = "HANDLES_VARIANT"
    , geMetadata = Map.fromList [("variant", MetaText name)]
    }
emitHandlesVariant matchArmId (PatTupleStruct name _ _) =
  emitEdge GraphEdge
    { geSource   = matchArmId
    , geTarget   = matchArmId
    , geType     = "HANDLES_VARIANT"
    , geMetadata = Map.fromList [("variant", MetaText name)]
    }
emitHandlesVariant matchArmId (PatStruct name _ _) =
  emitEdge GraphEdge
    { geSource   = matchArmId
    , geTarget   = matchArmId
    , geType     = "HANDLES_VARIANT"
    , geMetadata = Map.fromList [("variant", MetaText name)]
    }
emitHandlesVariant matchArmId (PatOr cases _) =
  mapM_ (emitHandlesVariant matchArmId) cases
emitHandlesVariant _ _ = pure ()

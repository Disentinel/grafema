{-# LANGUAGE OverloadedStrings #-}
-- | Phase 4 rule: pattern walking.
--
-- Walks GHC 'Pat GhcPs' constructors to emit pattern-level graph nodes.
-- Patterns appear in function arguments, case alternatives, let/where
-- bindings, and lambda arguments.
--
-- Node types emitted:
--   * PARAMETER  -- variable patterns (introduce a binding)
--   * PATTERN    -- constructor patterns (match on a data constructor)
--
-- Compound patterns (tuple, list, parenthesized, bang, lazy, etc.)
-- recurse into their sub-patterns without emitting extra nodes.
--
-- Called from 'Analysis.Walker' and 'Rules.Declarations' when walking
-- match groups and pattern bindings.
module Rules.Patterns
  ( walkPat
  ) where

import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import GHC.Hs (GhcPs)
import GHC.Hs.Pat (Pat(..), LPat, HsRecFields(..), HsFieldBind(..))
import GHC.Hs.Type (HsConDetails(..))
import GHC.Types.SrcLoc (GenLocated(..), unLoc)
import GHC.Types.Name.Reader (rdrNameOcc)
import GHC.Types.Name.Occurrence (occNameString)

import Analysis.Context
  ( Analyzer
  , emitNode
  , emitEdge
  , askFile
  , askScopeId
  )
import Analysis.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Grafema.SemanticId (semanticId)
import Loc (getLocN)

-- | Walk a located pattern, emitting PARAMETER and PATTERN nodes
-- as appropriate. Recurses into sub-patterns for compound forms.
walkPat :: LPat GhcPs -> Analyzer ()
walkPat (L _loc pat) = case pat of

  -- Variable pattern: x
  -- Emits a PARAMETER node -- this introduces a binding in scope.
  VarPat _ locName -> do
    file    <- askFile
    scopeId <- askScopeId
    let name = T.pack (occNameString (rdrNameOcc (unLoc locName)))
    let (line, col, endLine, endCol) = getLocN locName
    let nodeId = semanticId file "PARAMETER" name Nothing
                   (Just (T.pack (show line <> ":" <> show col)))
    emitNode GraphNode
      { gnId        = nodeId
      , gnType      = "PARAMETER"
      , gnName      = name
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

  -- Constructor pattern: Just x, (a, b), Foo { bar = baz }
  -- Emits a PATTERN node with "constructor" metadata, then recurses
  -- into sub-patterns.
  ConPat _ conName details -> do
    file    <- askFile
    scopeId <- askScopeId
    let name = T.pack (occNameString (rdrNameOcc (unLoc conName)))
    let (line, col, endLine, endCol) = getLocN conName
    let nodeId = semanticId file "PATTERN" name Nothing
                   (Just (T.pack (show line <> ":" <> show col)))
    emitNode GraphNode
      { gnId        = nodeId
      , gnType      = "PATTERN"
      , gnName      = name
      , gnFile      = file
      , gnLine      = line
      , gnColumn    = col
      , gnEndLine   = endLine
      , gnEndColumn = endCol
      , gnExported  = False
      , gnMetadata  = Map.singleton "constructor" (MetaText name)
      }
    emitEdge GraphEdge
      { geSource   = scopeId
      , geTarget   = nodeId
      , geType     = "CONTAINS"
      , geMetadata = Map.empty
      }
    -- Recurse into sub-patterns
    case details of
      PrefixCon _ args              -> mapM_ walkPat args
      RecCon (HsRecFields fields _) -> mapM_ (walkPat . hfbRHS . unLoc) fields
      InfixCon left right           -> walkPat left >> walkPat right

  -- Wildcard pattern: _
  -- No node needed -- wildcards don't introduce bindings.
  WildPat _ -> pure ()

  -- As-pattern: x@(Just y)
  -- Emits PARAMETER for the name, then recurses into the inner pattern.
  -- GHC 9.8: AsPat has a token between name and pattern.
  AsPat _ locName _tok inner -> do
    file    <- askFile
    scopeId <- askScopeId
    let name = T.pack (occNameString (rdrNameOcc (unLoc locName)))
    let (line, col, endLine, endCol) = getLocN locName
    let nodeId = semanticId file "PARAMETER" name Nothing
                   (Just (T.pack (show line <> ":" <> show col)))
    emitNode GraphNode
      { gnId        = nodeId
      , gnType      = "PARAMETER"
      , gnName      = name
      , gnFile      = file
      , gnLine      = line
      , gnColumn    = col
      , gnEndLine   = endLine
      , gnEndColumn = endCol
      , gnExported  = False
      , gnMetadata  = Map.singleton "as_pattern" (MetaBool True)
      }
    emitEdge GraphEdge
      { geSource   = scopeId
      , geTarget   = nodeId
      , geType     = "CONTAINS"
      , geMetadata = Map.empty
      }
    walkPat inner

  -- Literal pattern: 1, 'a'
  -- No binding introduced -- skip.
  LitPat _ _lit -> pure ()

  -- Numeric/overloaded literal pattern: 1, -1
  -- No binding introduced -- skip.
  NPat {} -> pure ()

  -- Parenthesized pattern: (pat)
  -- GHC 9.8: ParPat has open/close tokens.
  ParPat _ _open inner _close -> walkPat inner

  -- Tuple pattern: (a, b, c)
  TuplePat _ pats _ -> mapM_ walkPat pats

  -- List pattern: [a, b, c]
  ListPat _ pats -> mapM_ walkPat pats

  -- Bang pattern: !x
  BangPat _ inner -> walkPat inner

  -- Lazy pattern: ~x
  LazyPat _ inner -> walkPat inner

  -- Type signature pattern: x :: Int
  SigPat _ inner _ty -> walkPat inner

  -- View pattern: f -> x
  -- Skip the expression part (would need walkExpr, avoids circular dep).
  -- Walk the result pattern.
  ViewPat _ _expr inner -> walkPat inner

  -- Template Haskell splice pattern -- skip.
  SplicePat _ _splice -> pure ()

  -- Catch-all for any GHC extensions or patterns we don't handle yet.
  _ -> pure ()

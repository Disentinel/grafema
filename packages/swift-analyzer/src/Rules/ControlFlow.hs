{-# LANGUAGE OverloadedStrings #-}
-- | Control flow rule for Swift: BRANCH, LOOP, and SCOPE nodes.
--
-- Emits graph nodes for control flow statements:
--   IfStmt, GuardStmt         -> BRANCH
--   ForInStmt, WhileStmt,
--   RepeatWhileStmt           -> LOOP
--   SwitchStmt                -> BRANCH
--   DoStmt (with catches)     -> SCOPE
--   DeferStmt                 -> SCOPE
module Rules.ControlFlow (walkControlFlowStmt) where

import qualified Data.Map.Strict as Map
import qualified Data.Text as T

import SwiftAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)

-- | Position hash for disambiguating nodes at different locations.
posHash :: Int -> Int -> T.Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- | Check if a condition is an optional binding (if let / guard let).
isOptBinding :: SwiftCondition -> Bool
isOptBinding (OptionalBindingCondition _ _ _ _) = True
isOptBinding _ = False

-- | Walk a statement for control flow analysis, emitting BRANCH, LOOP, and
-- SCOPE nodes as appropriate.
walkControlFlowStmt :: SwiftStmt -> Analyzer ()

-- IfStmt -> BRANCH with kind="if"
walkControlFlowStmt (IfStmt conds _body _mElse sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = posHash line col
      nodeId = semanticId file "BRANCH" "if" parent (Just hash)
      hasOptBinding = any isOptBinding conds
  emitNode GraphNode
    { gnId = nodeId, gnType = "BRANCH", gnName = "if", gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList $
        [ ("kind", MetaText "if")
        , ("language", MetaText "swift")
        ] ++ [("optionalBinding", MetaBool True) | hasOptBinding]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

-- GuardStmt -> BRANCH with kind="guard", earlyExit=true
walkControlFlowStmt (GuardStmt _conds _body sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = posHash line col
      nodeId = semanticId file "BRANCH" "guard" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "BRANCH", gnName = "guard", gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "guard")
        , ("earlyExit", MetaBool True)
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

-- ForInStmt -> LOOP with kind="for-in"
walkControlFlowStmt (ForInStmt _pat _seq _body _mWhere sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = posHash line col
      nodeId = semanticId file "LOOP" "for-in" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "LOOP", gnName = "for-in", gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "for-in")
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

-- WhileStmt -> LOOP with kind="while"
walkControlFlowStmt (WhileStmt _conds _body sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = posHash line col
      nodeId = semanticId file "LOOP" "while" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "LOOP", gnName = "while", gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "while")
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

-- RepeatWhileStmt -> LOOP with kind="repeat-while"
walkControlFlowStmt (RepeatWhileStmt _body _cond sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = posHash line col
      nodeId = semanticId file "LOOP" "repeat-while" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "LOOP", gnName = "repeat-while", gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "repeat-while")
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

-- SwitchStmt -> BRANCH with kind="switch", caseCount metadata
walkControlFlowStmt (SwitchStmt _subj cases sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = posHash line col
      nodeId = semanticId file "BRANCH" "switch" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "BRANCH", gnName = "switch", gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "switch")
        , ("caseCount", MetaInt (length cases))
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

-- DeferStmt -> SCOPE with kind="defer"
-- Note: DoStmt with catches is handled by Rules.ErrorFlow (kind="try-catch")
walkControlFlowStmt (DeferStmt _body sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let line = posLine (spanStart sp)
      col  = posCol (spanStart sp)
      hash = posHash line col
      nodeId = semanticId file "SCOPE" "defer" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "SCOPE", gnName = "defer", gnFile = file
    , gnLine = line, gnColumn = col
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("kind", MetaText "defer")
        , ("language", MetaText "swift")
        ]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

-- All other statements (ReturnStmt, ThrowStmt, BreakStmt, etc.) -- no graph nodes
walkControlFlowStmt _ = return ()

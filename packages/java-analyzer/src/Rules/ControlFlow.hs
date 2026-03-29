{-# LANGUAGE OverloadedStrings #-}
-- | Control flow rule: BRANCH nodes and SCOPE nodes.
--
-- Handles these Java statement types:
--   * 'IfStmt'           -> BRANCH node (kind=if)
--   * 'SwitchStmt'       -> BRANCH node (kind=switch)
--   * 'WhileStmt'        -> BRANCH node (kind=while)
--   * 'DoStmt'           -> BRANCH node (kind=do-while)
--   * 'ForStmt'          -> BRANCH node (kind=for)
--   * 'ForEachStmt'      -> BRANCH node (kind=for-each) + ITERATES_OVER edge
--   * 'TryStmt'          -> SCOPE node (kind=try) + CATCHES edges
--   * 'SynchronizedStmt' -> SCOPE node (kind=synchronized)
--
-- Node types: BRANCH, SCOPE
-- Edge types: CONTAINS, ITERATES_OVER, CATCHES
--
-- Called from 'Rules.Declarations' for statement walking.
module Rules.ControlFlow
  ( walkControlFlow
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import JavaAST
import Analysis.Types (GraphNode(..), GraphEdge(..), MetaValue(..))
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , askFile
    , askScopeId
    , askEnclosingFn
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

-- | Walk a statement for control flow analysis. Emits BRANCH and SCOPE
-- nodes as appropriate.
walkControlFlow :: JavaStmt -> Analyzer ()

-- ── BRANCH: if/else ────────────────────────────────────────────────────

walkControlFlow (IfStmt _cond _thenStmt mElse sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "if" parent (Just hash)
      branchCount = case mElse of
        Nothing -> 1
        Just _  -> 2

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
        [ ("kind",        MetaText "if")
        , ("branchCount", MetaInt branchCount)
        , ("hasElse",     MetaBool (branchCount > 1))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- ── BRANCH: switch ─────────────────────────────────────────────────────

walkControlFlow (SwitchStmt _sel entries sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "switch" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = "switch"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",       MetaText "switch")
        , ("caseCount",  MetaInt (length entries))
        , ("hasDefault", MetaBool (any jseIsDefault entries))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- ── BRANCH: while ──────────────────────────────────────────────────────

walkControlFlow (WhileStmt _cond _body sp) =
  emitBranch "while" sp

-- ── BRANCH: do-while ───────────────────────────────────────────────────

walkControlFlow (DoStmt _cond _body sp) =
  emitBranch "do-while" sp

-- ── BRANCH: for ────────────────────────────────────────────────────────

walkControlFlow (ForStmt _init _cond _update _body sp) =
  emitBranch "for" sp

-- ── BRANCH: for-each ───────────────────────────────────────────────────

walkControlFlow (ForEachStmt _var _iter _body sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "for-each" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = "for-each"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind", MetaText "for-each")
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- ── SCOPE: try-catch ───────────────────────────────────────────────────

walkControlFlow (TryStmt resources _tryBlock catches mFinally sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "SCOPE" "try" parent (Just hash)

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
        [ ("kind",         MetaText "try")
        , ("catchCount",   MetaInt (length catches))
        , ("hasFinally",   MetaBool (case mFinally of { Just _ -> True; Nothing -> False }))
        , ("hasResources", MetaBool (not (null resources)))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit CATCHES edges for each catch clause
  mapM_ (emitCatchEdge file nodeId) catches

-- ── SCOPE: synchronized ────────────────────────────────────────────────

walkControlFlow (SynchronizedStmt _expr _body sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "SCOPE" "synchronized" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "SCOPE"
    , gnName      = "synchronized"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind", MetaText "synchronized")
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- Other statements: no control flow nodes
walkControlFlow _ = pure ()

-- ── Branch helper ──────────────────────────────────────────────────────

-- | Emit a generic BRANCH node.
emitBranch :: Text -> Span -> Analyzer ()
emitBranch kind sp = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" kind parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = kind
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind", MetaText kind)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- ── Catch edge emission ────────────────────────────────────────────────

-- | Emit a CATCHES edge from a try scope to a catch clause's exception type.
emitCatchEdge :: Text -> Text -> JavaCatchClause -> Analyzer ()
emitCatchEdge file tryNodeId clause = do
  let paramType = jpType (jccParam clause)
      typeName  = typeToName paramType
      line      = posLine (spanStart (jccSpan clause))
      col       = posCol  (spanStart (jccSpan clause))
      hash      = contentHash [("line", T.pack (show line)), ("col", T.pack (show col))]
      catchId   = semanticId file "SCOPE" ("catch:" <> typeName) Nothing (Just hash)

  emitEdge GraphEdge
    { geSource   = tryNodeId
    , geTarget   = catchId
    , geType     = "CATCHES"
    , geMetadata = Map.fromList
        [ ("exceptionType", MetaText typeName)
        ]
    }

-- ── Helpers ────────────────────────────────────────────────────────────

-- | Extract the trailing name from a semantic ID.
extractName :: Text -> Maybe Text
extractName sid =
  case T.splitOn "->" sid of
    [] -> Nothing
    parts ->
      let lastPart = last parts
          name = T.takeWhile (/= '[') lastPart
      in if T.null name then Nothing else Just name

-- | Extract a type name from a JavaType.
typeToName :: JavaType -> Text
typeToName (ClassType n _ _ _)     = n
typeToName (PrimitiveType n _)     = n
typeToName (ArrayType comp _)      = typeToName comp <> "[]"
typeToName (VoidType _)            = "void"
typeToName (UnionType types _)     = T.intercalate " | " (map typeToName types)
typeToName (IntersectionType ts _) = T.intercalate " & " (map typeToName ts)
typeToName (WildcardType _ _ _)    = "?"
typeToName (VarType _)             = "var"
typeToName (TypeUnknown _)         = "<unknown>"

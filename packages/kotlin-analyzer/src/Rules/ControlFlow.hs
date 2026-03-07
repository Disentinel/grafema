{-# LANGUAGE OverloadedStrings #-}
-- | Control flow rule for Kotlin: BRANCH and SCOPE nodes.
--
-- Handles:
--   * IfStmt      -> BRANCH node (kind=if)
--   * WhenStmt    -> BRANCH node (kind=when)
--   * WhileStmt   -> BRANCH node (kind=while)
--   * DoWhileStmt -> BRANCH node (kind=do-while)
--   * ForStmt     -> BRANCH node (kind=for)
--   * TryStmt     -> SCOPE node (kind=try) + CATCHES edges
module Rules.ControlFlow
  ( walkControlFlow
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import KotlinAST
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
import Rules.Types (typeToName)

-- Span helpers

spanLC :: Span -> (Int, Int)
spanLC sp = (posLine (spanStart sp), posCol (spanStart sp))

posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- Control flow walker

walkControlFlow :: KotlinStmt -> Analyzer ()

-- BRANCH: if
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

-- BRANCH: when
walkControlFlow (WhenStmt _subject entries sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "when" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = "when"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",      MetaText "when")
        , ("caseCount", MetaInt (length entries))
        , ("hasElse",   MetaBool (any kweIsElse entries))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- BRANCH: while
walkControlFlow (WhileStmt _cond _body sp) =
  emitBranch "while" sp

-- BRANCH: do-while
walkControlFlow (DoWhileStmt _cond _body sp) =
  emitBranch "do-while" sp

-- BRANCH: for
walkControlFlow (ForStmt _var _iter _body sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "for" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = "for"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind", MetaText "for")
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- SCOPE: try-catch
walkControlFlow (TryStmt _tryBlock catches mFinally sp) = do
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
        [ ("kind",       MetaText "try")
        , ("catchCount", MetaInt (length catches))
        , ("hasFinally", MetaBool (case mFinally of { Just _ -> True; Nothing -> False }))
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

-- Other statements: no control flow nodes
walkControlFlow _ = pure ()

-- Branch helper

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

-- Catch edge emission

emitCatchEdge :: Text -> Text -> KotlinCatchClause -> Analyzer ()
emitCatchEdge file tryNodeId clause = do
  let typeName  = typeToName (kccParamType clause)
      line      = posLine (spanStart (kccSpan clause))
      col       = posCol  (spanStart (kccSpan clause))
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

-- Helpers

extractName :: Text -> Maybe Text
extractName sid =
  case T.splitOn "->" sid of
    [] -> Nothing
    parts ->
      let lastPart = last parts
          name = T.takeWhile (/= '[') lastPart
      in if T.null name then Nothing else Just name

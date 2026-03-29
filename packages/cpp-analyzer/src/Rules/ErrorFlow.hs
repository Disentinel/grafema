{-# LANGUAGE OverloadedStrings #-}
-- | Error flow: try/catch/throw for C++ exception handling.
--
-- Handles:
--   * 'TryStmt'   -> TRY_BLOCK node, push TryScope
--   * 'CatchStmt' -> CATCH_BLOCK node with caughtType metadata
--   * 'ThrowExpr'  -> THROWS edge from containing function
module Rules.ErrorFlow
  ( walkErrorFlow
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import CppAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)
import {-# SOURCE #-} Rules.Statements (walkStmt)
import {-# SOURCE #-} Rules.Expressions (walkExpr)

-- ── Helpers ────────────────────────────────────────────────────────────

posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

extractName :: Text -> Maybe Text
extractName sid =
  case T.splitOn "->" sid of
    [] -> Nothing
    parts ->
      let lastPart = last parts
          name = T.takeWhile (/= '[') lastPart
      in if T.null name then Nothing else Just name

-- ── Error flow walker ─────────────────────────────────────────────────

walkErrorFlow :: CppNode -> Analyzer ()

-- Try statement
walkErrorFlow node | nodeKind node == "TryStmt" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "TRY_BLOCK" "try" parent (Just hash)
      body    = lookupNodeField "body" node
      catches = lookupNodesField "catches" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "TRY_BLOCK"
    , gnName      = "try"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("catchCount", MetaInt (length catches))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk try body in TryScope
  case body of
    Just bodyNode -> do
      let tryScope = Scope
            { scopeId           = nodeId
            , scopeKind         = TryScope
            , scopeDeclarations = mempty
            , scopeParent       = Nothing
            }
      withScope tryScope $
        walkStmt bodyNode
    Nothing -> pure ()

  -- Walk catch handlers
  mapM_ (walkCatchHandler file nodeId) catches

-- Catch statement
walkErrorFlow node | nodeKind node == "CatchStmt" = do
  file    <- askFile
  scopeId <- askScopeId

  walkCatchHandler file scopeId node

-- Throw expression
walkErrorFlow node | nodeKind node == "ThrowExpr" = do
  file  <- askFile
  encFn <- askEnclosingFn

  let thrownType = lookupTextField "thrownType" node
      operand    = lookupNodeField "operand" node
      line       = nodeLine node

  case encFn of
    Just fnId ->
      emitEdge GraphEdge
        { geSource   = fnId
        , geTarget   = maybe "exception" id thrownType
        , geType     = "THROWS"
        , geMetadata = Map.fromList
            [ ("line", MetaInt line)
            ]
        }
    Nothing -> pure ()

  mapM_ walkExpr operand

-- Fallback
walkErrorFlow _ = pure ()

-- ── Catch handler walker ──────────────────────────────────────────────

walkCatchHandler :: Text -> Text -> CppNode -> Analyzer ()
walkCatchHandler file tryNodeId node = do
  encFn <- askEnclosingFn

  let line       = nodeLine node
      col        = nodeColumn node
      endLine    = maybe line id (nodeEndLine node)
      endCol     = maybe col id (nodeEndColumn node)
      parent     = encFn >>= extractName
      hash       = posHash line col
      nodeId     = semanticId file "CATCH_BLOCK" "catch" parent (Just hash)
      caughtType = lookupTextField "caughtType" node
      isCatchAll = lookupBoolField "isCatchAll" node
      body       = lookupNodeField "body" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CATCH_BLOCK"
    , gnName      = "catch"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [] ++
        [ ("caughtType", MetaText ct) | Just ct <- [caughtType] ] ++
        [ ("isCatchAll", MetaBool True) | isCatchAll ]
    }

  -- HAS_CATCH edge from try block
  emitEdge GraphEdge
    { geSource   = tryNodeId
    , geTarget   = nodeId
    , geType     = "HAS_CATCH"
    , geMetadata = Map.empty
    }

  -- Walk catch body
  case body of
    Just bodyNode -> do
      let catchScope = Scope
            { scopeId           = nodeId
            , scopeKind         = BlockScope
            , scopeDeclarations = mempty
            , scopeParent       = Nothing
            }
      withScope catchScope $
        walkStmt bodyNode
    Nothing -> pure ()

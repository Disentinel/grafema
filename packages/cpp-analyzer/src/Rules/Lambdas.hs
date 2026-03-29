{-# LANGUAGE OverloadedStrings #-}
-- | Lambda expressions for C++11+.
--
-- Handles:
--   * 'LambdaExpr' -> LAMBDA node
--     - Parses capture list (by-value, by-reference)
--     - Emits CAPTURES metadata
--     - Pushes LambdaScope and walks body
module Rules.Lambdas
  ( walkLambda
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import CppAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)
import {-# SOURCE #-} Rules.Statements (walkStmt)
import {-# SOURCE #-} Rules.Declarations (walkParam)

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

-- ── Lambda walker ─────────────────────────────────────────────────────

walkLambda :: CppNode -> Analyzer ()
walkLambda node | nodeKind node == "LambdaExpr" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "LAMBDA" "<lambda>" parent (Just hash)

      -- Extract captures
      captures    = lookupNodesField "captures" node
      captureNames = [ maybe "<capture>" id (nodeName c) | c <- captures ]
      captureKinds = [ if lookupBoolField "byRef" c then "by_reference" else "by_value"
                     | c <- captures
                     ]
      captureDefault = lookupTextField "captureDefault" node
      isMutable = lookupBoolField "isMutable" node

      -- Extract parameters
      params = lookupNodesField "params" node
      body   = lookupNodeField "body" node

      -- Extract trailing return type
      returnType = lookupTextField "returnType" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "LAMBDA"
    , gnName      = "<lambda>"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("paramCount",   MetaInt (length params))
        , ("captureCount", MetaInt (length captures))
        ] ++
        [ ("captureNames",   MetaList (map MetaText captureNames))
        | not (null captureNames)
        ] ++
        [ ("captureKinds",   MetaList (map MetaText captureKinds))
        | not (null captureKinds)
        ] ++
        [ ("captureDefault", MetaText cd) | Just cd <- [captureDefault] ] ++
        [ ("isMutable",      MetaBool True) | isMutable ] ++
        [ ("returnType",     MetaText rt)   | Just rt <- [returnType] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk lambda parameters
  mapM_ (walkParam file nodeId) params

  -- Walk body in lambda scope
  case body of
    Just bodyNode -> do
      let lambdaScope = Scope
            { scopeId           = nodeId
            , scopeKind         = LambdaScope
            , scopeDeclarations = mempty
            , scopeParent       = Nothing
            }
      withScope lambdaScope $
        withEnclosingFn nodeId $
          walkStmt bodyNode
    Nothing -> pure ()

-- Fallback
walkLambda _ = pure ()

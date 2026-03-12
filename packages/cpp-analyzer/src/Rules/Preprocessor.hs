{-# LANGUAGE OverloadedStrings #-}
-- | Preprocessor directives: macro definitions and expansions.
--
-- Handles:
--   * 'MacroDefinition' -> MACRO node
--   * 'MacroExpansion'  -> CALL node (kind=macro_expansion)
module Rules.Preprocessor
  ( walkPreprocessor
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import CppAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)

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

-- ── Preprocessor walker ───────────────────────────────────────────────

walkPreprocessor :: CppNode -> Analyzer ()

-- Macro definition
walkPreprocessor node | nodeKind node == "MacroDefinition" = do
  file    <- askFile
  scopeId <- askScopeId

  let name    = maybe "<macro>" id (nodeName node)
      line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      nodeId  = semanticId file "MACRO" name Nothing Nothing

      isFunctionLike = lookupBoolField "isFunctionLike" node
      body           = lookupTextField "body" node
      paramCount     = lookupIntField "paramCount" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "MACRO"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = True  -- macros are always "exported" (visible after #include)
    , gnMetadata  = Map.fromList $
        [] ++
        [ ("isFunctionLike", MetaBool True) | isFunctionLike ] ++
        [ ("body",           MetaText b)    | Just b  <- [body] ] ++
        [ ("paramCount",     MetaInt pc)    | Just pc <- [paramCount] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- Macro expansion (usage)
walkPreprocessor node | nodeKind node == "MacroExpansion" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let name    = maybe "<macro>" id (nodeName node)
      line    = nodeLine node
      col     = nodeColumn node
      endLine = maybe line id (nodeEndLine node)
      endCol  = maybe col id (nodeEndColumn node)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "CALL" name parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CALL"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind", MetaText "macro_expansion")
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred resolution to macro definition
  emitDeferred DeferredRef
    { drKind       = CallResolve
    , drName       = name
    , drFromNodeId = nodeId
    , drEdgeType   = "CALLS"
    , drScopeId    = Just scopeId
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.singleton "isMacro" (MetaBool True)
    }

-- Fallback
walkPreprocessor _ = pure ()

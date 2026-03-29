{-# LANGUAGE OverloadedStrings #-}
-- | Expression walker: CALL, REFERENCE, LITERAL, PROPERTY_ACCESS nodes
-- and recursive expression traversal.
--
-- Handles these C/C++ expression types:
--   * 'CallExpr'             -> CALL node, deferred CallResolve
--   * 'MemberRefExpr'        -> PROPERTY_ACCESS node
--   * 'DeclRefExpr'          -> REFERENCE node
--   * 'BinaryOperator'       -> walk operands, ASSIGNED_FROM for assignments
--   * 'UnaryOperator'        -> walk operand
--   * 'ConditionalOperator'  -> walk condition, then, else
--   * cast kinds             -> EXPRESSION node
--   * 'NewExpr'              -> CALL node (kind=new)
--   * 'DeleteExpr'           -> CALL node (kind=delete)
--   * 'ThisExpr'             -> no-op
--   * 'ArraySubscriptExpr'   -> walk array, index
--   * 'ParenExpr'            -> walk inner
--   * 'InitListExpr'         -> walk elements
--   * literals               -> LITERAL node
module Rules.Expressions
  ( walkExpr
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import CppAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId, contentHash)
import Rules.Lambdas (walkLambda)
import Rules.ErrorFlow (walkErrorFlow)

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

-- | Check if an operator is an assignment variant.
isAssignment :: Text -> Bool
isAssignment "="   = True
isAssignment "+="  = True
isAssignment "-="  = True
isAssignment "*="  = True
isAssignment "/="  = True
isAssignment "%="  = True
isAssignment "&="  = True
isAssignment "|="  = True
isAssignment "^="  = True
isAssignment "<<=" = True
isAssignment ">>=" = True
isAssignment _     = False

-- | Infer a graph node type from the LHS of an assignment.
inferLhsType :: CppNode -> Text
inferLhsType n = case nodeKind n of
  "DeclRefExpr"   -> "REFERENCE"
  "MemberRefExpr" -> "PROPERTY_ACCESS"
  _               -> "EXPRESSION"

-- ── Expression walker ──────────────────────────────────────────────────

walkExpr :: CppNode -> Analyzer ()

-- Function/method call
walkExpr node | nodeKind node == "CallExpr" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      parent   = encFn >>= extractName
      hash     = posHash line col
      callName = maybe "<call>" id (nodeName node)
      nodeId   = semanticId file "CALL" callName parent (Just hash)

      -- Extract receiver for method calls
      receiver = lookupTextField "receiver" node
      args     = lookupNodesField "args" node
      callee   = lookupNodeField "callee" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CALL"
    , gnName      = callName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("argCount", MetaInt (length args))
        ] ++
        [ ("receiver", MetaText r) | Just r <- [receiver] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred CALLS edge for resolution
  emitDeferred DeferredRef
    { drKind       = CallResolve
    , drName       = callName
    , drFromNodeId = nodeId
    , drEdgeType   = "CALLS"
    , drScopeId    = Just scopeId
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = receiver
    , drMetadata   = Map.empty
    }

  -- Walk callee expression
  mapM_ walkExpr callee

  -- Walk arguments and emit PASSES_ARGUMENT edges
  mapM_ (\(idx, arg) -> do
    let argHash = posHash (nodeLine arg) (nodeColumn arg)
        argId = semanticId file "EXPRESSION" ("<arg" <> T.pack (show idx) <> ">") parent (Just argHash)
    emitEdge GraphEdge
      { geSource   = nodeId
      , geTarget   = argId
      , geType     = "PASSES_ARGUMENT"
      , geMetadata = Map.fromList [("index", MetaInt idx)]
      }
    walkExpr arg
    ) (zip [0..] args)

-- Member reference expression (obj.member or obj->member)
walkExpr node | nodeKind node == "MemberRefExpr" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      parent   = encFn >>= extractName
      hash     = posHash line col
      member   = maybe "<member>" id (nodeName node)
      nodeId   = semanticId file "PROPERTY_ACCESS" member parent (Just hash)
      isArrow  = lookupBoolField "isArrow" node
      base     = lookupNodeField "base" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "PROPERTY_ACCESS"
    , gnName      = member
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("member", MetaText member)
        ] ++
        [ ("isArrow", MetaBool True) | isArrow ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk base expression
  mapM_ walkExpr base

-- Declaration reference (identifier used as expression)
walkExpr node | nodeKind node == "DeclRefExpr" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      parent   = encFn >>= extractName
      hash     = posHash line col
      refName  = maybe "<ref>" id (nodeName node)
      nodeId   = semanticId file "REFERENCE" refName parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "REFERENCE"
    , gnName      = refName
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

  -- READS_FROM edge
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "READS_FROM"
    , geMetadata = Map.empty
    }

-- Binary operator
walkExpr node | nodeKind node == "BinaryOperator" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let op  = lookupTextField "operator" node
      lhs = lookupNodeField "lhs" node
      rhs = lookupNodeField "rhs" node
      line = nodeLine node
      col  = nodeColumn node
      parent = encFn >>= extractName
      hash = posHash line col

  -- Walk both sides
  mapM_ walkExpr lhs
  mapM_ walkExpr rhs

  -- For assignment operators, emit ASSIGNED_FROM edge (lhs assigned from rhs)
  -- and WRITES_TO edge (assignment expression -> lhs)
  case op of
    Just opText | isAssignment opText -> do
      let lhsId = case lhs of
            Just lNode -> semanticId file (inferLhsType lNode) (maybe "<lhs>" id (nodeName lNode)) parent (Just hash)
            Nothing    -> scopeId <> "::lhs"
          assignId = semanticId file "EXPRESSION" ("<assign>" <> opText) parent (Just hash)
      emitEdge GraphEdge
        { geSource   = lhsId
        , geTarget   = scopeId <> "::rhs[" <> posHash line col <> "]"
        , geType     = "ASSIGNED_FROM"
        , geMetadata = Map.fromList
            [ ("operator", MetaText opText)
            ]
        }
      emitEdge GraphEdge
        { geSource   = assignId
        , geTarget   = lhsId
        , geType     = "WRITES_TO"
        , geMetadata = Map.fromList
            [ ("operator", MetaText opText)
            ]
        }
    _ -> pure ()

-- Unary operator
walkExpr node | nodeKind node == "UnaryOperator" = do
  let operand = lookupNodeField "operand" node
  mapM_ walkExpr operand

-- Conditional operator (ternary)
walkExpr node | nodeKind node == "ConditionalOperator" = do
  let cond     = lookupNodeField "condition" node
      thenExpr = lookupNodeField "then" node
      elseExpr = lookupNodeField "else" node
  mapM_ walkExpr cond
  mapM_ walkExpr thenExpr
  mapM_ walkExpr elseExpr

-- Cast expressions
walkExpr node | nodeKind node `elem` castKinds = do
  file    <- askFile
  encFn   <- askEnclosingFn
  scopeId <- askScopeId

  let line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      parent   = encFn >>= extractName
      hash     = posHash line col
      castKind = nodeKind node
      nodeId   = semanticId file "EXPRESSION" castKind parent (Just hash)
      targetType = lookupTextField "targetType" node
      inner    = lookupNodeField "expr" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "EXPRESSION"
    , gnName      = castKind
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("kind",     MetaText "cast")
        , ("castKind", MetaText castKind)
        ] ++
        [ ("targetType", MetaText tt) | Just tt <- [targetType] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  mapM_ walkExpr inner

-- new expression
walkExpr node | nodeKind node == "NewExpr" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      parent   = encFn >>= extractName
      hash     = posHash line col
      typeName = maybe "new" id (lookupTextField "allocType" node)
      callName = "new " <> typeName
      nodeId   = semanticId file "CALL" callName parent (Just hash)
      isArray  = lookupBoolField "isArray" node
      args     = lookupNodesField "args" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CALL"
    , gnName      = callName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("kind",      MetaText "new")
        , ("allocKind", MetaText (if isArray then "new[]" else "new"))
        , ("allocType", MetaText typeName)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred call resolution to constructor
  emitDeferred DeferredRef
    { drKind       = CallResolve
    , drName       = typeName
    , drFromNodeId = nodeId
    , drEdgeType   = "CALLS"
    , drScopeId    = Just scopeId
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.singleton "allocKind" (MetaText "new")
    }

  mapM_ walkExpr args

-- delete expression
walkExpr node | nodeKind node == "DeleteExpr" = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      parent   = encFn >>= extractName
      hash     = posHash line col
      isArray  = lookupBoolField "isArray" node
      nodeId   = semanticId file "CALL" "delete" parent (Just hash)
      operand  = lookupNodeField "operand" node

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CALL"
    , gnName      = "delete"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",      MetaText "delete")
        , ("allocKind", MetaText (if isArray then "delete[]" else "delete"))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  mapM_ walkExpr operand

-- Literals
walkExpr node | nodeKind node `elem` literalKinds = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let line     = nodeLine node
      col      = nodeColumn node
      endLine  = maybe line id (nodeEndLine node)
      endCol   = maybe col id (nodeEndColumn node)
      parent   = encFn >>= extractName
      hash     = posHash line col
      litKind  = nodeKind node
      litValue = lookupTextField "value" node
      nodeId   = semanticId file "LITERAL" litKind parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "LITERAL"
    , gnName      = maybe litKind id litValue
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = endLine
    , gnEndColumn = endCol
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("literalKind", MetaText litKind)
        ] ++
        [ ("value", MetaText v) | Just v <- [litValue] ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- Array subscript
walkExpr node | nodeKind node == "ArraySubscriptExpr" = do
  let arr = lookupNodeField "array" node
      idx = lookupNodeField "index" node
  mapM_ walkExpr arr
  mapM_ walkExpr idx

-- Paren expression
walkExpr node | nodeKind node == "ParenExpr" = do
  let inner = lookupNodeField "inner" node
  mapM_ walkExpr inner

-- Init list expression
walkExpr node | nodeKind node == "InitListExpr" = do
  let elts = lookupNodesField "elements" node
  mapM_ walkExpr elts

-- This expression
walkExpr node | nodeKind node == "ThisExpr" = pure ()

-- Sizeof/alignof expressions
walkExpr node | nodeKind node == "SizeofExpr" = do
  let operand = lookupNodeField "operand" node
  mapM_ walkExpr operand

walkExpr node | nodeKind node == "AlignofExpr" = do
  let operand = lookupNodeField "operand" node
  mapM_ walkExpr operand

-- Comma expression
walkExpr node | nodeKind node == "CommaExpr" = do
  let lhs = lookupNodeField "lhs" node
      rhs = lookupNodeField "rhs" node
  mapM_ walkExpr lhs
  mapM_ walkExpr rhs

-- Lambda (can appear in expression context, e.g., variable initializer)
walkExpr node | nodeKind node == "LambdaExpr" = walkLambda node

-- Error flow (ThrowExpr can appear in expression context)
walkExpr node | nodeKind node == "ThrowExpr" = walkErrorFlow node

-- Fallback: walk children
walkExpr node = mapM_ walkExpr (nodeChildren node)

-- ── Kind lists ─────────────────────────────────────────────────────────

castKinds :: [Text]
castKinds =
  [ "CStyleCastExpr"
  , "StaticCastExpr"
  , "DynamicCastExpr"
  , "ReinterpretCastExpr"
  , "ConstCastExpr"
  , "ImplicitCastExpr"
  , "FunctionalCastExpr"
  ]

literalKinds :: [Text]
literalKinds =
  [ "IntegerLiteral"
  , "FloatingLiteral"
  , "StringLiteral"
  , "CharacterLiteral"
  , "BoolLiteral"
  , "NullPtrLiteral"
  , "UserDefinedLiteral"
  ]

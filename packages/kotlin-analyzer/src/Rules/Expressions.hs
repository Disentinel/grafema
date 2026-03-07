{-# LANGUAGE OverloadedStrings #-}
-- | Expressions and statements rule for Kotlin.
--
-- Handles CALL, PROPERTY_ACCESS, REFERENCE, LITERAL, CLOSURE nodes
-- and CALLS, ASSIGNED_FROM, PASSES_ARGUMENT, INSTANTIATES, REFERENCES edges.
--
-- Kotlin-specific: SafeCallExpr (safe_call=true), WhenExpr (BRANCH kind=when),
-- ElvisExpr (BRANCH kind=elvis), DestructuringDecl, LambdaExpr (CLOSURE),
-- StringTemplateExpr, RangeExpr, IsExpr, AsExpr.
module Rules.Expressions
  ( walkExpr
  , walkStmt
  , walkStmts
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import KotlinAST
import Analysis.Types
    ( GraphNode(..)
    , GraphEdge(..)
    , MetaValue(..)
    , Scope(..)
    , ScopeKind(..)
    )
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , emitDeferred
    , askFile
    , askScopeId
    , askEnclosingFn
    , withScope
    , withEnclosingFn
    )
import Analysis.Types (DeferredRef(..), DeferredKind(..))
import Grafema.SemanticId (semanticId, contentHash)
import Rules.ControlFlow (walkControlFlow)


-- Name extraction

exprToName :: KotlinExpr -> Text
exprToName (NameExpr n _)           = n
exprToName (PropertyAccessExpr _ n _) = n
exprToName (ThisExpr _ _)           = "this"
exprToName (SuperExpr _ _ _)        = "super"
exprToName _                        = "<expr>"

-- Span helpers

spanLC :: Span -> (Int, Int)
spanLC sp = (posLine (spanStart sp), posCol (spanStart sp))

posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- Expression walker

walkExpr :: KotlinExpr -> Analyzer ()

-- CALL node: function call
walkExpr (CallExpr name mScope args _typeArgs sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "CALL" name parent (Just hash)
      receiverName = case mScope of
        Just scope -> exprToName scope
        Nothing    -> ""

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CALL"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("method", MetaBool True)
        , ("argCount", MetaInt (length args))
        ] ++
        [ ("receiver", MetaText receiverName) | not (T.null receiverName) ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

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
    , drReceiver   = if T.null receiverName then Nothing else Just receiverName
    , drMetadata   = Map.empty
    }

  mapM_ walkExpr mScope
  walkArgsWithEdges nodeId args

-- Safe call: obj?.method()
walkExpr (SafeCallExpr scope name args sp) = do
  file    <- askFile
  scopeId' <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "CALL" name parent (Just hash)
      receiverName = exprToName scope

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CALL"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("method",    MetaBool True)
        , ("safe_call", MetaBool True)
        , ("argCount",  MetaInt (length args))
        , ("receiver",  MetaText receiverName)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId'
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  emitDeferred DeferredRef
    { drKind       = CallResolve
    , drName       = name
    , drFromNodeId = nodeId
    , drEdgeType   = "CALLS"
    , drScopeId    = Just scopeId'
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Just receiverName
    , drMetadata   = Map.singleton "safe_call" (MetaBool True)
    }

  walkExpr scope
  walkArgsWithEdges nodeId args

-- Constructor call
walkExpr (ObjectCreationExpr classType args _typeArgs sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      className   = typeToName classType
      name        = className
      nodeId      = semanticId file "CALL" name parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CALL"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",     MetaText "constructor_call")
        , ("method",   MetaBool False)
        , ("argCount", MetaInt (length args))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  emitDeferred DeferredRef
    { drKind       = CallResolve
    , drName       = className
    , drFromNodeId = nodeId
    , drEdgeType   = "INSTANTIATES"
    , drScopeId    = Just scopeId
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.empty
    }

  walkArgsWithEdges nodeId args

-- Property access: obj.prop
walkExpr (PropertyAccessExpr scope propName sp) = do
  file     <- askFile
  scopeId' <- askScopeId
  encFn    <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "PROPERTY_ACCESS" propName parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "PROPERTY_ACCESS"
    , gnName      = propName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("base", MetaText (exprToName scope))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId'
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  walkExpr scope

-- Name expression (reference)
walkExpr (NameExpr name sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "REFERENCE" name parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "REFERENCE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.empty
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  emitDeferred DeferredRef
    { drKind       = CallResolve
    , drName       = name
    , drFromNodeId = nodeId
    , drEdgeType   = "REFERENCES"
    , drScopeId    = Just scopeId
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.empty
    }

-- Assignment
walkExpr (AssignExpr target _op value _sp) = do
  walkExpr target
  walkExpr value

-- CLOSURE node: lambda expression
walkExpr (LambdaExpr params body sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "CLOSURE" "<lambda>" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CLOSURE"
    , gnName      = "<lambda>"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("paramCount", MetaInt (length params))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  let lambdaScope = Scope
        { scopeId           = nodeId
        , scopeKind         = LambdaScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope lambdaScope $
    withEnclosingFn nodeId $ do
      mapM_ (walkLambdaParam file nodeId parent) params
      walkStmt body

-- LITERAL node
walkExpr (LiteralExpr litType litValue sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "LITERAL" litType parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "LITERAL"
    , gnName      = litValue
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("literal_type", MetaText litType)
        , ("value",        MetaText litValue)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- When expression -> BRANCH kind=when
walkExpr (WhenExpr mSubject entries sp) = do
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

  mapM_ walkExpr mSubject
  mapM_ walkWhenEntry entries

-- If expression
walkExpr (IfExpr cond thenExpr mElseExpr sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "if" parent (Just hash)

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
        [ ("kind",        MetaText "if_expr")
        , ("branchCount", MetaInt (case mElseExpr of { Nothing -> 1; Just _ -> 2 }))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  walkExpr cond
  walkExpr thenExpr
  mapM_ walkExpr mElseExpr

-- Elvis expression -> BRANCH kind=elvis
walkExpr (ElvisExpr left right sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "BRANCH" "elvis" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = "elvis"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",        MetaText "elvis")
        , ("branchCount", MetaInt 2)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  walkExpr left
  walkExpr right

-- Destructuring declaration
walkExpr (DestructuringDecl entries initExpr _sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn
  let parent = encFn >>= extractName

  -- Walk init first
  walkExpr initExpr

  -- Emit VARIABLE per destructured entry
  mapM_ (walkDestructuredVar file scopeId parent) entries

-- Transparent expressions
walkExpr (BinaryExpr left _op right _) =
  walkExpr left >> walkExpr right

walkExpr (UnaryExpr _op _prefix expr _) =
  walkExpr expr

walkExpr (NotNullAssertExpr expr _) =
  walkExpr expr

walkExpr (IsExpr expr _ty _negated _) =
  walkExpr expr

walkExpr (AsExpr expr _ty _safe _) =
  walkExpr expr

walkExpr (RangeExpr left right _op _) =
  walkExpr left >> walkExpr right

walkExpr (EnclosedExpr inner _) =
  walkExpr inner

walkExpr (StringTemplateExpr parts _) =
  mapM_ walkExpr parts

walkExpr (StringExprPart expr _) =
  walkExpr expr

walkExpr (StringLiteralPart _ _) = pure ()
walkExpr (ThisExpr _ _)          = pure ()
walkExpr (SuperExpr _ _ _)       = pure ()
walkExpr (ExprUnknown _)         = pure ()

-- When entry walker

walkWhenEntry :: KotlinWhenEntry -> Analyzer ()
walkWhenEntry entry = do
  mapM_ walkExpr (kweConditions entry)
  walkStmt (kweBody entry)

-- Statement walker

walkStmts :: [KotlinStmt] -> Analyzer ()
walkStmts = mapM_ walkStmt

walkStmt :: KotlinStmt -> Analyzer ()

walkStmt (ExprStmt expr _) =
  walkExpr expr

walkStmt (BlockStmt stmts _) =
  walkStmts stmts

walkStmt (ReturnStmt mExpr _label _) =
  mapM_ walkExpr mExpr

walkStmt (ThrowStmt expr _) =
  walkExpr expr

walkStmt stmt@(IfStmt cond thenStmt mElse _) = do
  walkControlFlow stmt
  walkExpr cond
  walkStmt thenStmt
  mapM_ walkStmt mElse

walkStmt stmt@(WhenStmt mSubject entries _) = do
  walkControlFlow stmt
  mapM_ walkExpr mSubject
  mapM_ (\e -> do
    mapM_ walkExpr (kweConditions e)
    walkStmt (kweBody e)
    ) entries

walkStmt stmt@(WhileStmt cond body _) = do
  walkControlFlow stmt
  walkExpr cond
  walkStmt body

walkStmt stmt@(DoWhileStmt cond body _) = do
  walkControlFlow stmt
  walkExpr cond
  walkStmt body

walkStmt stmt@(ForStmt var iter body sp) = do
  walkControlFlow stmt
  walkForVar var
  walkExpr iter
  walkStmt body
  -- Emit ITERATES_OVER edge
  file  <- askFile
  encFn <- askEnclosingFn
  let parent     = encFn >>= extractName
      (line, col) = spanLC sp
      branchHash = posHash line col
      branchId   = semanticId file "BRANCH" "for" parent (Just branchHash)
      varName    = kvName var
      (vLine, vCol) = spanLC (kvSpan var)
      varHash    = posHash vLine vCol
      varId      = semanticId file "VARIABLE" varName parent (Just varHash)
  emitEdge GraphEdge
    { geSource   = branchId
    , geTarget   = varId
    , geType     = "ITERATES_OVER"
    , geMetadata = Map.empty
    }

walkStmt stmt@(TryStmt tryBlock catches mFinally _) = do
  walkControlFlow stmt
  walkStmt tryBlock
  mapM_ walkCatchClause catches
  mapM_ walkStmt mFinally

walkStmt (VarDeclStmt isVal variables _) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn
  let parent = encFn >>= extractName
  mapM_ (walkLocalVarDecl file scopeId parent isVal) variables

walkStmt (BreakStmt _ _)    = pure ()
walkStmt (ContinueStmt _ _) = pure ()
walkStmt (EmptyStmt _)      = pure ()
walkStmt (StmtUnknown _)    = pure ()

-- Catch clause walker

walkCatchClause :: KotlinCatchClause -> Analyzer ()
walkCatchClause clause = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let name    = kccParamName clause
      parent  = encFn >>= extractName
      (pLine, pCol) = spanLC (kccSpan clause)
      hash    = posHash pLine pCol
      nodeId  = semanticId file "VARIABLE" name parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "VARIABLE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = pLine
    , gnColumn    = pCol
    , gnEndLine   = posLine (spanEnd (kccSpan clause))
    , gnEndColumn = posCol  (spanEnd (kccSpan clause))
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",    MetaText "catch_parameter")
        , ("mutable", MetaBool False)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  walkStmt (kccBody clause)

-- For variable walker

walkForVar :: KotlinVariable -> Analyzer ()
walkForVar var = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let varName = kvName var
      (line, col) = spanLC (kvSpan var)
      parent  = encFn >>= extractName
      hash    = posHash line col
      nodeId  = semanticId file "VARIABLE" varName parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "VARIABLE"
    , gnName      = varName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (kvSpan var))
    , gnEndColumn = posCol  (spanEnd (kvSpan var))
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",    MetaText "local")
        , ("mutable", MetaBool False)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- Local variable declaration walker

walkLocalVarDecl :: Text -> Text -> Maybe Text -> Bool -> KotlinVariable -> Analyzer ()
walkLocalVarDecl file scopeId parent isVal var = do
  let varName = kvName var
      (line, col) = spanLC (kvSpan var)
      hash    = posHash line col
      nodeId  = semanticId file "VARIABLE" varName parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "VARIABLE"
    , gnName      = varName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (kvSpan var))
    , gnEndColumn = posCol  (spanEnd (kvSpan var))
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",    MetaText "local")
        , ("mutable", MetaBool (not isVal))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  case kvInit var of
    Just expr -> walkExpr expr
    Nothing   -> pure ()

-- Destructured variable walker

walkDestructuredVar :: Text -> Text -> Maybe Text -> KotlinVariable -> Analyzer ()
walkDestructuredVar file scopeId parent var = do
  let varName = kvName var
      (line, col) = spanLC (kvSpan var)
      hash    = posHash line col
      nodeId  = semanticId file "VARIABLE" varName parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "VARIABLE"
    , gnName      = varName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (kvSpan var))
    , gnEndColumn = posCol  (spanEnd (kvSpan var))
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",    MetaText "destructured")
        , ("mutable", MetaBool False)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- Lambda parameter walker

walkLambdaParam :: Text -> Text -> Maybe Text -> KotlinParam -> Analyzer ()
walkLambdaParam file closureId parent param = do
  let name   = kpName param
      hash   = contentHash [("fn", closureId), ("name", name)]
      nodeId = semanticId file "PARAMETER" name parent (Just hash)
      (line, col) = spanLC (kpSpan param)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "PARAMETER"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (kpSpan param))
    , gnEndColumn = posCol  (spanEnd (kpSpan param))
    , gnExported  = False
    , gnMetadata  = Map.empty
    }

  emitEdge GraphEdge
    { geSource   = closureId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- Argument walking with PASSES_ARGUMENT edges

walkArgsWithEdges :: Text -> [KotlinExpr] -> Analyzer ()
walkArgsWithEdges callNodeId args =
  mapM_ walkIndexed (zip [0..] args)
  where
    walkIndexed :: (Int, KotlinExpr) -> Analyzer ()
    walkIndexed (idx, arg) = do
      walkExpr arg
      file  <- askFile
      encFn <- askEnclosingFn
      let parent  = encFn >>= extractName
          (al, ac) = spanLC (keSpan arg)
          argHash  = posHash al ac
          argName  = exprToName arg
          argNodeId = case arg of
            NameExpr n aSp ->
              let (nl, nc) = spanLC aSp
              in semanticId file "REFERENCE" n parent (Just (posHash nl nc))
            LiteralExpr lt _ aSp ->
              let (ll, lc) = spanLC aSp
              in semanticId file "LITERAL" lt parent (Just (posHash ll lc))
            CallExpr n _ _ _ aSp ->
              let (cl, cc) = spanLC aSp
              in semanticId file "CALL" n parent (Just (posHash cl cc))
            _ -> semanticId file "REFERENCE" argName parent (Just argHash)
      emitEdge GraphEdge
        { geSource   = callNodeId
        , geTarget   = argNodeId
        , geType     = "PASSES_ARGUMENT"
        , geMetadata = Map.singleton "index" (MetaInt idx)
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

typeToName :: KotlinType -> Text
typeToName (SimpleType n _ nullable _) =
  if nullable then n <> "?" else n
typeToName (FunctionType _ _ _ _ _ _) = "<function>"
typeToName (NullableType inner _) = typeToName inner <> "?"
typeToName (StarProjection _)     = "*"
typeToName (TypeUnknown _)        = "<unknown>"

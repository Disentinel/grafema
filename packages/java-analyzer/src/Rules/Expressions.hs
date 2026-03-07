{-# LANGUAGE OverloadedStrings #-}
-- | Expressions and statements rule: CALL, PROPERTY_ACCESS, REFERENCE,
-- LITERAL, CLOSURE nodes and CALLS, ASSIGNED_FROM, PASSES_ARGUMENT,
-- INSTANTIATES, REFERENCES edges.
--
-- Handles these Java expression types:
--   * 'MethodCallExpr'       -> CALL node (method=True), deferred CALLS edge
--   * 'ObjectCreationExpr'   -> CALL node (kind=constructor_call), deferred INSTANTIATES edge
--   * 'FieldAccessExpr'      -> PROPERTY_ACCESS node
--   * 'NameExpr'             -> REFERENCE node, deferred REFERENCES edge
--   * 'AssignExpr'           -> walks target and value, emits ASSIGNED_FROM
--   * 'LambdaExpr'           -> CLOSURE node, PARAMETER nodes, walks body
--   * 'LambdaBlockExpr'      -> CLOSURE node, PARAMETER nodes, walks block
--   * 'MethodRefExpr'        -> REFERENCE node (method_ref=True), deferred resolution
--   * 'LiteralExpr'          -> LITERAL node with value and literal_type metadata
--   * 'InstanceOfExpr'       -> walk expr; if pattern variable (Java 16+), emit VARIABLE
--   * 'VarDeclExpr'          -> VARIABLE nodes for each declared variable
--
-- "Transparent" expressions (binary, unary, cast, enclosed, conditional,
-- array) just walk their children recursively without emitting a new node.
--
-- Statement walker handles all Java statement types, dispatching to
-- expression walking, control flow, and error flow as needed.
--
-- Also emits CONTAINS edges from the enclosing scope to each emitted node,
-- and PASSES_ARGUMENT edges from CALL nodes to argument positions.
--
-- Called from 'Rules.Declarations' for expression statements and
-- variable initializers.
module Rules.Expressions
  ( walkExpr
  , walkStmt
  , walkStmts
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import JavaAST
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
    , askEnclosingClass
    , withScope
    , withEnclosingFn
    )
import Analysis.Types (DeferredRef(..), DeferredKind(..))
import Grafema.SemanticId (semanticId, contentHash)
import Rules.ControlFlow (walkControlFlow)
import {-# SOURCE #-} Rules.Declarations (walkDeclarations, walkMember)

-- ── Name extraction ────────────────────────────────────────────────────

-- | Extract a human-readable name from an expression.
exprToName :: JavaExpr -> Text
exprToName (NameExpr n _)          = n
exprToName (FieldAccessExpr _ n _) = n
exprToName (ThisExpr _ _)          = "this"
exprToName (SuperExpr _ _)         = "super"
exprToName _                       = "<expr>"

-- ── Span helpers ───────────────────────────────────────────────────────

-- | Extract line and col from a Span.
spanLC :: Span -> (Int, Int)
spanLC sp = (posLine (spanStart sp), posCol (spanStart sp))

-- | Build a content hash from line and col.
posHash :: Int -> Int -> Text
posHash line col = contentHash
  [ ("line", T.pack (show line))
  , ("col",  T.pack (show col))
  ]

-- ── Expression walker ──────────────────────────────────────────────────

-- | Walk a single Java expression, emitting graph nodes and edges.
walkExpr :: JavaExpr -> Analyzer ()

-- ── CALL node: method call ─────────────────────────────────────────────

walkExpr (MethodCallExpr name mScope args _typeArgs sp) = do
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

  -- Emit CALL node
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

  -- CONTAINS edge from scope
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred CALLS edge resolution
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

  -- Walk receiver expression
  mapM_ walkExpr mScope

  -- Walk arguments and emit PASSES_ARGUMENT edges
  walkArgsWithEdges nodeId args

-- ── CALL node: constructor call (new) ──────────────────────────────────

walkExpr (ObjectCreationExpr classType args _typeArgs mAnonBody sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      className   = typeToName classType
      name        = "new " <> className
      nodeId      = semanticId file "CALL" name parent (Just hash)

  -- Emit CALL node for constructor
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

  -- CONTAINS edge
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- INSTANTIATES deferred reference
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

  -- Walk arguments and emit PASSES_ARGUMENT edges
  walkArgsWithEdges nodeId args

  -- Walk anonymous class body if present
  case mAnonBody of
    Just members -> mapM_ walkMember members
    Nothing      -> pure ()

-- ── PROPERTY_ACCESS node: field access ─────────────────────────────────

walkExpr (FieldAccessExpr scope fieldName sp) = do
  file     <- askFile
  scopeId' <- askScopeId
  encFn    <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      nodeId      = semanticId file "PROPERTY_ACCESS" fieldName parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "PROPERTY_ACCESS"
    , gnName      = fieldName
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

  -- Walk base expression
  walkExpr scope

-- ── REFERENCE node: name expression ─────────────────────────────────────

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

  -- Deferred REFERENCES edge for resolution
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

-- ── ASSIGN: walks both sides, emits ASSIGNED_FROM ─────────────────────

walkExpr (AssignExpr target _op value sp) = do
  file    <- askFile
  encFn   <- askEnclosingFn

  -- Walk both sides first to emit their nodes
  walkExpr target
  walkExpr value

  let (_line, _col) = spanLC sp
      parent         = encFn >>= extractName
      targetName     = exprToName target
      valueName   = exprToName value
      targetHash  = posHash (fst (spanLC (jeSpan target))) (snd (spanLC (jeSpan target)))
      valueHash   = posHash (fst (spanLC (jeSpan value)))  (snd (spanLC (jeSpan value)))
      -- Build IDs matching the nodes emitted by walking target and value
      targetRef   = case target of
        NameExpr n tsp ->
          let (tl, tc) = spanLC tsp
          in semanticId file "REFERENCE" n parent (Just (posHash tl tc))
        FieldAccessExpr _ fn tsp ->
          let (tl, tc) = spanLC tsp
          in semanticId file "PROPERTY_ACCESS" fn parent (Just (posHash tl tc))
        _ -> semanticId file "REFERENCE" targetName parent (Just targetHash)
      valueRef    = case value of
        NameExpr n vsp ->
          let (vl, vc) = spanLC vsp
          in semanticId file "REFERENCE" n parent (Just (posHash vl vc))
        _ -> semanticId file "REFERENCE" valueName parent (Just valueHash)

  -- Emit ASSIGNED_FROM edge from target to value
  emitEdge GraphEdge
    { geSource   = targetRef
    , geTarget   = valueRef
    , geType     = "ASSIGNED_FROM"
    , geMetadata = Map.singleton "operator" (MetaText _op)
    }

-- ── CLOSURE node: lambda expression ─────────────────────────────────────

walkExpr (LambdaExpr params body _bodyKind sp) = do
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
        , ("bodyKind",   MetaText "expression")
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit PARAMETER nodes for lambda params
  let lambdaScope = Scope
        { scopeId           = nodeId
        , scopeKind         = LambdaScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope lambdaScope $ do
    mapM_ (walkLambdaParam file nodeId parent) params
    -- Walk body in lambda scope
    walkExpr body

-- ── CLOSURE node: lambda with block body ────────────────────────────────

walkExpr (LambdaBlockExpr params block sp) = do
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
        , ("bodyKind",   MetaText "block")
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit PARAMETER nodes and walk block body in lambda scope
  let lambdaScope = Scope
        { scopeId           = nodeId
        , scopeKind         = LambdaScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope lambdaScope $
    withEnclosingFn nodeId $ do
      mapM_ (walkLambdaParam file nodeId parent) params
      walkStmt block

-- ── REFERENCE node: method reference ────────────────────────────────────

walkExpr (MethodRefExpr scope refId sp) = do
  file     <- askFile
  scopeId' <- askScopeId
  encFn    <- askEnclosingFn

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      name        = exprToName scope <> "::" <> refId
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
    , gnMetadata  = Map.fromList
        [ ("method_ref", MetaBool True)
        , ("identifier", MetaText refId)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId'
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred resolution for the method reference target
  emitDeferred DeferredRef
    { drKind       = CallResolve
    , drName       = refId
    , drFromNodeId = nodeId
    , drEdgeType   = "REFERENCES"
    , drScopeId    = Just scopeId'
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Just (exprToName scope)
    , drMetadata   = Map.singleton "method_ref" (MetaBool True)
    }

  walkExpr scope

-- ── LITERAL node ────────────────────────────────────────────────────────

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

-- ── Transparent expressions: walk children only ────────────────────────

walkExpr (BinaryExpr left _op right _) =
  walkExpr left >> walkExpr right

walkExpr (UnaryExpr _op _prefix expr _) =
  walkExpr expr

walkExpr (ConditionalExpr cond thenExpr elseExpr sp) = do
  -- Emit BRANCH node for ternary conditional
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn
  let parent     = encFn >>= extractName
      (line, col) = spanLC sp
      hash       = posHash line col
      nodeId     = semanticId file "BRANCH" "ternary" parent (Just hash)
  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "BRANCH"
    , gnName      = "ternary"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",        MetaText "ternary")
        , ("branchCount", MetaInt 2)
        ]
    }
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }
  walkExpr cond >> walkExpr thenExpr >> walkExpr elseExpr

walkExpr (CastExpr _ty expr _) =
  walkExpr expr

walkExpr (InstanceOfExpr expr _ty mPat _sp) = do
  walkExpr expr
  -- Java 16+ pattern variable: emit VARIABLE for the pattern binding
  case mPat of
    Just (PatternExpr pName _pType pSp) -> do
      file    <- askFile
      scopeId <- askScopeId
      encFn   <- askEnclosingFn
      let (pLine, pCol) = spanLC pSp
          parent  = encFn >>= extractName
          hash    = posHash pLine pCol
          nodeId  = semanticId file "VARIABLE" pName parent (Just hash)
      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "VARIABLE"
        , gnName      = pName
        , gnFile      = file
        , gnLine      = pLine
        , gnColumn    = pCol
        , gnEndLine   = posLine (spanEnd pSp)
        , gnEndColumn = posCol  (spanEnd pSp)
        , gnExported  = False
        , gnMetadata  = Map.fromList
            [ ("kind",    MetaText "pattern_variable")
            , ("mutable", MetaBool False)
            ]
        }
      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }
    Just other -> walkExpr other
    Nothing    -> pure ()

walkExpr (EnclosedExpr inner _) =
  walkExpr inner

walkExpr (ArrayAccessExpr arr idx _) =
  walkExpr arr >> walkExpr idx

walkExpr (ArrayCreationExpr _ty dims mInit _) = do
  mapM_ (mapM_ walkExpr) dims
  mapM_ walkExpr mInit

walkExpr (ArrayInitExpr values _) =
  mapM_ walkExpr values

walkExpr (SwitchExpr sel entries sp) = do
  -- Emit BRANCH node for switch expression
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn
  let parent     = encFn >>= extractName
      (line, col) = spanLC sp
      hash       = posHash line col
      nodeId     = semanticId file "BRANCH" "switch" parent (Just hash)
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
        [ ("kind",       MetaText "switch_expr")
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
  walkExpr sel
  mapM_ walkSwitchEntryExprs entries

walkExpr (VarDeclExpr mods vars _sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn
  let parent = encFn >>= extractName
  mapM_ (walkVarDeclVariable file scopeId parent mods) vars

walkExpr (TextBlockExpr _ _)  = pure ()
walkExpr (ThisExpr _ _)       = pure ()
walkExpr (SuperExpr _ _)      = pure ()
walkExpr (ClassExpr _ _)      = pure ()
walkExpr (PatternExpr _ _ _)  = pure ()
walkExpr (ExprUnknown _)      = pure ()

-- ── Switch entry walker (for switch expressions) ──────────────────────

walkSwitchEntryExprs :: JavaSwitchEntry -> Analyzer ()
walkSwitchEntryExprs entry = do
  mapM_ walkExpr (jseLabels entry)
  mapM_ walkStmt (jseStmts entry)

-- ── Statement walker ──────────────────────────────────────────────────

-- | Walk a list of statements.
walkStmts :: [JavaStmt] -> Analyzer ()
walkStmts = mapM_ walkStmt

-- | Walk a single statement, dispatching to expression and sub-walkers.
walkStmt :: JavaStmt -> Analyzer ()

walkStmt (ExprStmt expr _) =
  walkExpr expr

walkStmt (BlockStmt stmts _) =
  walkStmts stmts

walkStmt (ReturnStmt mExpr _) =
  mapM_ walkExpr mExpr

walkStmt (ThrowStmt expr _) =
  walkExpr expr

walkStmt stmt@(IfStmt cond thenStmt mElse _) = do
  walkControlFlow stmt
  walkExpr cond
  walkStmt thenStmt
  mapM_ walkStmt mElse

walkStmt stmt@(SwitchStmt sel entries _) = do
  walkControlFlow stmt
  walkExpr sel
  mapM_ walkSwitchEntry entries

walkStmt stmt@(WhileStmt cond body _) = do
  walkControlFlow stmt
  walkExpr cond
  walkStmt body

walkStmt stmt@(DoStmt cond body _) = do
  walkControlFlow stmt
  walkExpr cond
  walkStmt body

walkStmt stmt@(ForStmt initExprs mCond updates body _) = do
  walkControlFlow stmt
  mapM_ walkExpr initExprs
  mapM_ walkExpr mCond
  mapM_ walkExpr updates
  walkStmt body

walkStmt stmt@(ForEachStmt var iter body sp) = do
  walkControlFlow stmt
  walkForEachVar var
  walkExpr iter
  walkStmt body
  -- Emit ITERATES_OVER: for-each BRANCH → loop VARIABLE
  file  <- askFile
  encFn <- askEnclosingFn
  let parent     = encFn >>= extractName
      (line, col) = spanLC sp
      branchHash = posHash line col
      branchId   = semanticId file "BRANCH" "for-each" parent (Just branchHash)
      varName    = jvName var
      (vLine, vCol) = spanLC (jvSpan var)
      varHash    = posHash vLine vCol
      varId      = semanticId file "VARIABLE" varName parent (Just varHash)
  emitEdge GraphEdge
    { geSource   = branchId
    , geTarget   = varId
    , geType     = "ITERATES_OVER"
    , geMetadata = Map.empty
    }

walkStmt stmt@(TryStmt resources tryBlock catches mFinally _) = do
  walkControlFlow stmt
  mapM_ walkExpr resources
  walkStmt tryBlock
  mapM_ walkCatchClause catches
  mapM_ walkStmt mFinally

walkStmt stmt@(SynchronizedStmt expr body _) = do
  walkControlFlow stmt
  walkExpr expr
  walkStmt body

walkStmt (LabeledStmt _ stmt _) =
  walkStmt stmt

walkStmt (AssertStmt check mMsg _) = do
  walkExpr check
  mapM_ walkExpr mMsg

walkStmt (LocalClassStmt classDecl _) =
  walkDeclarations classDecl

walkStmt (LocalRecordStmt recordDecl _) =
  walkDeclarations recordDecl

walkStmt (ExplicitCtorInvStmt isThis args mExpr sp) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn
  _encCls <- askEnclosingClass

  let (line, col) = spanLC sp
      parent      = encFn >>= extractName
      hash        = posHash line col
      name        = if isThis then "this" else "super"
      nodeId      = semanticId file "CALL" name parent (Just hash)

  -- Emit CALL node for this()/super() invocation
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
        , ("isThis",   MetaBool isThis)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Deferred resolution: CALLS to the target constructor
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
    , drMetadata   = Map.empty
    }

  -- Walk arguments and emit PASSES_ARGUMENT edges
  walkArgsWithEdges nodeId args

  -- Walk optional qualifying expression
  mapM_ walkExpr mExpr

walkStmt (VarDeclStmt mods variables _) = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn
  let parent = encFn >>= extractName
  mapM_ (walkLocalVarDecl file scopeId parent mods) variables

walkStmt (YieldStmt expr _) =
  walkExpr expr

walkStmt (BreakStmt _ _)    = pure ()
walkStmt (ContinueStmt _ _) = pure ()
walkStmt (EmptyStmt _)      = pure ()
walkStmt (StmtUnknown _)    = pure ()

-- ── Switch entry walker ─────────────────────────────────────────────────

walkSwitchEntry :: JavaSwitchEntry -> Analyzer ()
walkSwitchEntry entry = do
  mapM_ walkExpr (jseLabels entry)
  mapM_ walkStmt (jseStmts entry)

-- ── Catch clause walker ─────────────────────────────────────────────────

walkCatchClause :: JavaCatchClause -> Analyzer ()
walkCatchClause clause = do
  -- Emit VARIABLE node for catch parameter
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let param   = jccParam clause
      name    = jpName param
      parent  = encFn >>= extractName
      (pLine, pCol) = spanLC (jpSpan param)
      hash    = posHash pLine pCol
      nodeId  = semanticId file "VARIABLE" name parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "VARIABLE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = pLine
    , gnColumn    = pCol
    , gnEndLine   = posLine (spanEnd (jpSpan param))
    , gnEndColumn = posCol  (spanEnd (jpSpan param))
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",    MetaText "catch_parameter")
        , ("final",   MetaBool (jpIsFinal param))
        , ("mutable", MetaBool (not (jpIsFinal param)))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  walkStmt (jccBody clause)

-- ── ForEach variable walker ─────────────────────────────────────────────

walkForEachVar :: JavaVariable -> Analyzer ()
walkForEachVar var = do
  file    <- askFile
  scopeId <- askScopeId
  encFn   <- askEnclosingFn

  let varName = jvName var
      (line, col) = spanLC (jvSpan var)
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
    , gnEndLine   = posLine (spanEnd (jvSpan var))
    , gnEndColumn = posCol  (spanEnd (jvSpan var))
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

-- ── Local variable declaration walker ───────────────────────────────────

-- | Walk a local variable declaration (inside a method body).
walkLocalVarDecl :: Text -> Text -> Maybe Text -> [Text] -> JavaVariable
                 -> Analyzer ()
walkLocalVarDecl file scopeId parent mods var = do
  let varName = jvName var
      (line, col) = spanLC (jvSpan var)
      hash    = posHash line col
      nodeId  = semanticId file "VARIABLE" varName parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "VARIABLE"
    , gnName      = varName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (jvSpan var))
    , gnEndColumn = posCol  (spanEnd (jvSpan var))
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",    MetaText "local")
        , ("final",   MetaBool ("final" `elem` mods))
        , ("mutable", MetaBool (not ("final" `elem` mods)))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk initializer expression
  case jvInit var of
    Just expr -> do
      walkExpr expr
      -- Emit ASSIGNED_FROM edge from variable to its initializer
      let initHash = posHash (fst (spanLC (jeSpan expr))) (snd (spanLC (jeSpan expr)))
          initName = exprToName expr
          initRef  = case expr of
            NameExpr n eSp ->
              let (el, ec) = spanLC eSp
              in semanticId file "REFERENCE" n parent (Just (posHash el ec))
            _ -> semanticId file "REFERENCE" initName parent (Just initHash)
      emitEdge GraphEdge
        { geSource   = nodeId
        , geTarget   = initRef
        , geType     = "ASSIGNED_FROM"
        , geMetadata = Map.empty
        }
    Nothing -> pure ()

-- ── VarDeclExpr variable walker ─────────────────────────────────────────

-- | Walk a variable from a VarDeclExpr (expression-level var declaration).
walkVarDeclVariable :: Text -> Text -> Maybe Text -> [Text] -> JavaVariable
                    -> Analyzer ()
walkVarDeclVariable file scopeId parent mods var = do
  let varName = jvName var
      (line, col) = spanLC (jvSpan var)
      hash    = posHash line col
      nodeId  = semanticId file "VARIABLE" varName parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "VARIABLE"
    , gnName      = varName
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (jvSpan var))
    , gnEndColumn = posCol  (spanEnd (jvSpan var))
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",    MetaText "local")
        , ("final",   MetaBool ("final" `elem` mods))
        , ("mutable", MetaBool (not ("final" `elem` mods)))
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Walk initializer
  case jvInit var of
    Just expr -> walkExpr expr
    Nothing   -> pure ()

-- ── Lambda parameter walker ─────────────────────────────────────────────

-- | Emit a PARAMETER node for a lambda parameter.
walkLambdaParam :: Text -> Text -> Maybe Text -> JavaParam -> Analyzer ()
walkLambdaParam file closureId parent param = do
  let name   = jpName param
      hash   = contentHash [("fn", closureId), ("name", name)]
      nodeId = semanticId file "PARAMETER" name parent (Just hash)
      (line, col) = spanLC (jpSpan param)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "PARAMETER"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (jpSpan param))
    , gnEndColumn = posCol  (spanEnd (jpSpan param))
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("final",   MetaBool (jpIsFinal param))
        , ("varargs", MetaBool (jpIsVarArgs param))
        ]
    }

  emitEdge GraphEdge
    { geSource   = closureId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- ── Argument walking with PASSES_ARGUMENT edges ────────────────────────

-- | Walk call arguments and emit PASSES_ARGUMENT edges from the CALL node
-- to each argument position.
walkArgsWithEdges :: Text -> [JavaExpr] -> Analyzer ()
walkArgsWithEdges callNodeId args =
  mapM_ walkIndexed (zip [0..] args)
  where
    walkIndexed :: (Int, JavaExpr) -> Analyzer ()
    walkIndexed (idx, arg) = do
      walkExpr arg
      -- Emit PASSES_ARGUMENT edge from CALL to the walked arg node
      file  <- askFile
      encFn <- askEnclosingFn
      let parent  = encFn >>= extractName
          (al, ac) = spanLC (jeSpan arg)
          argHash  = posHash al ac
          argName  = exprToName arg
          argNodeId = case arg of
            NameExpr n aSp ->
              let (nl, nc) = spanLC aSp
              in semanticId file "REFERENCE" n parent (Just (posHash nl nc))
            LiteralExpr lt _ aSp ->
              let (ll, lc) = spanLC aSp
              in semanticId file "LITERAL" lt parent (Just (posHash ll lc))
            MethodCallExpr n _ _ _ aSp ->
              let (cl, cc) = spanLC aSp
              in semanticId file "CALL" n parent (Just (posHash cl cc))
            ObjectCreationExpr ct _ _ _ aSp ->
              let cn = typeToName ct
                  (cl, cc) = spanLC aSp
              in semanticId file "CALL" ("new " <> cn) parent (Just (posHash cl cc))
            _ -> semanticId file "REFERENCE" argName parent (Just argHash)
      emitEdge GraphEdge
        { geSource   = callNodeId
        , geTarget   = argNodeId
        , geType     = "PASSES_ARGUMENT"
        , geMetadata = Map.singleton "index" (MetaInt idx)
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
typeToName (ClassType n _ _ _)    = n
typeToName (PrimitiveType n _)    = n
typeToName (ArrayType comp _)     = typeToName comp <> "[]"
typeToName (VoidType _)           = "void"
typeToName (VarType _)            = "var"
typeToName _                      = "<type>"

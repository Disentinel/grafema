{-# LANGUAGE OverloadedStrings #-}
-- | Declaration rule: emits FUNCTION, CLASS, VARIABLE nodes for
-- Python def/async def, class, assignment, annotated assignment,
-- and lambda statements.
--
-- Handles these Python AST constructs:
--   * 'FunctionDef'   -> FUNCTION node (kind=function / async_function)
--   * 'ClassDef'      -> CLASS node
--   * 'AssignStmt'    -> VARIABLE node(s) (kind=assignment / instance_variable)
--   * 'AnnAssignStmt' -> VARIABLE node (kind=annotated_assignment / instance_variable)
--   * 'LambdaExpr'    -> FUNCTION node (kind=lambda)
--
-- Also emits CONTAINS, HAS_METHOD, HAS_PROPERTY, EXTENDS edges.
-- Walks function/class bodies recursively.
--
-- Called from 'Analysis.Walker.walkFile' for each top-level statement.
module Rules.Declarations
  ( walkDeclarations
  , walkMember
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import PythonAST
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
    , askFile
    , askScopeId
    , askEnclosingClass
    , askNamedParent
    , withScope
    , withEnclosingFn
    , withEnclosingClass
    , withNamedParent
    , withAsync
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Decorator helpers ────────────────────────────────────────────────

-- | Extract a decorator name from an expression.
decoratorName :: PythonExpr -> Text
decoratorName (NameExpr n _)       = n
decoratorName (AttributeExpr _ attr _) = attr
decoratorName (CallExpr func _ _ _)    = decoratorName func
decoratorName _                        = "<unknown>"

-- | Check if a decorator matches a given name.
isDecorator :: Text -> PythonExpr -> Bool
isDecorator target expr = decoratorName expr == target

-- | Detect method kind from decorator list.
detectMethodKind :: [PythonExpr] -> Text
detectMethodKind decos
  | any (isDecorator "staticmethod") decos = "staticmethod"
  | any (isDecorator "classmethod") decos  = "classmethod"
  | any (isDecorator "property") decos     = "property"
  | otherwise                              = "method"

-- ── Expression → Text helpers ────────────────────────────────────────

-- | Convert an expression to its text representation (for annotations, bases).
exprToText :: PythonExpr -> Text
exprToText (NameExpr n _)          = n
exprToText (AttributeExpr val attr _) =
  exprToText val <> "." <> attr
exprToText (SubscriptExpr val sl _) =
  exprToText val <> "[" <> exprToText sl <> "]"
exprToText (ConstantExpr v _ _)    = v
exprToText (TupleExpr elts _)      =
  T.intercalate ", " (map exprToText elts)
exprToText (StarredExpr v _)       = "*" <> exprToText v
exprToText _                       = "<expr>"

-- ── Parameter counting ──────────────────────────────────────────────

-- | Count total parameters in a PythonArguments structure.
totalParamCount :: PythonArguments -> Int
totalParamCount args =
  length (paPosonlyargs args)
  + length (paArgs args)
  + length (paKwonlyargs args)
  + (case paVararg args of Nothing -> 0; Just _ -> 1)
  + (case paKwarg args of Nothing -> 0; Just _ -> 1)

-- ── Top-level statement walker ───────────────────────────────────────

-- | Walk a statement and emit declaration nodes.
walkDeclarations :: PythonStmt -> Analyzer ()

-- FunctionDef / AsyncFunctionDef → FUNCTION node
walkDeclarations (FunctionDef name args body decos mReturns isAsync sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent
  encClass <- askEnclosingClass

  let nodeId = semanticId file "FUNCTION" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)
      kind   = if isAsync then "async_function" else "function"
      decoNames = map decoratorName decos
      methodKind = case encClass of
        Just _  -> detectMethodKind decos
        Nothing -> kind

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = True  -- module-level defs are exported in Python by default
    , gnMetadata  = Map.fromList $
        [ ("kind",       MetaText (case encClass of Just _ -> methodKind; Nothing -> kind))
        , ("async",      MetaBool isAsync)
        , ("paramCount", MetaInt (totalParamCount args))
        ]
        ++ case mReturns of
             Just ret -> [("return_annotation", MetaText (exprToText ret))]
             Nothing  -> []
        ++ case decoNames of
             [] -> []
             _  -> [("decorator_names", MetaText (T.intercalate "," decoNames))]
    }

  -- CONTAINS edge from current scope
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- HAS_METHOD edge from enclosing class
  case encClass of
    Just classId -> emitEdge GraphEdge
      { geSource   = classId
      , geTarget   = nodeId
      , geType     = "HAS_METHOD"
      , geMetadata = Map.empty
      }
    Nothing -> pure ()

  -- Emit VARIABLE nodes for each parameter
  walkFunctionParams nodeId args

  -- Walk body in function scope
  let fnScope = Scope
        { scopeId           = nodeId
        , scopeKind         = FunctionScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
      asyncAction = if isAsync then withAsync else id
  asyncAction $
    withScope fnScope $
    withEnclosingFn nodeId $
    withNamedParent name $
      mapM_ walkDeclarations body

-- ClassDef → CLASS node
walkDeclarations (ClassDef name bases keywords body decos sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let nodeId = semanticId file "CLASS" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)
      baseNames = map exprToText bases
      decoNames = map decoratorName decos
      hasMetaclass = any (\kw -> pkArg kw == Just "metaclass") keywords

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "CLASS"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = True  -- module-level classes are exported by default
    , gnMetadata  = Map.fromList $
        [ ("has_metaclass", MetaBool hasMetaclass)
        ]
        ++ case baseNames of
             [] -> []
             _  -> [("bases", MetaText (T.intercalate "," baseNames))]
        ++ case decoNames of
             [] -> []
             _  -> [("decorator_names", MetaText (T.intercalate "," decoNames))]
    }

  -- CONTAINS edge from current scope
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- EXTENDS edges for each base class
  mapM_ (\baseExpr ->
    let baseName = exprToText baseExpr
        baseId   = semanticId file "CLASS" baseName Nothing Nothing
    in emitEdge GraphEdge
      { geSource   = nodeId
      , geTarget   = baseId
      , geType     = "EXTENDS"
      , geMetadata = Map.fromList [("base_name", MetaText baseName)]
      }
    ) bases

  -- Walk body in class scope
  let classScope = Scope
        { scopeId           = nodeId
        , scopeKind         = ClassScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope classScope $
    withEnclosingClass nodeId $
    withNamedParent name $
      mapM_ walkDeclarations body

-- AssignStmt → VARIABLE nodes (plus ASSIGNED_FROM edge to the value, when
-- the value is an expression that gets its own graph node — see
-- 'valueNodeId' below).
walkDeclarations (AssignStmt targets value sp) = do
  mapM_ (walkAssignTarget sp value) targets

-- AnnAssignStmt → VARIABLE node with annotation
walkDeclarations (AnnAssignStmt target annotation mValue _simple sp) = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent
  encClass <- askEnclosingClass

  let line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)
      annotText = exprToText annotation

  case target of
    -- x: int = ...
    NameExpr varName _ -> do
      let hash   = contentHash [("line", T.pack (show line))]
          nodeId = semanticId file "VARIABLE" varName parent (Just hash)
          kind   = case encClass of
            Just _  -> "class_variable"
            Nothing -> "annotated_assignment"

      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "VARIABLE"
        , gnName      = varName
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = posLine (spanEnd sp)
        , gnEndColumn = posCol  (spanEnd sp)
        , gnExported  = True
        , gnMetadata  = Map.fromList
            [ ("kind",       MetaText kind)
            , ("annotation", MetaText annotText)
            , ("mutable",    MetaBool True)
            ]
        }

      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }

      -- HAS_PROPERTY from enclosing class
      case encClass of
        Just classId -> emitEdge GraphEdge
          { geSource   = classId
          , geTarget   = nodeId
          , geType     = "HAS_PROPERTY"
          , geMetadata = Map.empty
          }
        Nothing -> pure ()

      -- ASSIGNED_FROM to value, if value is an expression that becomes a node
      emitAssignedFromEdge file parent nodeId mValue

    -- self.x: int = ...
    AttributeExpr (NameExpr receiver _) attr _ | receiver == "self" -> do
      let hash   = contentHash [("line", T.pack (show line))]
          nodeId = semanticId file "VARIABLE" attr parent (Just hash)

      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "VARIABLE"
        , gnName      = attr
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = posLine (spanEnd sp)
        , gnEndColumn = posCol  (spanEnd sp)
        , gnExported  = True
        , gnMetadata  = Map.fromList
            [ ("kind",       MetaText "instance_variable")
            , ("annotation", MetaText annotText)
            , ("mutable",    MetaBool True)
            ]
        }

      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }

      case encClass of
        Just classId -> emitEdge GraphEdge
          { geSource   = classId
          , geTarget   = nodeId
          , geType     = "HAS_PROPERTY"
          , geMetadata = Map.empty
          }
        Nothing -> pure ()

      -- ASSIGNED_FROM to value, if any
      emitAssignedFromEdge file parent nodeId mValue

    _ -> pure ()

-- ExprStmt — walk to catch lambdas in expression position
walkDeclarations (ExprStmt expr sp) =
  walkExprDeclarations expr sp

-- For/While/If/With/Try — walk their bodies recursively
walkDeclarations (ForStmt _target _iter body orElse _isAsync _sp) = do
  mapM_ walkDeclarations body
  mapM_ walkDeclarations orElse

walkDeclarations (WhileStmt _test body orElse _sp) = do
  mapM_ walkDeclarations body
  mapM_ walkDeclarations orElse

walkDeclarations (IfStmt _test body orElse _sp) = do
  mapM_ walkDeclarations body
  mapM_ walkDeclarations orElse

walkDeclarations (WithStmt _items body _isAsync _sp) = do
  mapM_ walkDeclarations body

walkDeclarations (TryStmt body handlers orElse finalBody _sp) = do
  mapM_ walkDeclarations body
  mapM_ (\h -> mapM_ walkDeclarations (pehBody h)) handlers
  mapM_ walkDeclarations orElse
  mapM_ walkDeclarations finalBody

walkDeclarations (MatchStmt _subject cases _sp) = do
  mapM_ (\c -> mapM_ walkDeclarations (pmcBody c)) cases

-- All other statements — no declarations to emit
walkDeclarations _ = pure ()

-- ── walkMember — re-export for recursive use from Walker ────────────

-- | Walk a statement inside a class or function body.
-- Same as walkDeclarations; exported for use by Analysis.Walker.
walkMember :: PythonStmt -> Analyzer ()
walkMember = walkDeclarations

-- ── Assignment target walker ─────────────────────────────────────────

-- | Walk a single assignment target, emitting VARIABLE nodes and an
-- ASSIGNED_FROM edge to the value expression's node (when the value is an
-- expression that gets its own graph node — see 'valueNodeId').
walkAssignTarget :: Span -> PythonExpr -> PythonExpr -> Analyzer ()
walkAssignTarget sp value target = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent
  encClass <- askEnclosingClass

  let line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)

  case target of
    -- x = ...
    NameExpr varName _ -> do
      let hash   = contentHash [("line", T.pack (show line))]
          nodeId = semanticId file "VARIABLE" varName parent (Just hash)
          kind   = case encClass of
            Just _  -> "class_variable"
            Nothing -> "assignment"

      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "VARIABLE"
        , gnName      = varName
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = posLine (spanEnd sp)
        , gnEndColumn = posCol  (spanEnd sp)
        , gnExported  = True
        , gnMetadata  = Map.fromList
            [ ("kind",    MetaText kind)
            , ("mutable", MetaBool True)
            ]
        }

      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }

      -- HAS_PROPERTY from enclosing class
      case encClass of
        Just classId -> emitEdge GraphEdge
          { geSource   = classId
          , geTarget   = nodeId
          , geType     = "HAS_PROPERTY"
          , geMetadata = Map.empty
          }
        Nothing -> pure ()

      -- ASSIGNED_FROM to value (Just value because AssignStmt always has one)
      emitAssignedFromEdge file parent nodeId (Just value)

    -- self.x = ...
    AttributeExpr (NameExpr receiver _) attr _ | receiver == "self" -> do
      let hash   = contentHash [("line", T.pack (show line))]
          nodeId = semanticId file "VARIABLE" attr parent (Just hash)

      emitNode GraphNode
        { gnId        = nodeId
        , gnType      = "VARIABLE"
        , gnName      = attr
        , gnFile      = file
        , gnLine      = line
        , gnColumn    = col
        , gnEndLine   = posLine (spanEnd sp)
        , gnEndColumn = posCol  (spanEnd sp)
        , gnExported  = True
        , gnMetadata  = Map.fromList
            [ ("kind",    MetaText "instance_variable")
            , ("mutable", MetaBool True)
            ]
        }

      emitEdge GraphEdge
        { geSource   = scopeId
        , geTarget   = nodeId
        , geType     = "CONTAINS"
        , geMetadata = Map.empty
        }

      case encClass of
        Just classId -> emitEdge GraphEdge
          { geSource   = classId
          , geTarget   = nodeId
          , geType     = "HAS_PROPERTY"
          , geMetadata = Map.empty
          }
        Nothing -> pure ()

      -- ASSIGNED_FROM to value
      emitAssignedFromEdge file parent nodeId (Just value)

    -- Tuple unpacking: (a, b) = ... or [a, b] = ...
    -- We pass `value` through unchanged — every unpacked target gets the
    -- same ASSIGNED_FROM target. That is imprecise (real semantics is
    -- per-element), but matches what other analyzers do at this level
    -- of resolution and keeps the edge useful for downstream consumers.
    TupleExpr elts _ -> mapM_ (walkAssignTarget sp value) elts
    ListExpr  elts _ -> mapM_ (walkAssignTarget sp value) elts
    StarredExpr inner _ -> walkAssignTarget sp value inner

    -- Other targets (subscript, etc.) — skip
    _ -> pure ()

-- ── ASSIGNED_FROM emission ───────────────────────────────────────────
--
-- Predict the semantic ID of the value-expression's graph node and emit
-- an ASSIGNED_FROM edge from the freshly-emitted VARIABLE to it. The
-- target node is emitted later by 'Rules.Calls.walkExpr' (Walker order:
-- walkDeclarations runs before walkStmtExprs in walkStmt) — Grafema
-- accepts forward-reference edges because semantic IDs are deterministic.
--
-- We only emit an edge when the value-expression-walker emits a node:
--   CallExpr      → CALL
--   AttributeExpr → PROPERTY_ACCESS
--   NameExpr      → REFERENCE
-- Other value forms (literals, lambdas, comprehensions, …) are skipped:
--   Calls.walkExpr does not emit nodes for them today (e.g. ConstantExpr
--   is explicitly a no-op), so there is nothing to point at. Adding
--   LITERAL emission is a separate change.

emitAssignedFromEdge :: Text -> Maybe Text -> Text -> Maybe PythonExpr -> Analyzer ()
emitAssignedFromEdge _    _      _      Nothing      = pure ()
emitAssignedFromEdge file parent srcVar (Just expr) =
  case valueNodeId file parent expr of
    Nothing  -> pure ()
    Just dst -> emitEdge GraphEdge
      { geSource   = srcVar
      , geTarget   = dst
      , geType     = "ASSIGNED_FROM"
      , geMetadata = Map.empty
      }

valueNodeId :: Text -> Maybe Text -> PythonExpr -> Maybe Text
valueNodeId file parent expr = case expr of
  CallExpr func _ _ sp ->
    let (line, col) = (posLine (spanStart sp), posCol (spanStart sp))
        hash        = contentHash [("line", T.pack (show line)), ("col", T.pack (show col))]
    in Just (semanticId file "CALL" (callFuncName func) parent (Just hash))
  AttributeExpr _ attr sp ->
    let (line, col) = (posLine (spanStart sp), posCol (spanStart sp))
        hash        = contentHash [("line", T.pack (show line)), ("col", T.pack (show col))]
    in Just (semanticId file "PROPERTY_ACCESS" attr parent (Just hash))
  NameExpr name sp ->
    let (line, col) = (posLine (spanStart sp), posCol (spanStart sp))
        hash        = contentHash [("line", T.pack (show line)), ("col", T.pack (show col))]
    in Just (semanticId file "REFERENCE" name parent (Just hash))
  _ -> Nothing

-- | Mirror of 'Rules.Calls.extractFuncName' — duplicated here to avoid a
-- module-level import cycle (Calls already imports nothing from Declarations
-- but a future shared helpers module would be a cleaner refactor).
callFuncName :: PythonExpr -> Text
callFuncName (NameExpr n _)        = n
callFuncName (AttributeExpr _ a _) = a
callFuncName (CallExpr func _ _ _) = callFuncName func
callFuncName _                     = "<expr>"

-- ── Lambda and expression declaration walker ─────────────────────────

-- | Walk an expression looking for lambda declarations.
walkExprDeclarations :: PythonExpr -> Span -> Analyzer ()
walkExprDeclarations (LambdaExpr args body sp) _outerSp = do
  file    <- askFile
  scopeId <- askScopeId
  parent  <- askNamedParent

  let line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)
      hash   = contentHash [("line", T.pack (show line)), ("col", T.pack (show col))]
      nodeId = semanticId file "FUNCTION" "<lambda>" parent (Just hash)

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "FUNCTION"
    , gnName      = "<lambda>"
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd sp)
    , gnEndColumn = posCol  (spanEnd sp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind",       MetaText "lambda")
        , ("paramCount", MetaInt (totalParamCount args))
        ]
    }

  -- CONTAINS edge
  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit VARIABLE nodes for lambda parameters
  walkFunctionParams nodeId args

  -- Lambda body is a single expression — walk for nested lambdas
  let lambdaScope = Scope
        { scopeId           = nodeId
        , scopeKind         = LambdaScope
        , scopeDeclarations = mempty
        , scopeParent       = Nothing
        }
  withScope lambdaScope $
    withEnclosingFn nodeId $
      walkExprDeclarations body (Span (spanStart sp) (spanEnd sp))

walkExprDeclarations _ _ = pure ()

-- ── Parameter walker ─────────────────────────────────────────────────

-- | Walk all parameters in a PythonArguments structure, emitting VARIABLE nodes.
walkFunctionParams :: Text -> PythonArguments -> Analyzer ()
walkFunctionParams fnId args = do
  -- positional-only parameters
  mapM_ (walkParam fnId "parameter") (paPosonlyargs args)
  -- regular parameters
  mapM_ (walkParam fnId "parameter") (paArgs args)
  -- *args
  case paVararg args of
    Just varg -> walkParam fnId "variadic_parameter" varg
    Nothing   -> pure ()
  -- keyword-only parameters
  mapM_ (walkParam fnId "keyword_parameter") (paKwonlyargs args)
  -- **kwargs
  case paKwarg args of
    Just kwarg -> walkParam fnId "variadic_keyword_parameter" kwarg
    Nothing    -> pure ()

-- | Walk a single parameter, emitting a VARIABLE node with kind=parameter.
walkParam :: Text -> Text -> PythonArg -> Analyzer ()
walkParam fnId kind arg = do
  file <- askFile

  let name   = pargName arg
      hash   = contentHash [("fn", fnId), ("name", name)]
      nodeId = semanticId file "VARIABLE" name Nothing (Just hash)
      line   = posLine (spanStart (pargSpan arg))
      col    = posCol  (spanStart (pargSpan arg))

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "VARIABLE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (pargSpan arg))
    , gnEndColumn = posCol  (spanEnd (pargSpan arg))
    , gnExported  = False  -- parameters are never exported
    , gnMetadata  = Map.fromList $
        [ ("kind", MetaText kind)
        ]
        ++ case pargAnnotation arg of
             Just ann -> [("annotation", MetaText (exprToText ann))]
             Nothing  -> []
    }

  emitEdge GraphEdge
    { geSource   = fnId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

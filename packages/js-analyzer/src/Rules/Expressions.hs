{-# LANGUAGE OverloadedStrings #-}
-- Rules for expression nodes: calls, members, assignments, functions, literals,
-- references, transparent wrappers, binary/logical/unary expressions
module Rules.Expressions
  ( ruleCallExpression
  , ruleMemberExpression
  , ruleAssignmentExpression
  , ruleArrowFunction
  , ruleIdentifier
  , ruleLiteral
  , ruleObjectExpression
  , ruleArrayExpression
  , ruleProperty
  , ruleSpreadElement
  , ruleTemplateLiteral
  , ruleConditionalExpression
  , ruleAwaitExpression
  , ruleYieldExpression
  , ruleUpdateExpression
  , ruleNewExpression
  , ruleThisExpression
  , ruleSuperExpression
  , ruleTransparentWrapper
  , ruleSequenceExpression
  , ruleBinaryExpression
  , ruleLogicalExpression
  , ruleUnaryExpression
  , ruleTaggedTemplateExpression
  , ruleImportExpression
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map
import Data.Foldable (forM_)
import Analysis.Types
import Analysis.Context
import {-# SOURCE #-} Analysis.Walker (walkNode)
import Analysis.Scope (withScope, declareInScope)
import Analysis.SemanticId (semanticId, contentHash)
import AST.Types
import AST.Span (Span(..))
import Domain.Matcher (matchCallSite)

-- ── Call Expression ─────────────────────────────────────────────────────

ruleCallExpression :: ASTNode -> Analyzer (Maybe Text)
ruleCallExpression node = do
  file <- askFile
  parent <- askNamedParent
  let sp     = astNodeSpan node
      callee = getCallName node
      args   = getChildren "arguments" node
      arity  = length args
      firstLitArg = case args of
        (a:_) -> getTextFieldOr "value" "" a
        []    -> ""
      hash   = contentHash [("a", T.pack (show arity)), ("l", firstLitArg), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "CALL" callee parent (Just hash)

  emitNode GraphNode
    { gnId = nodeId, gnType = "CALL", gnName = callee
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.empty
    }

  curScopeId <- askScopeId
  emitDeferred DeferredRef
    { drKind = CallResolve, drName = callee
    , drFromNodeId = nodeId, drEdgeType = "CALLS"
    , drScopeId = Just curScopeId, drSource = Nothing
    , drFile = file, drLine = spanStart sp, drColumn = 0
    , drReceiver = Nothing, drMetadata = Map.empty
    }

  -- Walk arguments, emit PASSES_ARGUMENT edges using child IDs
  mapM_ (\(idx, arg) -> do
    mArgId <- withAncestor node (walkNode arg)
    forM_ mArgId $ \argId ->
      emitEdge GraphEdge
        { geSource = nodeId, geTarget = argId
        , geType = "PASSES_ARGUMENT"
        , geMetadata = Map.singleton "index" (MetaInt idx)
        }
    ) (zip [0..] args)

  -- Match against library definitions (domain-specific nodes)
  matchCallSite callee nodeId node

  -- Walk callee (discard result)
  case getChildrenMaybe "callee" node of
    Just c  -> withAncestor node (walkNode c) >> return ()
    Nothing -> return ()

  return (Just nodeId)

-- ── Member Expression ───────────────────────────────────────────────────

ruleMemberExpression :: ASTNode -> Analyzer (Maybe Text)
ruleMemberExpression node = do
  file <- askFile
  parent <- askNamedParent
  let sp       = astNodeSpan node
      propName = case getChildrenMaybe "property" node of
                   Just p  -> getTextFieldOr "name" "<computed>" p
                   Nothing -> "<computed>"
      computed = getBoolFieldOr "computed" False node
      objChain = case getChildrenMaybe "object" node of
                   Just o  -> getTextFieldOr "name" "<obj>" o
                   Nothing -> ""
      hash     = contentHash [("o", objChain), ("line", T.pack (show (spanStart sp)))]
      nodeId   = semanticId file "PROPERTY_ACCESS" propName parent (Just hash)

  emitNode GraphNode
    { gnId = nodeId, gnType = "PROPERTY_ACCESS", gnName = propName
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "computed" (MetaBool computed)
    }

  -- Walk object (discard result)
  case getChildrenMaybe "object" node of
    Just obj -> withAncestor node (walkNode obj) >> return ()
    Nothing  -> return ()
  -- Walk computed property (discard result)
  case getChildrenMaybe "property" node of
    Just prop | computed -> withAncestor node (walkNode prop) >> return ()
    _                    -> return ()

  return (Just nodeId)

-- ── Assignment Expression ───────────────────────────────────────────────

ruleAssignmentExpression :: ASTNode -> Analyzer (Maybe Text)
ruleAssignmentExpression node = do
  -- Walk both sides, get child IDs
  mLeftId <- case getChildrenMaybe "left" node of
    Just left -> withAncestor node (walkNode left)
    Nothing -> return Nothing
  mRightId <- case getChildrenMaybe "right" node of
    Just right -> withAncestor node (walkNode right)
    Nothing -> return Nothing

  -- Emit WRITES_TO with real IDs
  case (mLeftId, mRightId) of
    (Just leftId, Just rightId) ->
      emitEdge GraphEdge
        { geSource = leftId, geTarget = rightId
        , geType = "WRITES_TO"
        , geMetadata = Map.empty
        }
    _ -> return ()

  return mRightId

-- ── Arrow Function / Function Expression ────────────────────────────────

ruleArrowFunction :: ASTNode -> Analyzer (Maybe Text)
ruleArrowFunction node = do
  file <- askFile
  parent <- askNamedParent
  let sp      = astNodeSpan node
      isAsync = getBoolFieldOr "async" False node
      isArrow = case node of
                  ArrowFunctionExpressionNode _ _ -> True
                  _                               -> False
      kind    = if isArrow then "arrow" else "expression"
      params  = getChildren "params" node
      arity   = length params
      firstParam = case params of
        (p:_) -> getTextFieldOr "name" "<param>" p
        []    -> ""
      hash    = contentHash [("a", T.pack (show arity)), ("p", firstParam), ("line", T.pack (show (spanStart sp)))]
      nodeId  = semanticId file "FUNCTION" ("<" <> kind <> ">") parent (Just hash)

  emitNode GraphNode
    { gnId = nodeId, gnType = "FUNCTION", gnName = "<" <> kind <> ">"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("async", MetaBool isAsync)
        , ("kind", MetaText kind)
        ]
    }

  withEnclosingFn nodeId $ withNamedParent ("<" <> kind <> ">") $ withScope FunctionScope nodeId $ do
    let walkBody = case getChildrenMaybe "body" node of
          Just body -> withAncestor node (walkNode body) >> return ()
          Nothing   -> return ()
    declareArrowParams file ("<" <> kind <> ">") nodeId node params walkBody

  return (Just nodeId)

-- ── Identifier (expression context) → REFERENCE node ──────────────────

ruleIdentifier :: ASTNode -> Analyzer (Maybe Text)
ruleIdentifier node = do
  file <- askFile
  parent <- askNamedParent
  let sp   = astNodeSpan node
      name = getTextFieldOr "name" "" node
      hash = contentHash [("line", T.pack (show (spanStart sp)))]
      refId = semanticId file "REFERENCE" name parent (Just hash)

  emitNode GraphNode
    { gnId = refId, gnType = "REFERENCE", gnName = name
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }

  curScopeId <- askScopeId
  emitDeferred DeferredRef
    { drKind = ScopeLookup, drName = name
    , drFromNodeId = refId
    , drEdgeType = "READS_FROM"
    , drScopeId = Just curScopeId, drSource = Nothing
    , drFile = file, drLine = spanStart sp, drColumn = 0
    , drReceiver = Nothing, drMetadata = Map.empty
    }

  return (Just refId)

-- ── This Expression → REFERENCE node ──────────────────────────────────

ruleThisExpression :: ASTNode -> Analyzer (Maybe Text)
ruleThisExpression node = do
  file <- askFile
  parent <- askNamedParent
  let sp   = astNodeSpan node
      hash = contentHash [("line", T.pack (show (spanStart sp)))]
      refId = semanticId file "REFERENCE" "this" parent (Just hash)

  emitNode GraphNode
    { gnId = refId, gnType = "REFERENCE", gnName = "this"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }

  return (Just refId)

-- ── Super Expression → REFERENCE node ─────────────────────────────────

ruleSuperExpression :: ASTNode -> Analyzer (Maybe Text)
ruleSuperExpression node = do
  file <- askFile
  parent <- askNamedParent
  let sp   = astNodeSpan node
      hash = contentHash [("line", T.pack (show (spanStart sp)))]
      refId = semanticId file "REFERENCE" "super" parent (Just hash)

  emitNode GraphNode
    { gnId = refId, gnType = "REFERENCE", gnName = "super"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }

  return (Just refId)

-- ── Transparent Wrapper (PROPAGATES) ──────────────────────────────────

ruleTransparentWrapper :: Text -> ASTNode -> Analyzer (Maybe Text)
ruleTransparentWrapper childField node =
  case getChildrenMaybe childField node of
    Just child -> withAncestor node (walkNode child)
    Nothing    -> return Nothing

-- ── Sequence Expression ───────────────────────────────────────────────

ruleSequenceExpression :: ASTNode -> Analyzer (Maybe Text)
ruleSequenceExpression node = do
  let exprs = getChildren "expressions" node
  results <- mapM (\e -> withAncestor node (walkNode e)) exprs
  case results of
    [] -> return Nothing
    _  -> return (last results)

-- ── Literals ────────────────────────────────────────────────────────────

ruleLiteral :: ASTNode -> Analyzer (Maybe Text)
ruleLiteral node = do
  file <- askFile
  parent <- askNamedParent
  let sp    = astNodeSpan node
      value = getTextFieldOr "value" "" node
      raw   = getTextFieldOr "raw" value node
      raw'  = T.take 20 raw
      hash  = contentHash [("r", raw'), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "LITERAL" raw parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "LITERAL", gnName = raw
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  return (Just nodeId)

-- ── Object Expression ──────────────────────────────────────────────────
ruleObjectExpression :: ASTNode -> Analyzer (Maybe Text)
ruleObjectExpression node = do
  file <- askFile
  parent <- askNamedParent
  let sp     = astNodeSpan node
      hash   = contentHash [("r", "<object>"), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "LITERAL" "<object>" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "LITERAL", gnName = "<object>"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "kind" (MetaText "object")
    }
  let props = getChildren "properties" node
  mapM_ (\(idx, p) -> do
    let keyName = case getChildrenMaybe "key" p of
                    Just keyNode -> getTextFieldOr "name"
                                      (getTextFieldOr "value" "" keyNode)
                                      keyNode
                    Nothing      -> ""
    mPropId <- withAncestor node (walkNode p)
    forM_ mPropId $ \propId ->
      emitEdge GraphEdge
        { geSource = nodeId, geTarget = propId
        , geType = "HAS_PROPERTY"
        , geMetadata = Map.fromList
            [ ("index", MetaInt idx)
            , ("key", MetaText keyName)
            ]
        }
    ) (zip [0..] props)
  return (Just nodeId)

-- ── Array Expression ───────────────────────────────────────────────────
ruleArrayExpression :: ASTNode -> Analyzer (Maybe Text)
ruleArrayExpression node = do
  file <- askFile
  parent <- askNamedParent
  let sp     = astNodeSpan node
      hash   = contentHash [("r", "<array>"), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "LITERAL" "<array>" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "LITERAL", gnName = "<array>"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "kind" (MetaText "array")
    }
  let elems = getChildren "elements" node
  mapM_ (\(idx, e) -> do
    mElemId <- withAncestor node (walkNode e)
    forM_ mElemId $ \elemId ->
      emitEdge GraphEdge
        { geSource = nodeId, geTarget = elemId
        , geType = "HAS_ELEMENT"
        , geMetadata = Map.singleton "index" (MetaInt idx)
        }
    ) (zip [0..] elems)
  return (Just nodeId)

-- ── Property ───────────────────────────────────────────────────────────
ruleProperty :: ASTNode -> Analyzer (Maybe Text)
ruleProperty node = do
  -- Walk key (discard result)
  case getChildrenMaybe "key" node of
    Just key -> withAncestor node (walkNode key) >> return ()
    Nothing  -> return ()
  -- Walk value, return its ID
  case getChildrenMaybe "value" node of
    Just val -> withAncestor node (walkNode val)
    Nothing  -> return Nothing

-- ── Spread Element ─────────────────────────────────────────────────────
ruleSpreadElement :: ASTNode -> Analyzer (Maybe Text)
ruleSpreadElement node = do
  case getChildrenMaybe "argument" node of
    Just arg -> withAncestor node (walkNode arg)
    Nothing  -> return Nothing

-- ── Template Literal ─────────────────────────────────────────────────
ruleTemplateLiteral :: ASTNode -> Analyzer (Maybe Text)
ruleTemplateLiteral node = do
  file <- askFile
  parent <- askNamedParent
  let sp     = astNodeSpan node
      hash   = contentHash [("r", "<template>"), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "LITERAL" "<template>" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "LITERAL", gnName = "<template>"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "kind" (MetaText "template")
    }
  -- Walk interpolated expressions (discard results)
  let exprs = getChildren "expressions" node
  mapM_ (\expr -> withAncestor node (walkNode expr) >> return ()) exprs
  -- Walk quasis (template elements, discard results)
  let quasis = getChildren "quasis" node
  mapM_ (\q -> withAncestor node (walkNode q) >> return ()) quasis
  return (Just nodeId)

-- ── Conditional Expression ───────────────────────────────────────────
ruleConditionalExpression :: ASTNode -> Analyzer (Maybe Text)
ruleConditionalExpression node = do
  file <- askFile
  parent <- askNamedParent
  let sp     = astNodeSpan node
      hash   = contentHash [("k", "ternary"), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "BRANCH" "ternary" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "BRANCH", gnName = "ternary"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.empty
    }
  -- test -> HAS_CONDITION
  case getChildrenMaybe "test" node of
    Just test -> do
      mTestId <- withAncestor node (walkNode test)
      forM_ mTestId $ \testId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = testId
          , geType = "HAS_CONDITION"
          , geMetadata = Map.empty
          }
    Nothing -> return ()
  -- consequent -> HAS_CONSEQUENT
  case getChildrenMaybe "consequent" node of
    Just cons -> do
      mConsId <- withAncestor node (walkNode cons)
      forM_ mConsId $ \consId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = consId
          , geType = "HAS_CONSEQUENT"
          , geMetadata = Map.empty
          }
    Nothing -> return ()
  -- alternate -> HAS_ALTERNATE
  case getChildrenMaybe "alternate" node of
    Just alt -> do
      mAltId <- withAncestor node (walkNode alt)
      forM_ mAltId $ \altId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = altId
          , geType = "HAS_ALTERNATE"
          , geMetadata = Map.empty
          }
    Nothing -> return ()
  return (Just nodeId)

-- ── Await Expression ─────────────────────────────────────────────────
ruleAwaitExpression :: ASTNode -> Analyzer (Maybe Text)
ruleAwaitExpression node = do
  enclosing <- askEnclosingFn
  mChildId <- case getChildrenMaybe "argument" node of
    Just arg -> withAncestor node (walkNode arg)
    Nothing  -> return Nothing
  case enclosing of
    Just fnId ->
      forM_ mChildId $ \childId ->
        emitEdge GraphEdge
          { geSource = fnId, geTarget = childId
          , geType = "AWAITS", geMetadata = Map.empty
          }
    Nothing -> return ()
  return mChildId

-- ── Yield Expression ─────────────────────────────────────────────────
ruleYieldExpression :: ASTNode -> Analyzer (Maybe Text)
ruleYieldExpression node = do
  enclosing <- askEnclosingFn
  mChildId <- case getChildrenMaybe "argument" node of
    Just arg -> withAncestor node (walkNode arg)
    Nothing  -> return Nothing
  case enclosing of
    Just fnId ->
      forM_ mChildId $ \childId ->
        emitEdge GraphEdge
          { geSource = fnId, geTarget = childId
          , geType = "YIELDS", geMetadata = Map.empty
          }
    Nothing -> return ()
  return mChildId

-- ── Update Expression ────────────────────────────────────────────────
ruleUpdateExpression :: ASTNode -> Analyzer (Maybe Text)
ruleUpdateExpression node = do
  case getChildrenMaybe "argument" node of
    Just arg -> withAncestor node (walkNode arg)
    Nothing  -> return Nothing

-- ── New Expression ───────────────────────────────────────────────────
ruleNewExpression :: ASTNode -> Analyzer (Maybe Text)
ruleNewExpression node = do
  file <- askFile
  parent <- askNamedParent
  let sp     = astNodeSpan node
      callee = getCallName node
      args   = getChildren "arguments" node
      arity  = length args
      firstLitArg = case args of
        (a:_) -> getTextFieldOr "value" "" a
        []    -> ""
      hash   = contentHash [("a", T.pack (show arity)), ("l", firstLitArg), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "CALL" callee parent (Just hash)

  emitNode GraphNode
    { gnId = nodeId, gnType = "CALL", gnName = callee
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "kind" (MetaText "new")
    }

  curScopeId <- askScopeId
  emitDeferred DeferredRef
    { drKind = CallResolve, drName = callee
    , drFromNodeId = nodeId, drEdgeType = "CALLS"
    , drScopeId = Just curScopeId, drSource = Nothing
    , drFile = file, drLine = spanStart sp, drColumn = 0
    , drReceiver = Nothing, drMetadata = Map.empty
    }

  -- Walk arguments, emit PASSES_ARGUMENT edges using child IDs
  mapM_ (\(idx, arg) -> do
    mArgId <- withAncestor node (walkNode arg)
    forM_ mArgId $ \argId ->
      emitEdge GraphEdge
        { geSource = nodeId, geTarget = argId
        , geType = "PASSES_ARGUMENT"
        , geMetadata = Map.singleton "index" (MetaInt idx)
        }
    ) (zip [0..] args)

  -- Match against library definitions (domain-specific nodes)
  matchCallSite callee nodeId node

  -- Walk callee (discard result)
  case getChildrenMaybe "callee" node of
    Just c  -> withAncestor node (walkNode c) >> return ()
    Nothing -> return ()

  return (Just nodeId)

-- ── Binary Expression → EXPRESSION node ───────────────────────────────

ruleBinaryExpression :: ASTNode -> Analyzer (Maybe Text)
ruleBinaryExpression node = do
  file <- askFile
  parent <- askNamedParent
  let sp = astNodeSpan node
      op = getTextFieldOr "operator" "<op>" node
      hash = contentHash [("op", op), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "EXPRESSION" op parent (Just hash)

  emitNode GraphNode
    { gnId = nodeId, gnType = "EXPRESSION", gnName = op
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "operator" (MetaText op)
    }

  case getChildrenMaybe "left" node of
    Just left -> do
      mLeftId <- withAncestor node (walkNode left)
      forM_ mLeftId $ \leftId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = leftId
          , geType = "DERIVED_FROM", geMetadata = Map.empty
          }
    Nothing -> return ()

  case getChildrenMaybe "right" node of
    Just right -> do
      mRightId <- withAncestor node (walkNode right)
      forM_ mRightId $ \rightId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = rightId
          , geType = "DERIVED_FROM", geMetadata = Map.empty
          }
    Nothing -> return ()

  return (Just nodeId)

-- ── Logical Expression → EXPRESSION node ──────────────────────────────

ruleLogicalExpression :: ASTNode -> Analyzer (Maybe Text)
ruleLogicalExpression node = do
  file <- askFile
  parent <- askNamedParent
  let sp = astNodeSpan node
      op = getTextFieldOr "operator" "<op>" node
      hash = contentHash [("op", op), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "EXPRESSION" op parent (Just hash)

  emitNode GraphNode
    { gnId = nodeId, gnType = "EXPRESSION", gnName = op
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "operator" (MetaText op)
    }

  case getChildrenMaybe "left" node of
    Just left -> do
      mLeftId <- withAncestor node (walkNode left)
      forM_ mLeftId $ \leftId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = leftId
          , geType = "DERIVED_FROM", geMetadata = Map.empty
          }
    Nothing -> return ()

  case getChildrenMaybe "right" node of
    Just right -> do
      mRightId <- withAncestor node (walkNode right)
      forM_ mRightId $ \rightId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = rightId
          , geType = "DERIVED_FROM", geMetadata = Map.empty
          }
    Nothing -> return ()

  return (Just nodeId)

-- ── Unary Expression → EXPRESSION node ────────────────────────────────

ruleUnaryExpression :: ASTNode -> Analyzer (Maybe Text)
ruleUnaryExpression node = do
  file <- askFile
  parent <- askNamedParent
  let sp = astNodeSpan node
      op = getTextFieldOr "operator" "<op>" node
      hash = contentHash [("op", op), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "EXPRESSION" op parent (Just hash)

  emitNode GraphNode
    { gnId = nodeId, gnType = "EXPRESSION", gnName = op
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "operator" (MetaText op)
    }

  case getChildrenMaybe "argument" node of
    Just arg -> do
      mArgId <- withAncestor node (walkNode arg)
      forM_ mArgId $ \argId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = argId
          , geType = "DERIVED_FROM", geMetadata = Map.empty
          }
    Nothing -> return ()

  return (Just nodeId)

-- ── Tagged Template Expression → CALL node ────────────────────────────

ruleTaggedTemplateExpression :: ASTNode -> Analyzer (Maybe Text)
ruleTaggedTemplateExpression node = do
  file <- askFile
  parent <- askNamedParent
  let sp = astNodeSpan node
      tagName = case getChildrenMaybe "tag" node of
                  Just t  -> getTextFieldOr "name" "<tag>" t
                  Nothing -> "<tag>"
      hash = contentHash [("t", tagName), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "CALL" tagName parent (Just hash)

  emitNode GraphNode
    { gnId = nodeId, gnType = "CALL", gnName = tagName
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "kind" (MetaText "tagged_template")
    }

  -- Walk tag
  case getChildrenMaybe "tag" node of
    Just tag -> withAncestor node (walkNode tag) >> return ()
    Nothing  -> return ()

  -- Walk quasi (template literal)
  case getChildrenMaybe "quasi" node of
    Just quasi -> do
      mQuasiId <- withAncestor node (walkNode quasi)
      forM_ mQuasiId $ \quasiId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = quasiId
          , geType = "DERIVED_FROM", geMetadata = Map.empty
          }
    Nothing -> return ()

  return (Just nodeId)

-- ── Import Expression (dynamic import) → CALL node ────────────────────

ruleImportExpression :: ASTNode -> Analyzer (Maybe Text)
ruleImportExpression node = do
  file <- askFile
  parent <- askNamedParent
  let sp = astNodeSpan node
      hash = contentHash [("k", "import"), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "CALL" "import" parent (Just hash)

  emitNode GraphNode
    { gnId = nodeId, gnType = "CALL", gnName = "import"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "kind" (MetaText "dynamic_import")
    }

  -- Walk source argument
  case getChildrenMaybe "source" node of
    Just src -> do
      mSrcId <- withAncestor node (walkNode src)
      forM_ mSrcId $ \srcId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = srcId
          , geType = "PASSES_ARGUMENT"
          , geMetadata = Map.singleton "index" (MetaInt 0)
          }
    Nothing -> return ()

  return (Just nodeId)

-- ── Arrow/FunctionExpression param helpers ──────────────────────────────

-- | Process params with scope accumulation for arrow functions / function expressions.
-- Each param is declared in scope for subsequent params and the body action.
declareArrowParams :: Text -> Text -> Text -> ASTNode -> [ASTNode] -> Analyzer () -> Analyzer ()
declareArrowParams _file _fnName _fnNodeId _parentNode [] bodyAction = bodyAction
declareArrowParams file fnName fnNodeId parentNode (p:ps) bodyAction = do
  let pName = getTextFieldOr "name" "<param>" p
      pId   = semanticId file "PARAMETER" pName (Just fnName) Nothing
  curScopeId <- askScopeId
  emitNode GraphNode
    { gnId = pId, gnType = "PARAMETER", gnName = pName
    , gnFile = file, gnLine = spanStart (astNodeSpan p), gnColumn = 0
    , gnEndLine = spanEnd (astNodeSpan p), gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  emitEdge GraphEdge
    { geSource = fnNodeId, geTarget = pId
    , geType = "RECEIVES_ARGUMENT", geMetadata = Map.empty
    }
  emitEdge GraphEdge
    { geSource = curScopeId, geTarget = pId
    , geType = "DECLARES", geMetadata = Map.empty
    }
  -- Walk param for defaults, destructuring, type annotations
  withAncestor parentNode (walkNode p) >> return ()
  declareInScope (Declaration pId DeclParam pName) $
    declareArrowParams file fnName fnNodeId parentNode ps bodyAction

-- ── Helpers ─────────────────────────────────────────────────────────────

-- | Extract human-readable callee name from a call expression
getCallName :: ASTNode -> Text
getCallName node =
  case getChildrenMaybe "callee" node of
    Just callee -> case callee of
      IdentifierNode _ _      -> getTextFieldOr "name" "<call>" callee
      MemberExpressionNode _ _ ->
        let obj  = case getChildrenMaybe "object" callee of
                     Just o  -> getTextFieldOr "name" "<obj>" o
                     Nothing -> "<obj>"
            prop = case getChildrenMaybe "property" callee of
                     Just p  -> getTextFieldOr "name" "<prop>" p
                     Nothing -> "<prop>"
        in obj <> "." <> prop
      _ -> "<call>"
    Nothing -> "<call>"

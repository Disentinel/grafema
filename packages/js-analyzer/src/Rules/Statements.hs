{-# LANGUAGE OverloadedStrings #-}
-- Rules for statement nodes: return, throw, if, switch, loops, try/catch
module Rules.Statements
  ( ruleReturnStatement
  , ruleThrowStatement
  , ruleIfStatement
  , ruleSwitchStatement
  , ruleSwitchCase
  , ruleForStatement
  , ruleForInOfStatement
  , ruleWhileStatement
  , ruleTryStatement
  , ruleBlockStatement
  , ruleExpressionStatement
  , ruleCatchClause
  ) where

import qualified Data.Map.Strict as Map
import Data.Foldable (forM_)
import Data.Text (Text)
import qualified Data.Text as T
import Analysis.Types
import Analysis.Context (Analyzer, askFile, askEnclosingFn, askNamedParent, askScopeId, emitNode, emitEdge, emitExport, withAncestor, withExported)
import {-# SOURCE #-} Analysis.Walker (walkNode)
import Analysis.Scope (withScope, declareInScope)
import Analysis.SemanticId (semanticId, contentHash)
import AST.Types
import AST.Span (Span(..))

-- ── Return Statement ────────────────────────────────────────────────────

ruleReturnStatement :: ASTNode -> Analyzer (Maybe Text)
ruleReturnStatement node = do
  encFn <- askEnclosingFn
  mChildId <- case getChildrenMaybe "argument" node of
    Just arg -> withAncestor node (walkNode arg)
    Nothing  -> return Nothing
  case encFn of
    Just fnId ->
      forM_ mChildId $ \childId ->
        emitEdge GraphEdge
          { geSource = fnId, geTarget = childId
          , geType = "RETURNS", geMetadata = Map.empty
          }
    Nothing -> return ()
  return Nothing

-- ── Throw Statement ─────────────────────────────────────────────────────

ruleThrowStatement :: ASTNode -> Analyzer (Maybe Text)
ruleThrowStatement node = do
  encFn <- askEnclosingFn
  mChildId <- case getChildrenMaybe "argument" node of
    Just arg -> withAncestor node (walkNode arg)
    Nothing  -> return Nothing
  -- Use enclosing function, or fall back to module for top-level throws
  let mSource = case encFn of
        Just fnId -> Just fnId
        Nothing   -> Nothing  -- will use scope ID below
  case mSource of
    Just fnId ->
      forM_ mChildId $ \childId ->
        emitEdge GraphEdge
          { geSource = fnId, geTarget = childId
          , geType = "THROWS", geMetadata = Map.empty
          }
    Nothing -> do
      throwScopeId <- askScopeId
      forM_ mChildId $ \childId ->
        emitEdge GraphEdge
          { geSource = throwScopeId, geTarget = childId
          , geType = "THROWS", geMetadata = Map.empty
          }
  return Nothing

-- ── If Statement ────────────────────────────────────────────────────────

ruleIfStatement :: ASTNode -> Analyzer (Maybe Text)
ruleIfStatement node = do
  file <- askFile
  parent <- askNamedParent
  let sp = astNodeSpan node
      hash = contentHash [("k", "if"), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "BRANCH" "if" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "BRANCH", gnName = "if"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  case getChildrenMaybe "test" node of
    Just test -> do
      mTestId <- withAncestor node (walkNode test)
      forM_ mTestId $ \testId ->
        emitEdge GraphEdge { geSource = nodeId, geTarget = testId, geType = "HAS_CONDITION", geMetadata = Map.empty }
    Nothing -> return ()
  case getChildrenMaybe "consequent" node of
    Just cons -> do
      mConsId <- withAncestor node (walkNode cons)
      forM_ mConsId $ \consId ->
        emitEdge GraphEdge { geSource = nodeId, geTarget = consId, geType = "HAS_CONSEQUENT", geMetadata = Map.empty }
    Nothing -> return ()
  case getChildrenMaybe "alternate" node of
    Just alt -> do
      mAltId <- withAncestor node (walkNode alt)
      forM_ mAltId $ \altId ->
        emitEdge GraphEdge { geSource = nodeId, geTarget = altId, geType = "HAS_ALTERNATE", geMetadata = Map.empty }
    Nothing -> return ()
  return (Just nodeId)

-- ── Switch Statement ────────────────────────────────────────────────────

ruleSwitchStatement :: ASTNode -> Analyzer (Maybe Text)
ruleSwitchStatement node = do
  file <- askFile
  parent <- askNamedParent
  let sp = astNodeSpan node
      hash = contentHash [("k", "switch"), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "BRANCH" "switch" parent (Just hash)
  emitNode GraphNode
    { gnId = nodeId, gnType = "BRANCH", gnName = "switch"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  case getChildrenMaybe "discriminant" node of
    Just disc -> do
      mDiscId <- withAncestor node (walkNode disc)
      forM_ mDiscId $ \discId ->
        emitEdge GraphEdge { geSource = nodeId, geTarget = discId, geType = "HAS_CONDITION", geMetadata = Map.empty }
    Nothing -> return ()
  let cases = getChildren "cases" node
  mapM_ (\c -> do
    mCaseId <- withAncestor node (walkNode c)
    forM_ mCaseId $ \caseId -> do
      let isDefault = case getChildrenMaybe "test" c of
                        Nothing -> True
                        _       -> False
          edgeType = if isDefault then "HAS_DEFAULT" else "HAS_CASE"
      emitEdge GraphEdge
        { geSource = nodeId, geTarget = caseId
        , geType = edgeType, geMetadata = Map.empty
        }
    ) cases
  return (Just nodeId)

-- ── Switch Case ──────────────────────────────────────────────────────────

ruleSwitchCase :: ASTNode -> Analyzer (Maybe Text)
ruleSwitchCase node = do
  file <- askFile
  parent <- askNamedParent
  let sp = astNodeSpan node
      testValue = case getChildrenMaybe "test" node of
        Just t  -> getTextFieldOr "value" (getTextFieldOr "name" "default" t) t
        Nothing -> "default"
      hash = contentHash [("t", testValue), ("line", T.pack (show (spanStart sp)))]
      nodeId = semanticId file "CASE" "case" parent (Just hash)

  emitNode GraphNode
    { gnId = nodeId, gnType = "CASE", gnName = "case"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }

  -- Test (the case value, null for default)
  case getChildrenMaybe "test" node of
    Just test -> do
      mTestId <- withAncestor node (walkNode test)
      forM_ mTestId $ \testId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = testId
          , geType = "HAS_CONDITION", geMetadata = Map.empty
          }
    Nothing -> return ()  -- default case

  -- Walk consequent statements
  let stmts = getChildren "consequent" node
  mapM_ (\s -> withAncestor node (walkNode s)) stmts
  return (Just nodeId)

-- ── For Statement ───────────────────────────────────────────────────────

ruleForStatement :: ASTNode -> Analyzer (Maybe Text)
ruleForStatement node = do
  file <- askFile
  parent <- askNamedParent
  let sp     = astNodeSpan node
      hash   = contentHash [("k", "for"), ("line", T.pack (show (spanStart sp)))]
      loopId = semanticId file "LOOP" "for" parent (Just hash)
  emitNode GraphNode
    { gnId = loopId, gnType = "LOOP", gnName = "for"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.singleton "kind" (MetaText "for")
    }
  withScope BlockScope loopId $ do
    bodyScopeId <- askScopeId
    emitEdge GraphEdge
      { geSource = loopId, geTarget = bodyScopeId
      , geType = "HAS_BODY", geMetadata = Map.empty
      }
    case getChildrenMaybe "init" node of
      Just ini -> do
        mIniId <- withAncestor node (walkNode ini)
        forM_ mIniId $ \iniId ->
          emitEdge GraphEdge { geSource = loopId, geTarget = iniId, geType = "HAS_INIT", geMetadata = Map.empty }
      Nothing -> return ()
    case getChildrenMaybe "test" node of
      Just test -> do
        mTestId <- withAncestor node (walkNode test)
        forM_ mTestId $ \testId ->
          emitEdge GraphEdge { geSource = loopId, geTarget = testId, geType = "HAS_CONDITION", geMetadata = Map.empty }
      Nothing -> return ()
    case getChildrenMaybe "update" node of
      Just upd -> do
        mUpdId <- withAncestor node (walkNode upd)
        forM_ mUpdId $ \updId ->
          emitEdge GraphEdge { geSource = loopId, geTarget = updId, geType = "HAS_UPDATE", geMetadata = Map.empty }
      Nothing -> return ()
    case getChildrenMaybe "body" node of
      Just body -> do
        mBodyId <- withAncestor node (walkNode body)
        forM_ mBodyId $ \bodyId ->
          emitEdge GraphEdge { geSource = loopId, geTarget = bodyId, geType = "HAS_BODY", geMetadata = Map.empty }
      Nothing -> return ()
  return (Just loopId)

-- | ForIn and ForOf statements
ruleForInOfStatement :: ASTNode -> Analyzer (Maybe Text)
ruleForInOfStatement node = do
  file <- askFile
  parent <- askNamedParent
  let sp     = astNodeSpan node
      hash   = contentHash [("k", "for-in-of"), ("line", T.pack (show (spanStart sp)))]
      loopId = semanticId file "LOOP" "for-in-of" parent (Just hash)
  emitNode GraphNode
    { gnId = loopId, gnType = "LOOP", gnName = "for-in-of"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.singleton "kind" (MetaText "for-in-of")
    }
  withScope BlockScope loopId $ do
    bodyScopeId <- askScopeId
    emitEdge GraphEdge
      { geSource = loopId, geTarget = bodyScopeId
      , geType = "HAS_BODY", geMetadata = Map.empty
      }
    mLeftId <- case getChildrenMaybe "left" node of
      Just left -> withAncestor node (walkNode left)
      Nothing   -> return Nothing
    mRightId <- case getChildrenMaybe "right" node of
      Just right -> withAncestor node (walkNode right)
      Nothing    -> return Nothing
    forM_ mRightId $ \rightId -> do
      emitEdge GraphEdge { geSource = loopId, geTarget = rightId, geType = "ITERATES_OVER", geMetadata = Map.empty }
      forM_ mLeftId $ \leftId ->
        emitEdge GraphEdge { geSource = leftId, geTarget = rightId, geType = "ITERATES_OVER", geMetadata = Map.empty }
    case getChildrenMaybe "body" node of
      Just body -> do
        mBodyId <- withAncestor node (walkNode body)
        forM_ mBodyId $ \bodyId ->
          emitEdge GraphEdge { geSource = loopId, geTarget = bodyId, geType = "HAS_BODY", geMetadata = Map.empty }
      Nothing -> return ()
  return (Just loopId)

-- ── While / DoWhile Statement ───────────────────────────────────────────

ruleWhileStatement :: ASTNode -> Analyzer (Maybe Text)
ruleWhileStatement node = do
  file <- askFile
  parent <- askNamedParent
  let sp     = astNodeSpan node
      hash   = contentHash [("k", "while"), ("line", T.pack (show (spanStart sp)))]
      loopId = semanticId file "LOOP" "while" parent (Just hash)
  emitNode GraphNode
    { gnId = loopId, gnType = "LOOP", gnName = "while"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.singleton "kind" (MetaText "while")
    }
  withScope BlockScope loopId $ do
    bodyScopeId <- askScopeId
    emitEdge GraphEdge
      { geSource = loopId, geTarget = bodyScopeId
      , geType = "HAS_BODY", geMetadata = Map.empty
      }
    case getChildrenMaybe "test" node of
      Just test -> do
        mTestId <- withAncestor node (walkNode test)
        forM_ mTestId $ \testId ->
          emitEdge GraphEdge { geSource = loopId, geTarget = testId, geType = "HAS_CONDITION", geMetadata = Map.empty }
      Nothing -> return ()
    case getChildrenMaybe "body" node of
      Just body -> do
        mBodyId <- withAncestor node (walkNode body)
        forM_ mBodyId $ \bodyId ->
          emitEdge GraphEdge { geSource = loopId, geTarget = bodyId, geType = "HAS_BODY", geMetadata = Map.empty }
      Nothing -> return ()
  return (Just loopId)

-- ── Try Statement ───────────────────────────────────────────────────────

ruleTryStatement :: ASTNode -> Analyzer (Maybe Text)
ruleTryStatement node = do
  file <- askFile
  parent <- askNamedParent
  let sp    = astNodeSpan node
      tryId = semanticId file "TRY_BLOCK" "try" parent Nothing
  emitNode GraphNode
    { gnId = tryId, gnType = "TRY_BLOCK", gnName = "try"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  case getChildrenMaybe "block" node of
    Just blk -> withAncestor node (walkNode blk) >> return ()
    Nothing -> return ()
  case getChildrenMaybe "handler" node of
    Just h -> do
      let hSp = astNodeSpan h
          catchId = semanticId file "CATCH_BLOCK" "catch" parent Nothing
      emitNode GraphNode
        { gnId = catchId, gnType = "CATCH_BLOCK", gnName = "catch"
        , gnFile = file, gnLine = spanStart hSp, gnColumn = 0
        , gnEndLine = spanEnd hSp, gnEndColumn = 0
        , gnExported = False, gnMetadata = Map.empty
        }
      emitEdge GraphEdge { geSource = tryId, geTarget = catchId, geType = "HAS_CATCH", geMetadata = Map.empty }
      withAncestor node (walkNode h) >> return ()
    Nothing -> return ()
  case getChildrenMaybe "finalizer" node of
    Just fin -> do
      let fSp = astNodeSpan fin
          finId = semanticId file "FINALLY_BLOCK" "finally" parent Nothing
      emitNode GraphNode
        { gnId = finId, gnType = "FINALLY_BLOCK", gnName = "finally"
        , gnFile = file, gnLine = spanStart fSp, gnColumn = 0
        , gnEndLine = spanEnd fSp, gnEndColumn = 0
        , gnExported = False, gnMetadata = Map.empty
        }
      emitEdge GraphEdge { geSource = tryId, geTarget = finId, geType = "HAS_FINALLY", geMetadata = Map.empty }
      withAncestor node (walkNode fin) >> return ()
    Nothing -> return ()
  return (Just tryId)

-- ── Block Statement ─────────────────────────────────────────────────────

ruleBlockStatement :: ASTNode -> Analyzer (Maybe Text)
ruleBlockStatement node = do
  let stmts = getChildren "body" node
  mapM_ (\s -> withAncestor node (walkNode s)) stmts
  return Nothing

-- ── Expression Statement ──────────────────────────────────────────────

ruleExpressionStatement :: ASTNode -> Analyzer (Maybe Text)
ruleExpressionStatement node = do
  case getChildrenMaybe "expression" node of
    Just expr -> do
      -- Try CJS export patterns before generic walk
      handled <- handleCjsExport expr
      if handled
        then return Nothing
        else withAncestor node (walkNode expr)
    Nothing   -> return Nothing

-- ── CJS Export Recognition ──────────────────────────────────────────

-- | Detect and handle CommonJS export patterns:
--   1. exports.foo = expr
--   2. module.exports.foo = expr
--   3. module.exports = expr
--   4. Object.defineProperty(exports, 'name', { get: ... })
handleCjsExport :: ASTNode -> Analyzer Bool

-- Pattern 4: Object.defineProperty(exports, 'name', descriptor)
handleCjsExport node@(CallExpressionNode _ _) = do
  case getChildrenMaybe "callee" node of
    Just callee -> do
      let obj  = maybe "" (getTextFieldOr "name" "") (getChildrenMaybe "object" callee)
          prop = maybe "" (getTextFieldOr "name" "") (getChildrenMaybe "property" callee)
      if obj == "Object" && prop == "defineProperty"
        then do
          let args = getChildren "arguments" node
          case args of
            (target:nameArg:_rest) -> do
              let targetName = getTextFieldOr "name" "" target
              if targetName == "exports" || isModuleExports target
                then do
                  let exportName = getTextFieldOr "value" "" nameArg
                  if T.null exportName
                    then return False
                    else do
                      emitCjsNamedExport node exportName
                      return True
                else return False
            _ -> return False
        else return False
    Nothing -> return False

-- Patterns 1-3: assignment to exports/module.exports
handleCjsExport node@(AssignmentExpressionNode _ _) = do
  case getChildrenMaybe "left" node of
    Just left -> case classifyCjsTarget left of
      CjsNamedExport name -> do
        -- exports.foo = expr  OR  module.exports.foo = expr
        emitCjsNamedExport node name
        -- Also walk the right side with exported context
        case getChildrenMaybe "right" node of
          Just right -> withExported $ withAncestor node (walkNode right) >> return ()
          Nothing -> return ()
        return True
      CjsDefaultExport -> do
        -- module.exports = expr — walk RHS with exported flag
        case getChildrenMaybe "right" node of
          Just right -> do
            -- If RHS is a simple identifier (module.exports = ClassName),
            -- emit it as a named export binding so ManifestGenerator finds it
            let rhsName = case right of
                  IdentifierNode _ _ -> getTextFieldOr "name" "" right
                  _                  -> ""
            if not (T.null rhsName)
              then emitCjsNamedExport node rhsName
              else emitCjsDefaultExport node
            withExported $ withAncestor node (walkNode right) >> return ()
          Nothing -> emitCjsDefaultExport node
        return True
      NotCjs -> return False
    Nothing -> return False

handleCjsExport _ = return False

-- | Classification of CJS assignment target
data CjsTarget = CjsNamedExport Text | CjsDefaultExport | NotCjs

-- | Classify a member expression as a CJS export target
classifyCjsTarget :: ASTNode -> CjsTarget
classifyCjsTarget node@(MemberExpressionNode _ _) =
  let obj  = getChildrenMaybe "object" node
      prop = getChildrenMaybe "property" node
      propName = maybe "" (getTextFieldOr "name" "") prop
  in
    -- module.exports = expr (bare, no further property)
    if isModuleExports node then CjsDefaultExport
    else case obj of
      -- exports.foo
      Just objNode@(IdentifierNode _ _) ->
        let objName = getTextFieldOr "name" "" objNode
        in if objName == "exports" && not (T.null propName)
           then CjsNamedExport propName
           else NotCjs
      -- module.exports.foo
      Just objNode@(MemberExpressionNode _ _) ->
        if isModuleExports objNode && not (T.null propName)
          then CjsNamedExport propName
          else NotCjs
      _ -> NotCjs
classifyCjsTarget _ = NotCjs

-- | Check if a node is `module.exports`
isModuleExports :: ASTNode -> Bool
isModuleExports node@(MemberExpressionNode _ _) =
  let obj  = maybe "" (getTextFieldOr "name" "") (getChildrenMaybe "object" node)
      prop = maybe "" (getTextFieldOr "name" "") (getChildrenMaybe "property" node)
  in obj == "module" && prop == "exports"
isModuleExports _ = False

-- | Emit nodes/edges for a CJS named export (exports.foo = ...)
emitCjsNamedExport :: ASTNode -> Text -> Analyzer ()
emitCjsNamedExport node exportName = do
  file <- askFile
  let sp = astNodeSpan node
      exportId = semanticId file "EXPORT" "named" Nothing Nothing
      bindingId = semanticId file "EXPORT_BINDING" exportName Nothing Nothing

  emitNode GraphNode
    { gnId = exportId, gnType = "EXPORT", gnName = "named"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = True, gnMetadata = Map.fromList [("cjs", MetaBool True)]
    }

  emitNode GraphNode
    { gnId = bindingId, gnType = "EXPORT_BINDING", gnName = exportName
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = True, gnMetadata = Map.empty
    }

  emitEdge GraphEdge
    { geSource = exportId, geTarget = bindingId
    , geType = "EXPORTS", geMetadata = Map.empty
    }

  emitExport ExportInfo
    { eiName = exportName, eiNodeId = bindingId
    , eiKind = NamedExport, eiSource = Nothing
    }

-- | Emit nodes/edges for module.exports = expr (CJS default export)
emitCjsDefaultExport :: ASTNode -> Analyzer ()
emitCjsDefaultExport node = do
  file <- askFile
  let sp = astNodeSpan node
      exportId = semanticId file "EXPORT" "default" Nothing Nothing

  emitNode GraphNode
    { gnId = exportId, gnType = "EXPORT", gnName = "default"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = True, gnMetadata = Map.fromList [("cjs", MetaBool True)]
    }

  emitExport ExportInfo
    { eiName = "default", eiNodeId = exportId
    , eiKind = DefaultExport, eiSource = Nothing
    }

-- ── Catch Clause ──────────────────────────────────────────────────────

ruleCatchClause :: ASTNode -> Analyzer (Maybe Text)
ruleCatchClause node = do
  file <- askFile
  parent <- askNamedParent
  let mkCatchBody = case getChildrenMaybe "body" node of
        Just body -> withAncestor node (walkNode body) >> return ()
        Nothing   -> return ()
  case getChildrenMaybe "param" node of
    Just p -> do
      let pName = getTextFieldOr "name" "<catch>" p
          sp    = astNodeSpan p
          pId   = semanticId file "PARAMETER" pName parent Nothing
      emitNode GraphNode
        { gnId = pId, gnType = "PARAMETER", gnName = pName
        , gnFile = file, gnLine = spanStart sp, gnColumn = 0
        , gnEndLine = spanEnd sp, gnEndColumn = 0
        , gnExported = False
        , gnMetadata = Map.singleton "kind" (MetaText "catch")
        }
      withScope CatchScope pId $ do
        catchScopeId <- askScopeId
        emitEdge GraphEdge
          { geSource = catchScopeId, geTarget = pId
          , geType = "DECLARES", geMetadata = Map.empty
          }
        declareInScope (Declaration pId DeclCatch pName) mkCatchBody
    Nothing -> mkCatchBody
  return Nothing

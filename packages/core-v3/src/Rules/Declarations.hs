{-# LANGUAGE OverloadedStrings #-}
-- Rules for declaration nodes: variables, functions, classes, imports, exports
module Rules.Declarations
  ( ruleVariableDeclaration
  , ruleVariableDeclarator
  , ruleFunctionDeclaration
  , ruleClassDeclaration
  , ruleClassBody
  , ruleMethodDefinition
  , rulePropertyDefinition
  , ruleImportDeclaration
  , ruleExportNamedDeclaration
  , ruleExportDefaultDeclaration
  , ruleExportAllDeclaration
  , ruleImportSpecifier
  , ruleImportDefaultSpecifier
  , ruleImportNamespaceSpecifier
  , ruleExportSpecifier
  ) where

import Data.Text (Text)
import Data.Foldable (forM_)
import qualified Data.Map.Strict as Map
import Analysis.Types
import Analysis.Context
import {-# SOURCE #-} Analysis.Walker (walkNode)
import Analysis.Scope (withScope)
import Analysis.SemanticId (semanticId)
import AST.Types
import AST.Span (Span(..))

-- ── Variable Declaration ────────────────────────────────────────────────

-- | VariableDeclaration: walk each declarator, passing down the kind (var/let/const)
ruleVariableDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleVariableDeclaration node = do
  let decls = getChildren "declarations" node
  mapM_ (\d -> withAncestor node (ruleVariableDeclarator d node)) decls
  return Nothing

-- | VariableDeclarator: emit VARIABLE or CONSTANT node + DECLARES edge + ASSIGNED_FROM
ruleVariableDeclarator :: ASTNode -> ASTNode -> Analyzer (Maybe Text)
ruleVariableDeclarator node parentDecl = do
  file <- askFile
  curScopeId <- askScopeId
  let kind = getTextFieldOr "kind" "let" parentDecl
      nodeType = if kind == "const" then "CONSTANT" else "VARIABLE"

  -- Extract binding name from id field
  case getChildrenMaybe "id" node of
    Just idNode -> do
      let name = getTextFieldOr "name" "<anonymous>" idNode
          idSp = astNodeSpan idNode
      parent <- askNamedParent
      let nodeId = semanticId file nodeType name parent Nothing
      emitNode GraphNode
        { gnId       = nodeId
        , gnType     = nodeType
        , gnName     = name
        , gnFile     = file
        , gnLine     = spanStart idSp  -- byte offset for now, orchestrator converts
        , gnColumn   = 0
        , gnExported = False
        , gnMetadata = Map.singleton "kind" (MetaText kind)
        }
      emitEdge GraphEdge
        { geSource = curScopeId
        , geTarget = nodeId
        , geType   = "DECLARES"
        , geMetadata = Map.empty
        }
      -- If there's an initializer, walk it and emit ASSIGNED_FROM
      case getChildrenMaybe "init" node of
        Just initNode -> do
          mChildId <- withAncestor node (walkNode initNode)
          forM_ mChildId $ \childId ->
            emitEdge GraphEdge
              { geSource = nodeId
              , geTarget = childId
              , geType = "ASSIGNED_FROM"
              , geMetadata = Map.empty
              }
        Nothing -> return ()
      return (Just nodeId)
    Nothing -> return Nothing

-- ── Function Declaration ────────────────────────────────────────────────

ruleFunctionDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleFunctionDeclaration node = do
  file <- askFile
  moduleId <- askModuleId
  let name = case getChildrenMaybe "id" node of
               Just idNode -> getTextFieldOr "name" "<anonymous>" idNode
               Nothing     -> "<anonymous>"
      isAsync = getBoolFieldOr "async" False node
      isGen   = getBoolFieldOr "generator" False node

  parent <- askNamedParent
  let nodeId = semanticId file "FUNCTION" name parent Nothing

  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "FUNCTION"
    , gnName     = name
    , gnFile     = file
    , gnLine     = spanStart (astNodeSpan node)
    , gnColumn   = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("async", MetaBool isAsync)
        , ("generator", MetaBool isGen)
        , ("kind", MetaText "function")
        ]
    }
  emitEdge GraphEdge
    { geSource = moduleId
    , geTarget = nodeId
    , geType   = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Scope-aware DECLARES edge
  curScopeId <- askScopeId
  emitEdge GraphEdge
    { geSource = curScopeId
    , geTarget = nodeId
    , geType   = "DECLARES"
    , geMetadata = Map.empty
    }

  -- Walk params and body inside a function scope
  withEnclosingFn nodeId $ withNamedParent name $ withScope FunctionScope nodeId $ do
    let params = getChildren "params" node
    mapM_ (\p -> do
      let pName = getParamName p
          pId   = semanticId file "PARAMETER" pName (Just name) Nothing
      emitNode GraphNode
        { gnId = pId, gnType = "PARAMETER", gnName = pName
        , gnFile = file, gnLine = spanStart (astNodeSpan p), gnColumn = 0
        , gnExported = False, gnMetadata = Map.empty
        }
      emitEdge GraphEdge
        { geSource = nodeId, geTarget = pId
        , geType = "RECEIVES_ARGUMENT", geMetadata = Map.empty
        }
      -- Walk param for defaults, destructuring, type annotations
      withAncestor node (walkNode p) >> return ()
      ) params

    -- Walk body
    case getChildrenMaybe "body" node of
      Just body -> withAncestor node (walkNode body) >> return ()
      Nothing -> return ()

  return (Just nodeId)

-- ── Class Declaration ───────────────────────────────────────────────────

ruleClassDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleClassDeclaration node = do
  file <- askFile
  moduleId <- askModuleId
  let name = case getChildrenMaybe "id" node of
               Just idNode -> getTextFieldOr "name" "<anonymous>" idNode
               Nothing     -> "<anonymous>"

  parent <- askNamedParent
  let nodeId = semanticId file "CLASS" name parent Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name
    , gnFile = file, gnLine = spanStart (astNodeSpan node), gnColumn = 0
    , gnExported = False, gnMetadata = Map.empty
    }
  emitEdge GraphEdge
    { geSource = moduleId, geTarget = nodeId
    , geType = "CONTAINS", geMetadata = Map.empty
    }

  -- Scope-aware DECLARES edge
  curScopeId <- askScopeId
  emitEdge GraphEdge
    { geSource = curScopeId, geTarget = nodeId
    , geType = "DECLARES", geMetadata = Map.empty
    }

  -- Walk body in class scope
  withEnclosingClass nodeId $ withNamedParent name $ withScope ClassScope nodeId $ do
    case getChildrenMaybe "body" node of
      Just body -> withAncestor node (walkNode body) >> return ()
      Nothing -> return ()

  return (Just nodeId)

ruleClassBody :: ASTNode -> Analyzer (Maybe Text)
ruleClassBody node = do
  let members = getChildren "body" node
  mapM_ (\m -> withAncestor node (walkNode m)) members
  return Nothing

ruleMethodDefinition :: ASTNode -> Analyzer (Maybe Text)
ruleMethodDefinition node = do
  file <- askFile
  encClass <- askEnclosingClass
  let name = case getChildrenMaybe "key" node of
               Just keyNode -> getTextFieldOr "name" "<anonymous>" keyNode
               Nothing      -> "<anonymous>"
      kind = getTextFieldOr "kind" "method" node

  parent <- askNamedParent
  let nodeId = semanticId file "METHOD" name parent Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "METHOD", gnName = name
    , gnFile = file, gnLine = spanStart (astNodeSpan node), gnColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "kind" (MetaText kind)
    }

  -- Link to class
  case encClass of
    Just classId -> emitEdge GraphEdge
      { geSource = classId, geTarget = nodeId
      , geType = "HAS_METHOD", geMetadata = Map.empty
      }
    Nothing -> return ()

  -- Walk function value
  case getChildrenMaybe "value" node of
    Just val -> withEnclosingFn nodeId $ withNamedParent name $ withAncestor node (walkNode val) >> return ()
    Nothing  -> return ()

  return (Just nodeId)

-- ── Property Definition ─────────────────────────────────────────────────

rulePropertyDefinition :: ASTNode -> Analyzer (Maybe Text)
rulePropertyDefinition node = do
  file <- askFile
  encClass <- askEnclosingClass
  let name = case getChildrenMaybe "key" node of
               Just keyNode -> getTextFieldOr "name" "<field>" keyNode
               Nothing      -> "<field>"
      isStatic = getBoolFieldOr "static" False node

  parent <- askNamedParent
  let nodeId = semanticId file "PROPERTY" name parent Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "PROPERTY", gnName = name
    , gnFile = file, gnLine = spanStart (astNodeSpan node), gnColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "static" (MetaBool isStatic)
    }

  -- Link to class
  case encClass of
    Just classId -> emitEdge GraphEdge
      { geSource = classId, geTarget = nodeId
      , geType = "HAS_PROPERTY", geMetadata = Map.empty
      }
    Nothing -> return ()

  -- Walk value if present
  case getChildrenMaybe "value" node of
    Just val -> do
      mChildId <- withAncestor node (walkNode val)
      forM_ mChildId $ \childId ->
        emitEdge GraphEdge
          { geSource = nodeId
          , geTarget = childId
          , geType = "ASSIGNED_FROM"
          , geMetadata = Map.empty
          }
    Nothing -> return ()

  return (Just nodeId)

-- ── Import Declaration ──────────────────────────────────────────────────

ruleImportDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleImportDeclaration node = do
  file <- askFile
  let sp     = astNodeSpan node
      source = case getChildrenMaybe "source" node of
                 Just srcNode -> getTextFieldOr "value" "" srcNode
                 Nothing      -> ""
      nodeId = semanticId file "IMPORT" source Nothing Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "IMPORT", gnName = source
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "source" (MetaText source)
    }

  emitDeferred DeferredRef
    { drKind = ImportResolve, drName = source
    , drFromNodeId = nodeId, drEdgeType = "IMPORTS_FROM"
    , drScopeId = Nothing, drSource = Just source
    , drFile = file, drLine = spanStart sp, drColumn = 0
    , drReceiver = Nothing, drMetadata = Map.empty
    }

  -- Walk specifiers for individual import bindings
  let specs = getChildren "specifiers" node
  mapM_ (\s -> withAncestor node (walkNode s)) specs

  return (Just nodeId)

-- ── Import Specifiers ───────────────────────────────────────────────────

ruleImportSpecifier :: ASTNode -> Analyzer (Maybe Text)
ruleImportSpecifier node = do
  file <- askFile
  parent <- askNamedParent
  curScopeId <- askScopeId
  let sp = astNodeSpan node
      localName = case getChildrenMaybe "local" node of
                    Just l  -> getTextFieldOr "name" "<import>" l
                    Nothing -> "<import>"
      importedName = case getChildrenMaybe "imported" node of
                       Just i  -> getTextFieldOr "name" localName i
                       Nothing -> localName
      nodeId = semanticId file "IMPORT_BINDING" localName parent Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "IMPORT_BINDING", gnName = localName
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "importedName" (MetaText importedName)
    }
  emitEdge GraphEdge
    { geSource = curScopeId, geTarget = nodeId
    , geType = "DECLARES", geMetadata = Map.empty
    }
  return (Just nodeId)

ruleImportDefaultSpecifier :: ASTNode -> Analyzer (Maybe Text)
ruleImportDefaultSpecifier node = do
  file <- askFile
  parent <- askNamedParent
  curScopeId <- askScopeId
  let sp = astNodeSpan node
      localName = case getChildrenMaybe "local" node of
                    Just l  -> getTextFieldOr "name" "<default>" l
                    Nothing -> "<default>"
      nodeId = semanticId file "IMPORT_BINDING" localName parent Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "IMPORT_BINDING", gnName = localName
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "importedName" (MetaText "default")
    }
  emitEdge GraphEdge
    { geSource = curScopeId, geTarget = nodeId
    , geType = "DECLARES", geMetadata = Map.empty
    }
  return (Just nodeId)

ruleImportNamespaceSpecifier :: ASTNode -> Analyzer (Maybe Text)
ruleImportNamespaceSpecifier node = do
  file <- askFile
  parent <- askNamedParent
  curScopeId <- askScopeId
  let sp = astNodeSpan node
      localName = case getChildrenMaybe "local" node of
                    Just l  -> getTextFieldOr "name" "<namespace>" l
                    Nothing -> "<namespace>"
      nodeId = semanticId file "IMPORT_BINDING" localName parent Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "IMPORT_BINDING", gnName = localName
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "importedName" (MetaText "*")
    }
  emitEdge GraphEdge
    { geSource = curScopeId, geTarget = nodeId
    , geType = "DECLARES", geMetadata = Map.empty
    }
  return (Just nodeId)

-- ── Export Declarations ─────────────────────────────────────────────────

ruleExportNamedDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleExportNamedDeclaration node = do
  file <- askFile
  let sp     = astNodeSpan node
      nodeId = semanticId file "EXPORT" "named" Nothing Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "EXPORT", gnName = "named"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnExported = True, gnMetadata = Map.empty
    }

  -- Walk the declaration if present
  case getChildrenMaybe "declaration" node of
    Just decl -> do
      mChildId <- withAncestor node (walkNode decl)
      forM_ mChildId $ \childId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = childId
          , geType = "EXPORTS", geMetadata = Map.empty
          }
    Nothing -> return ()

  -- Walk specifiers
  let specs = getChildren "specifiers" node
  mapM_ (\s -> withAncestor node (walkNode s)) specs

  return (Just nodeId)

ruleExportDefaultDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleExportDefaultDeclaration node = do
  file <- askFile
  let sp     = astNodeSpan node
      nodeId = semanticId file "EXPORT" "default" Nothing Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "EXPORT", gnName = "default"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnExported = True, gnMetadata = Map.empty
    }

  case getChildrenMaybe "declaration" node of
    Just decl -> do
      mChildId <- withAncestor node (walkNode decl)
      forM_ mChildId $ \childId ->
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = childId
          , geType = "EXPORTS", geMetadata = Map.empty
          }
    Nothing -> return ()

  return (Just nodeId)

ruleExportAllDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleExportAllDeclaration node = do
  file <- askFile
  let sp     = astNodeSpan node
      source = case getChildrenMaybe "source" node of
                 Just srcNode -> getTextFieldOr "value" "" srcNode
                 Nothing      -> ""
      nodeId = semanticId file "EXPORT" ("*:" <> source) Nothing Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "EXPORT", gnName = "*:" <> source
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnExported = True, gnMetadata = Map.empty
    }

  emitDeferred DeferredRef
    { drKind = ImportResolve, drName = source
    , drFromNodeId = nodeId
    , drEdgeType = "RE_EXPORTS"
    , drScopeId = Nothing, drSource = Just source
    , drFile = file, drLine = spanStart sp, drColumn = 0
    , drReceiver = Nothing, drMetadata = Map.empty
    }

  return (Just nodeId)

-- ── Export Specifier ────────────────────────────────────────────────────

ruleExportSpecifier :: ASTNode -> Analyzer (Maybe Text)
ruleExportSpecifier node = do
  file <- askFile
  parent <- askNamedParent
  let sp = astNodeSpan node
      localName = case getChildrenMaybe "local" node of
                    Just l  -> getTextFieldOr "name" "<export>" l
                    Nothing -> "<export>"
      exportedName = case getChildrenMaybe "exported" node of
                       Just e  -> getTextFieldOr "name" localName e
                       Nothing -> localName
      nodeId = semanticId file "EXPORT_BINDING" localName parent Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "EXPORT_BINDING", gnName = localName
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnExported = True
    , gnMetadata = Map.singleton "exportedName" (MetaText exportedName)
    }
  return (Just nodeId)

-- ── Helpers ─────────────────────────────────────────────────────────────

getParamName :: ASTNode -> Text
getParamName node = case node of
  IdentifierNode _ _       -> getTextFieldOr "name" "<param>" node
  AssignmentPatternNode _ _ ->
    case getChildrenMaybe "left" node of
      Just left -> getParamName left
      Nothing   -> "<param>"
  RestElementNode _ _ ->
    case getChildrenMaybe "argument" node of
      Just arg -> "..." <> getParamName arg
      Nothing  -> "<rest>"
  _ -> "<param>"

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
import qualified Data.Text as T
import Data.Foldable (forM_)
import qualified Data.Map.Strict as Map
import Analysis.Types
import Analysis.Context
import {-# SOURCE #-} Analysis.Walker (walkNode)
import Analysis.Scope (withScope, declareInScope)
import Analysis.SemanticId (semanticId)
import AST.Types
import AST.Span (Span(..))
import Data.Maybe (fromMaybe)

-- ── Variable Declaration ────────────────────────────────────────────────

-- | VariableDeclaration: walk each declarator, passing down the kind (var/let/const).
-- Uses a fold so each declarator is declared in scope for subsequent declarators.
ruleVariableDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleVariableDeclaration node = do
  let decls = getChildren "declarations" node
      kind  = getTextFieldOr "kind" "let" node
      dk = case kind of
        "var"   -> DeclVar
        "let"   -> DeclLet
        "const" -> DeclConst
        _       -> DeclLet
  goDeclarators dk Nothing decls
  where
    goDeclarators :: DeclKind -> Maybe Text -> [ASTNode] -> Analyzer (Maybe Text)
    goDeclarators _ firstId [] = return firstId
    goDeclarators dk firstId (d:ds) = do
      mNodeId <- withAncestor node (ruleVariableDeclarator d node)
      case mNodeId of
        Just nodeId -> do
          let name = case getChildrenMaybe "id" d of
                       Just idNode -> getTextFieldOr "name" "" idNode
                       Nothing     -> ""
              firstId' = case firstId of
                Nothing -> Just nodeId
                _       -> firstId
          if T.null name
            then goDeclarators dk firstId' ds
            else declareInScope (Declaration nodeId dk name) (goDeclarators dk firstId' ds)
        Nothing -> goDeclarators dk firstId ds

-- | VariableDeclarator: emit VARIABLE or CONSTANT node + DECLARES edge + ASSIGNED_FROM
ruleVariableDeclarator :: ASTNode -> ASTNode -> Analyzer (Maybe Text)
ruleVariableDeclarator node parentDecl = do
  file <- askFile
  curScopeId <- askScopeId
  let kind = getTextFieldOr "kind" "let" parentDecl
      nodeType = if kind == "const" then "CONSTANT" else "VARIABLE"
      dk = case kind of
        "var"   -> DeclVar
        "let"   -> DeclLet
        "const" -> DeclConst
        _       -> DeclLet

  -- Extract binding name from id field
  case getChildrenMaybe "id" node of
    Just idNode -> case idNode of
      -- Destructuring patterns: create individual nodes for each binding
      ObjectPatternNode _ _ -> handleDestructuringDecl idNode node parentDecl nodeType kind dk
      ArrayPatternNode _ _  -> handleDestructuringDecl idNode node parentDecl nodeType kind dk
      -- Normal identifier binding: existing logic
      _ -> do
        let name = getTextFieldOr "name" "<anonymous>" idNode
            idSp = astNodeSpan idNode
        parent <- askNamedParent
        isExported <- askExported
        let nodeId = semanticId file nodeType name parent Nothing
        emitNode GraphNode
          { gnId       = nodeId
          , gnType     = nodeType
          , gnName     = name
          , gnFile     = file
          , gnLine     = spanStart idSp  -- byte offset for now, orchestrator converts
          , gnColumn   = 0
          , gnEndLine  = spanEnd idSp
          , gnEndColumn = 0
          , gnExported = isExported
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

-- ── Destructuring Helpers ──────────────────────────────────────────────

-- | Extract all binding info from a destructuring pattern.
-- Returns (name, identifierNode, maybeDefaultExprNode) triples.
-- The default expression node is present for AssignmentPattern bindings.
extractBindingInfo :: ASTNode -> [(Text, ASTNode, Maybe ASTNode)]
extractBindingInfo node = case node of
  IdentifierNode _ _ ->
    let name = getTextFieldOr "name" "" node
    in if T.null name then [] else [(name, node, Nothing)]
  ObjectPatternNode _ _ ->
    concatMap extractFromProperty (getChildren "properties" node)
  ArrayPatternNode _ _ ->
    concatMap extractBindingInfo (getChildren "elements" node)
  AssignmentPatternNode _ _ ->
    -- `{ a = defaultExpr }` or `[a = defaultExpr]`
    let mDefault = getChildrenMaybe "right" node
        leftBindings = case getChildrenMaybe "left" node of
          Just left -> extractBindingInfo left
          Nothing   -> []
    in map (\(n, sp, _) -> (n, sp, mDefault)) leftBindings
  RestElementNode _ _ ->
    case getChildrenMaybe "argument" node of
      Just arg -> extractBindingInfo arg
      Nothing  -> []
  _ -> []
  where
    extractFromProperty :: ASTNode -> [(Text, ASTNode, Maybe ASTNode)]
    extractFromProperty prop = case prop of
      PropertyNode _ _ ->
        -- In destructuring, the binding is in the "value" field.
        -- For `{ a }` (shorthand), value == key (both are Identifier "a").
        -- For `{ a: b }`, key is "a", value is "b" — binding is "b".
        case getChildrenMaybe "value" prop of
          Just val -> extractBindingInfo val
          Nothing  ->
            -- Fallback to key if value is missing
            case getChildrenMaybe "key" prop of
              Just key -> extractBindingInfo key
              Nothing  -> []
      -- RestElement inside ObjectPattern: `{ ...rest }`
      RestElementNode _ _ ->
        case getChildrenMaybe "argument" prop of
          Just arg -> extractBindingInfo arg
          Nothing  -> []
      _ -> []

-- | Handle destructuring declarations (ObjectPattern / ArrayPattern).
-- Creates individual VARIABLE/CONSTANT nodes for each binding with ASSIGNED_FROM edges.
handleDestructuringDecl :: ASTNode -> ASTNode -> ASTNode -> Text -> Text -> DeclKind -> Analyzer (Maybe Text)
handleDestructuringDecl patternNode declaratorNode _parentDecl nodeType kind dk = do
  file <- askFile
  curScopeId <- askScopeId
  parent <- askNamedParent
  isExported <- askExported

  -- Walk the initializer expression (e.g., `obj` in `const { a } = obj`)
  mInitId <- case getChildrenMaybe "init" declaratorNode of
    Just initNode -> withAncestor declaratorNode (walkNode initNode)
    Nothing       -> return Nothing

  -- Extract all binding info from the pattern (including default expr nodes)
  let bindings = extractBindingInfo patternNode

  -- Emit nodes and edges for each binding, accumulating scope declarations
  emitBindings file curScopeId parent isExported nodeType kind dk mInitId declaratorNode bindings Nothing
  where
    emitBindings :: Text -> Text -> Maybe Text -> Bool -> Text -> Text
                 -> DeclKind -> Maybe Text -> ASTNode -> [(Text, ASTNode, Maybe ASTNode)] -> Maybe Text -> Analyzer (Maybe Text)
    emitBindings _ _ _ _ _ _ _ _ _ [] firstId = return firstId
    emitBindings file' scopeId' parent' exported' nType knd dKind mInitId declNode ((name, spanNode, mDefaultExpr):rest) firstId = do
      let sp = astNodeSpan spanNode
          nodeId = semanticId file' nType name parent' Nothing
      emitNode GraphNode
        { gnId       = nodeId
        , gnType     = nType
        , gnName     = name
        , gnFile     = file'
        , gnLine     = spanStart sp
        , gnColumn   = 0
        , gnEndLine  = spanEnd sp
        , gnEndColumn = 0
        , gnExported = exported'
        , gnMetadata = Map.singleton "kind" (MetaText knd)
        }
      emitEdge GraphEdge
        { geSource = scopeId'
        , geTarget = nodeId
        , geType   = "DECLARES"
        , geMetadata = Map.empty
        }
      -- ASSIGNED_FROM edge to the initializer (all bindings point to same init)
      forM_ mInitId $ \initId ->
        emitEdge GraphEdge
          { geSource = nodeId
          , geTarget = initId
          , geType   = "ASSIGNED_FROM"
          , geMetadata = Map.empty
          }
      -- If there's a default value expression, walk it and add ASSIGNED_FROM to it too.
      -- For `const { a = SEED } = {}`, the binding gets ASSIGNED_FROM to both {} and SEED.
      case mDefaultExpr of
        Just defaultExpr -> do
          mDefaultId <- withAncestor declNode (walkNode defaultExpr)
          forM_ mDefaultId $ \defaultId ->
            emitEdge GraphEdge
              { geSource = nodeId
              , geTarget = defaultId
              , geType   = "ASSIGNED_FROM"
              , geMetadata = Map.singleton "source" (MetaText "default")
              }
        Nothing -> return ()
      let firstId' = case firstId of
            Nothing -> Just nodeId
            _       -> firstId
      -- Declare this binding in scope for subsequent bindings
      declareInScope (Declaration nodeId dKind name) $
        emitBindings file' scopeId' parent' exported' nType knd dKind mInitId declNode rest firstId'

-- ── Function Declaration ────────────────────────────────────────────────

ruleFunctionDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleFunctionDeclaration node = do
  file <- askFile
  let name = case getChildrenMaybe "id" node of
               Just idNode -> getTextFieldOr "name" "<anonymous>" idNode
               Nothing     -> "<anonymous>"
      isAsync = getBoolFieldOr "async" False node
      isGen   = getBoolFieldOr "generator" False node

  parent <- askNamedParent
  isExported <- askExported
  let nodeId = semanticId file "FUNCTION" name parent Nothing

  emitNode GraphNode
    { gnId       = nodeId
    , gnType     = "FUNCTION"
    , gnName     = name
    , gnFile     = file
    , gnLine     = spanStart (astNodeSpan node)
    , gnColumn   = 0
    , gnEndLine  = spanEnd (astNodeSpan node)
    , gnEndColumn = 0
    , gnExported = isExported
    , gnMetadata = Map.fromList
        [ ("async", MetaBool isAsync)
        , ("generator", MetaBool isGen)
        , ("kind", MetaText "function")
        ]
    }
  -- Scope-aware DECLARES edge
  curScopeId <- askScopeId
  emitEdge GraphEdge
    { geSource = curScopeId
    , geTarget = nodeId
    , geType   = "DECLARES"
    , geMetadata = Map.empty
    }

  -- Declare function name in parent scope, then walk params and body inside a function scope
  let fnDecl = Declaration nodeId DeclFunction name
  declareInScope fnDecl $
    withEnclosingFn nodeId $ withNamedParent name $ withScope FunctionScope nodeId $ do
      let params = getChildren "params" node
          walkBody = case getChildrenMaybe "body" node of
            Just body -> withAncestor node (walkNode body) >> return ()
            Nothing   -> return ()
      declareParams file name nodeId node params walkBody

  return (Just nodeId)

-- ── Class Declaration ───────────────────────────────────────────────────

ruleClassDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleClassDeclaration node = do
  file <- askFile
  let name = case getChildrenMaybe "id" node of
               Just idNode -> getTextFieldOr "name" "<anonymous>" idNode
               Nothing     -> "<anonymous>"

  parent <- askNamedParent
  isExported <- askExported
  let nodeId = semanticId file "CLASS" name parent Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name
    , gnFile = file, gnLine = spanStart (astNodeSpan node), gnColumn = 0
    , gnEndLine = spanEnd (astNodeSpan node), gnEndColumn = 0
    , gnExported = isExported, gnMetadata = Map.empty
    }
  -- Scope-aware DECLARES edge
  curScopeId <- askScopeId
  emitEdge GraphEdge
    { geSource = curScopeId, geTarget = nodeId
    , geType = "DECLARES", geMetadata = Map.empty
    }

  -- Declare class name in parent scope, then walk body in class scope
  let classDecl = Declaration nodeId DeclClass name
  declareInScope classDecl $
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
    , gnEndLine = spanEnd (astNodeSpan node), gnEndColumn = 0
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
    , gnEndLine = spanEnd (astNodeSpan node), gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "static" (MetaBool isStatic)
    }

  -- Link to class
  case encClass of
    Just classId -> emitEdge GraphEdge
      { geSource = classId, geTarget = nodeId
      , geType = "HAS_PROPERTY"
      , geMetadata = Map.singleton "key" (MetaText name)
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
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.singleton "source" (MetaText source)
    }

  curScopeId <- askScopeId
  emitDeferred DeferredRef
    { drKind = ImportResolve, drName = source
    , drFromNodeId = nodeId, drEdgeType = "IMPORTS_FROM"
    , drScopeId = Just curScopeId, drSource = Just source
    , drFile = file, drLine = spanStart sp, drColumn = 0
    , drReceiver = Nothing, drMetadata = Map.empty
    }

  -- Walk specifiers for individual import bindings
  let specs = getChildren "specifiers" node
  mapM_ (\s -> withNamedParent source $ withAncestor node (walkNode s)) specs

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
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("importedName", MetaText importedName)
        , ("source", MetaText (fromMaybe "" parent))
        ]
    }
  emitEdge GraphEdge
    { geSource = curScopeId, geTarget = nodeId
    , geType = "DECLARES", geMetadata = Map.empty
    }
  declareInScope (Declaration nodeId DeclImport localName) (return ())
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
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("importedName", MetaText "default")
        , ("source", MetaText (fromMaybe "" parent))
        ]
    }
  emitEdge GraphEdge
    { geSource = curScopeId, geTarget = nodeId
    , geType = "DECLARES", geMetadata = Map.empty
    }
  declareInScope (Declaration nodeId DeclImport localName) (return ())
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
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = False
    , gnMetadata = Map.fromList
        [ ("importedName", MetaText "*")
        , ("source", MetaText (fromMaybe "" parent))
        ]
    }
  emitEdge GraphEdge
    { geSource = curScopeId, geTarget = nodeId
    , geType = "DECLARES", geMetadata = Map.empty
    }
  declareInScope (Declaration nodeId DeclImport localName) (return ())
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
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = True, gnMetadata = Map.empty
    }

  -- Walk the declaration if present (withExported so child nodes get exported=True)
  case getChildrenMaybe "declaration" node of
    Just decl -> do
      mChildId <- withExported $ withAncestor node (walkNode decl)
      forM_ mChildId $ \childId -> do
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = childId
          , geType = "EXPORTS", geMetadata = Map.empty
          }
        let exportName = getDeclName decl
        emitExport ExportInfo
          { eiName = exportName, eiNodeId = childId
          , eiKind = NamedExport, eiSource = Nothing }
    Nothing -> return ()

  -- Walk specifiers (pass source if present, for re-export: export { foo } from './bar')
  let specs = getChildren "specifiers" node
      reExportSource = case getChildrenMaybe "source" node of
        Just srcNode -> let s = getTextFieldOr "value" "" srcNode
                        in if T.null s then Nothing else Just s
        Nothing      -> Nothing
  mapM_ (\s -> do
    mSpecId <- case reExportSource of
      Just src -> withNamedParent src $ withAncestor node (walkNode s)
      Nothing  -> withAncestor node (walkNode s)
    forM_ mSpecId $ \specId ->
      emitEdge GraphEdge
        { geSource = nodeId, geTarget = specId
        , geType = "EXPORTS", geMetadata = Map.empty
        }
    ) specs

  return (Just nodeId)

ruleExportDefaultDeclaration :: ASTNode -> Analyzer (Maybe Text)
ruleExportDefaultDeclaration node = do
  file <- askFile
  let sp     = astNodeSpan node
      nodeId = semanticId file "EXPORT" "default" Nothing Nothing

  emitNode GraphNode
    { gnId = nodeId, gnType = "EXPORT", gnName = "default"
    , gnFile = file, gnLine = spanStart sp, gnColumn = 0
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = True, gnMetadata = Map.empty
    }

  case getChildrenMaybe "declaration" node of
    Just decl -> do
      mChildId <- withExported $ withAncestor node (walkNode decl)
      forM_ mChildId $ \childId -> do
        emitEdge GraphEdge
          { geSource = nodeId, geTarget = childId
          , geType = "EXPORTS", geMetadata = Map.empty
          }
        emitExport ExportInfo
          { eiName = "default", eiNodeId = childId
          , eiKind = DefaultExport, eiSource = Nothing }
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
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = True, gnMetadata = Map.empty
    }
  curScopeId <- askScopeId
  emitDeferred DeferredRef
    { drKind = ImportResolve, drName = source
    , drFromNodeId = nodeId
    , drEdgeType = "RE_EXPORTS"
    , drScopeId = Just curScopeId, drSource = Just source
    , drFile = file, drLine = spanStart sp, drColumn = 0
    , drReceiver = Nothing, drMetadata = Map.empty
    }

  emitExport ExportInfo
    { eiName = "*", eiNodeId = nodeId
    , eiKind = ReExport, eiSource = Just source }

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
    , gnEndLine = spanEnd sp, gnEndColumn = 0
    , gnExported = True
    , gnMetadata = case parent of
        Just src -> Map.fromList
          [ ("exportedName", MetaText exportedName)
          , ("source", MetaText src)
          ]
        Nothing -> Map.singleton "exportedName" (MetaText exportedName)
    }

  emitExport ExportInfo
    { eiName = exportedName, eiNodeId = nodeId
    , eiKind = NamedExport, eiSource = parent }

  return (Just nodeId)

-- ── Helpers ─────────────────────────────────────────────────────────────

-- | Process params with scope accumulation: each param is declared in scope
-- for subsequent params and the body action.
declareParams :: Text -> Text -> Text -> ASTNode -> [ASTNode] -> Analyzer () -> Analyzer ()
declareParams _file _fnName _fnNodeId _parentNode [] bodyAction = bodyAction
declareParams file fnName fnNodeId parentNode (p:ps) bodyAction = do
  let pName = getParamName p
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
  -- Walk param for defaults, destructuring, type annotations.
  -- For AssignmentPattern params (default values), walk the default expression
  -- and create ASSIGNED_FROM from the PARAMETER to the default value.
  case p of
    AssignmentPatternNode _ _ -> do
      -- Walk default value (right side) and connect to parameter
      case getChildrenMaybe "right" p of
        Just defaultExpr -> do
          mDefaultId <- withAncestor parentNode (walkNode defaultExpr)
          forM_ mDefaultId $ \defaultId ->
            emitEdge GraphEdge
              { geSource = pId, geTarget = defaultId
              , geType = "ASSIGNED_FROM"
              , geMetadata = Map.singleton "source" (MetaText "default")
              }
        Nothing -> return ()
      -- Walk left side for type annotations (but NOT as a reference)
      case getChildrenMaybe "left" p of
        Just left -> case getChildrenMaybe "typeAnnotation" left of
          Just ta -> withAncestor parentNode (walkNode ta) >> return ()
          Nothing -> return ()
        Nothing -> return ()
    _ -> withAncestor parentNode (walkNode p) >> return ()
  declareInScope (Declaration pId DeclParam pName) $
    declareParams file fnName fnNodeId parentNode ps bodyAction

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

-- | Extract the declared name from a declaration node (for export info).
getDeclName :: ASTNode -> Text
getDeclName decl = case getChildrenMaybe "id" decl of
  Just idNode -> getTextFieldOr "name" "" idNode
  Nothing -> case decl of
    VariableDeclarationNode _ _ ->
      case getChildren "declarations" decl of
        (d:_) -> case getChildrenMaybe "id" d of
          Just idNode -> getTextFieldOr "name" "" idNode
          Nothing -> ""
        [] -> ""
    _ -> ""

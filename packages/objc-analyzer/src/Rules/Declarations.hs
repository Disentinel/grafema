{-# LANGUAGE OverloadedStrings #-}
-- | Declaration rules for Obj-C analysis.
--
-- Handles: @interface, @protocol, @category, @implementation,
-- instance/class methods, properties, enums, C functions, variables,
-- superclass refs, protocol refs.
module Rules.Declarations (walkDeclaration) where

import qualified Data.Map.Strict as Map
import ObjcAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId)
import Rules.Messages (walkMessageExpr)

walkDeclaration :: ObjcDecl -> Analyzer ()

walkDeclaration (ObjCInterfaceDecl name children sp) = do
  file <- askFile
  scopeId <- askScopeId
  let nodeId = semanticId file "CLASS" name Nothing Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = True
    , gnMetadata = Map.fromList [("kind", MetaText "objc_interface"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withEnclosingClass nodeId $ withNamedParent name $ mapM_ walkDeclaration children

walkDeclaration (ObjCProtocolDecl name children sp) = do
  file <- askFile
  scopeId <- askScopeId
  let nodeId = semanticId file "CLASS" name Nothing Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = True
    , gnMetadata = Map.fromList [("kind", MetaText "objc_protocol"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withEnclosingClass nodeId $ withNamedParent name $ mapM_ walkDeclaration children

walkDeclaration (ObjCCategoryDecl name children sp) = do
  file <- askFile
  scopeId <- askScopeId
  let nodeId = semanticId file "EXTENSION" name Nothing Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "EXTENSION", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = True
    , gnMetadata = Map.fromList [("kind", MetaText "category"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withEnclosingClass nodeId $ withNamedParent name $ mapM_ walkDeclaration children

walkDeclaration (ObjCImplementationDecl _name children _sp) = do
  -- Implementation links to existing interface -- emit CONTAINS for methods
  withNamedParent _name $ mapM_ walkDeclaration children

walkDeclaration (ObjCInstanceMethodDecl name _retType children sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  encClass <- askEnclosingClass
  let nodeId = semanticId file "FUNCTION" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "FUNCTION", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = True
    , gnMetadata = Map.fromList [("kind", MetaText "objc_method"), ("isClassMethod", MetaBool False), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  case encClass of
    Just clsId -> emitEdge GraphEdge { geSource = clsId, geTarget = nodeId, geType = "HAS_METHOD", geMetadata = Map.empty }
    Nothing -> return ()
  withEnclosingFn nodeId $ mapM_ walkDeclaration children

walkDeclaration (ObjCClassMethodDecl name _retType children sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  encClass <- askEnclosingClass
  let nodeId = semanticId file "FUNCTION" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "FUNCTION", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = True
    , gnMetadata = Map.fromList [("kind", MetaText "objc_method"), ("isClassMethod", MetaBool True), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  case encClass of
    Just clsId -> emitEdge GraphEdge { geSource = clsId, geTarget = nodeId, geType = "HAS_METHOD", geMetadata = Map.empty }
    Nothing -> return ()
  withEnclosingFn nodeId $ mapM_ walkDeclaration children

walkDeclaration (ObjCPropertyDecl name _propType nullability _children sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let nodeId = semanticId file "VARIABLE" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "VARIABLE", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = True
    , gnMetadata = Map.fromList $
        [("kind", MetaText "objc_property"), ("language", MetaText "objc")] ++
        [("nullability", MetaText n) | Just n <- [nullability]]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

walkDeclaration d@(ObjCMessageExpr{}) = walkMessageExpr d

walkDeclaration (ObjCSuperClassRef name sp) = do
  file <- askFile
  encClass <- askEnclosingClass
  case encClass of
    Just clsId -> emitDeferred DeferredRef
      { drKind = InheritanceResolve, drName = name, drFromNodeId = clsId
      , drEdgeType = "EXTENDS", drScopeId = Nothing, drSource = Nothing
      , drFile = file, drLine = posLine (spanStart sp), drColumn = posCol (spanStart sp)
      , drReceiver = Nothing, drMetadata = Map.empty
      }
    Nothing -> return ()

walkDeclaration (ObjCProtocolRef name sp) = do
  file <- askFile
  encClass <- askEnclosingClass
  case encClass of
    Just clsId -> emitDeferred DeferredRef
      { drKind = InheritanceResolve, drName = name, drFromNodeId = clsId
      , drEdgeType = "IMPLEMENTS", drScopeId = Nothing, drSource = Nothing
      , drFile = file, drLine = posLine (spanStart sp), drColumn = posCol (spanStart sp)
      , drReceiver = Nothing, drMetadata = Map.empty
      }
    Nothing -> return ()

walkDeclaration (EnumDecl name children sp) = do
  file <- askFile
  scopeId <- askScopeId
  let nodeId = semanticId file "CLASS" name Nothing Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = True
    , gnMetadata = Map.fromList [("kind", MetaText "objc_enum"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withNamedParent name $ mapM_ walkDeclaration children

walkDeclaration (EnumConstantDecl name sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let nodeId = semanticId file "VARIABLE" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "VARIABLE", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = True
    , gnMetadata = Map.fromList [("kind", MetaText "enum_constant"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

walkDeclaration (FunctionDecl name children sp) = do
  file <- askFile
  scopeId <- askScopeId
  let nodeId = semanticId file "FUNCTION" name Nothing Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "FUNCTION", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = True
    , gnMetadata = Map.fromList [("kind", MetaText "c_function"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withEnclosingFn nodeId $ mapM_ walkDeclaration children

walkDeclaration (VarDecl name sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  let nodeId = semanticId file "VARIABLE" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "VARIABLE", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = True
    , gnMetadata = Map.fromList [("kind", MetaText "c_variable"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

walkDeclaration (TypedefDecl name sp) = do
  file <- askFile
  scopeId <- askScopeId
  let nodeId = semanticId file "CLASS" name Nothing Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = True
    , gnMetadata = Map.fromList [("kind", MetaText "typedef"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

walkDeclaration _ = return ()

{-# LANGUAGE OverloadedStrings #-}
-- | Declaration rules for Obj-C analysis.
--
-- Handles: @interface, @protocol, @category, @implementation,
-- instance/class methods, properties, enums, C functions, variables,
-- superclass refs, protocol refs.
--
-- Enriches nodes with type metadata:
--   * return_type on method FUNCTION nodes
--   * type on property VARIABLE nodes
--   * extends on CLASS nodes (from ObjCSuperClassRef children)
--   * implements on CLASS nodes (from ObjCProtocolRef children)
module Rules.Declarations (walkDeclaration) where

import qualified Data.Map.Strict as Map
import qualified Data.Text as T
import ObjcAST
import Analysis.Types
import Analysis.Context
import Grafema.SemanticId (semanticId)
import Rules.Messages (walkMessageExpr)
import Rules.Types (extractSuperClass, extractProtocols)

walkDeclaration :: ObjcDecl -> Analyzer ()

walkDeclaration (ObjCInterfaceDecl name children sp) = do
  file <- askFile
  scopeId <- askScopeId
  exported <- askExported
  let nodeId = semanticId file "CLASS" name Nothing Nothing
      superClass = extractSuperClass children
      protocols = extractProtocols children
  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = exported
    , gnMetadata = Map.fromList $
        [("kind", MetaText "objc_interface"), ("language", MetaText "objc")] ++
        [("extends", MetaText sc) | Just sc <- [superClass]] ++
        (let ps = protocols
         in [("implements", MetaText (T.intercalate "," ps)) | not (null ps)])
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withEnclosingClass nodeId $ withNamedParent name $ mapM_ walkDeclaration children

walkDeclaration (ObjCProtocolDecl name children sp) = do
  file <- askFile
  scopeId <- askScopeId
  exported <- askExported
  let nodeId = semanticId file "CLASS" name Nothing Nothing
      protocols = extractProtocols children
  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = exported
    , gnMetadata = Map.fromList $
        [("kind", MetaText "objc_protocol"), ("language", MetaText "objc")] ++
        (let ps = protocols
         in [("implements", MetaText (T.intercalate "," ps)) | not (null ps)])
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withEnclosingClass nodeId $ withNamedParent name $ mapM_ walkDeclaration children

walkDeclaration (ObjCCategoryDecl name children sp) = do
  file <- askFile
  scopeId <- askScopeId
  exported <- askExported
  let nodeId = semanticId file "EXTENSION" name Nothing Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "EXTENSION", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = exported
    , gnMetadata = Map.fromList [("kind", MetaText "category"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withEnclosingClass nodeId $ withNamedParent name $ mapM_ walkDeclaration children

walkDeclaration (ObjCImplementationDecl _name children _sp) = do
  -- Implementation links to existing interface -- emit CONTAINS for methods
  withNamedParent _name $ mapM_ walkDeclaration children

walkDeclaration (ObjCInstanceMethodDecl name retType children sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  encClass <- askEnclosingClass
  exported <- askExported
  let nodeId = semanticId file "FUNCTION" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "FUNCTION", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = exported
    , gnMetadata = Map.fromList $
        [("kind", MetaText "objc_method"), ("isClassMethod", MetaBool False), ("language", MetaText "objc")] ++
        [("return_type", MetaText rt) | Just rt <- [retType]]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  case encClass of
    Just clsId -> emitEdge GraphEdge { geSource = clsId, geTarget = nodeId, geType = "HAS_METHOD", geMetadata = Map.empty }
    Nothing -> return ()
  withEnclosingFn nodeId $ mapM_ walkDeclaration children

walkDeclaration (ObjCClassMethodDecl name retType children sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  encClass <- askEnclosingClass
  exported <- askExported
  let nodeId = semanticId file "FUNCTION" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "FUNCTION", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = exported
    , gnMetadata = Map.fromList $
        [("kind", MetaText "objc_method"), ("isClassMethod", MetaBool True), ("language", MetaText "objc")] ++
        [("return_type", MetaText rt) | Just rt <- [retType]]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  case encClass of
    Just clsId -> emitEdge GraphEdge { geSource = clsId, geTarget = nodeId, geType = "HAS_METHOD", geMetadata = Map.empty }
    Nothing -> return ()
  withEnclosingFn nodeId $ mapM_ walkDeclaration children

walkDeclaration (ObjCPropertyDecl name propType nullability _children sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  exported <- askExported
  let nodeId = semanticId file "VARIABLE" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "VARIABLE", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = exported
    , gnMetadata = Map.fromList $
        [("kind", MetaText "objc_property"), ("language", MetaText "objc")] ++
        [("nullability", MetaText n) | Just n <- [nullability]] ++
        [("type", MetaText pt) | Just pt <- [propType]]
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
  exported <- askExported
  let nodeId = semanticId file "CLASS" name Nothing Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = exported
    , gnMetadata = Map.fromList [("kind", MetaText "objc_enum"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withNamedParent name $ mapM_ walkDeclaration children

walkDeclaration (EnumConstantDecl name sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  exported <- askExported
  let nodeId = semanticId file "VARIABLE" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "VARIABLE", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = exported
    , gnMetadata = Map.fromList [("kind", MetaText "enum_constant"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

walkDeclaration (FunctionDecl name children sp) = do
  file <- askFile
  scopeId <- askScopeId
  exported <- askExported
  let nodeId = semanticId file "FUNCTION" name Nothing Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "FUNCTION", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = exported
    , gnMetadata = Map.fromList [("kind", MetaText "c_function"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }
  withEnclosingFn nodeId $ mapM_ walkDeclaration children

walkDeclaration (VarDecl name sp) = do
  file <- askFile
  scopeId <- askScopeId
  parent <- askNamedParent
  exported <- askExported
  let nodeId = semanticId file "VARIABLE" name parent Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "VARIABLE", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = exported
    , gnMetadata = Map.fromList [("kind", MetaText "c_variable"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

walkDeclaration (TypedefDecl name sp) = do
  file <- askFile
  scopeId <- askScopeId
  exported <- askExported
  let nodeId = semanticId file "CLASS" name Nothing Nothing
  emitNode GraphNode
    { gnId = nodeId, gnType = "CLASS", gnName = name, gnFile = file
    , gnLine = posLine (spanStart sp), gnColumn = posCol (spanStart sp)
    , gnEndLine = posLine (spanEnd sp), gnEndColumn = posCol (spanEnd sp)
    , gnExported = exported
    , gnMetadata = Map.fromList [("kind", MetaText "typedef"), ("language", MetaText "objc")]
    }
  emitEdge GraphEdge { geSource = scopeId, geTarget = nodeId, geType = "CONTAINS", geMetadata = Map.empty }

walkDeclaration _ = return ()

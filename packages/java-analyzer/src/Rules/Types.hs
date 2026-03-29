{-# LANGUAGE OverloadedStrings #-}
-- | Type references rule: EXTENDS, IMPLEMENTS, RETURNS, TYPE_OF edges,
-- TYPE_PARAMETER nodes.
--
-- Handles these Java type relationships:
--   * class extends   -> EXTENDS edge + deferred InheritanceResolve
--   * interface extends -> EXTENDS edge (multiple)
--   * implements      -> IMPLEMENTS edge + deferred InheritanceResolve
--   * return type     -> RETURNS edge
--   * field type      -> TYPE_OF edge
--   * parameter type  -> TYPE_OF edge
--   * type parameters -> TYPE_PARAMETER node + CONTAINS edge
--
-- Called from 'Analysis.Walker.walkFile' for each type declaration.
module Rules.Types
  ( walkTypeRefs
  , typeToName
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import JavaAST
import Analysis.Types
    ( GraphNode(..)
    , GraphEdge(..)
    , MetaValue(..)
    , DeferredRef(..)
    , DeferredKind(..)
    )
import Analysis.Context
    ( Analyzer
    , emitNode
    , emitEdge
    , emitDeferred
    , askFile
    , askNamedParent
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Top-level type ref walker ────────────────────────────────────────────

-- | Walk a type declaration, emitting type relationship edges.
walkTypeRefs :: JavaTypeDecl -> Analyzer ()

-- Class: extends + implements + type params + member types
walkTypeRefs (ClassDecl name _mods typeParams mExtends impls members _annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "CLASS" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  -- extends
  case mExtends of
    Just superType -> emitExtendsEdge file nodeId superType line col
    Nothing        -> pure ()

  -- implements
  mapM_ (emitImplementsEdge file nodeId line col) impls

  -- type parameters
  mapM_ (emitTypeParam file nodeId) typeParams

  -- member type refs
  mapM_ (walkMemberTypeRefs file nodeId) members

-- Interface: extends (multiple) + type params + member types
walkTypeRefs (InterfaceDecl name _mods typeParams extends members _annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "INTERFACE" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  -- extends (interfaces can extend multiple interfaces)
  mapM_ (\t -> emitExtendsEdge file nodeId t line col) extends

  -- type parameters
  mapM_ (emitTypeParam file nodeId) typeParams

  -- member type refs
  mapM_ (walkMemberTypeRefs file nodeId) members

-- Enum: implements + member types
walkTypeRefs (EnumDecl name _mods impls _constants members _annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "ENUM" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  mapM_ (emitImplementsEdge file nodeId line col) impls
  mapM_ (walkMemberTypeRefs file nodeId) members

-- Record: implements + type params + component types + member types
walkTypeRefs (RecordDecl name _mods typeParams impls components members _annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "RECORD" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  mapM_ (emitImplementsEdge file nodeId line col) impls
  mapM_ (emitTypeParam file nodeId) typeParams

  -- Record component types (treated as TYPE_OF edges)
  mapM_ (emitParamTypeOf file nodeId) components
  mapM_ (walkMemberTypeRefs file nodeId) members

-- Annotation type: member types only
walkTypeRefs (AnnotationTypeDecl name _mods members _sp) = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "ANNOTATION_TYPE" name parent Nothing
  mapM_ (walkMemberTypeRefs file nodeId) members

-- ── Member type ref walker ──────────────────────────────────────────────

-- | Walk a member for type references (return types, field types, etc.).
walkMemberTypeRefs :: Text -> Text -> JavaMember -> Analyzer ()

-- Method: return type + parameter types + throws
walkMemberTypeRefs file _parentId (MethodMember name _mods typeParams retType params throws _mBody _annots sp) = do
  parent <- askNamedParent
  let methodId = semanticId file "FUNCTION" name parent Nothing
      line     = posLine (spanStart sp)
      col      = posCol  (spanStart sp)

  -- Return type -> RETURNS edge
  emitTypeEdge file methodId retType "RETURNS" line col

  -- Parameter types -> TYPE_OF edges
  mapM_ (emitParamTypeOf file methodId) params

  -- Throws -> THROWS_TYPE edges
  mapM_ (emitThrowsType file methodId line col) throws

  -- Type parameters
  mapM_ (emitTypeParam file methodId) typeParams

-- Constructor: parameter types + throws
walkMemberTypeRefs file _parentId (ConstructorMember name _mods typeParams params throws _body _annots sp) = do
  parent <- askNamedParent
  let ctorId = semanticId file "FUNCTION" name parent (Just "ctor")
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  mapM_ (emitParamTypeOf file ctorId) params
  mapM_ (emitThrowsType file ctorId line col) throws
  mapM_ (emitTypeParam file ctorId) typeParams

-- Field: field type -> TYPE_OF edges per variable
walkMemberTypeRefs file _parentId (FieldMember _mods fieldType variables _annots sp) = do
  let line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)
  parent <- askNamedParent
  mapM_ (\var -> do
    let hash = contentHash [("line", T.pack (show line)), ("name", jvName var)]
        varId = semanticId file "VARIABLE" (jvName var) parent (Just hash)
    emitTypeEdge file varId fieldType "TYPE_OF" line col
    ) variables

-- Annotation member: return type
walkMemberTypeRefs file _parentId (AnnotationMemberDecl name retType _default sp) = do
  parent <- askNamedParent
  let memberId = semanticId file "FUNCTION" name parent Nothing
      line     = posLine (spanStart sp)
      col      = posCol  (spanStart sp)
  emitTypeEdge file memberId retType "RETURNS" line col

-- Nested type: recurse
walkMemberTypeRefs _ _ (NestedTypeMember typeDecl _) =
  walkTypeRefs typeDecl

-- Other members: skip
walkMemberTypeRefs _ _ _ = pure ()

-- ── Edge emission helpers ───────────────────────────────────────────────

-- | Emit an EXTENDS edge from a type declaration to its superclass/superinterface.
emitExtendsEdge :: Text -> Text -> JavaType -> Int -> Int -> Analyzer ()
emitExtendsEdge file nodeId superType line col = do
  let typeName = typeToName superType

  emitDeferred DeferredRef
    { drKind       = InheritanceResolve
    , drName       = typeName
    , drFromNodeId = nodeId
    , drEdgeType   = "EXTENDS"
    , drScopeId    = Nothing
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.empty
    }

-- | Emit an IMPLEMENTS edge from a type declaration to an interface.
emitImplementsEdge :: Text -> Text -> Int -> Int -> JavaType -> Analyzer ()
emitImplementsEdge file nodeId line col ifaceType = do
  let typeName = typeToName ifaceType

  emitDeferred DeferredRef
    { drKind       = InheritanceResolve
    , drName       = typeName
    , drFromNodeId = nodeId
    , drEdgeType   = "IMPLEMENTS"
    , drScopeId    = Nothing
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.empty
    }

-- | Emit a type relationship edge (RETURNS, TYPE_OF, etc.).
emitTypeEdge :: Text -> Text -> JavaType -> Text -> Int -> Int -> Analyzer ()
emitTypeEdge file fromId jType edgeType line col = do
  let typeName = typeToName jType

  emitDeferred DeferredRef
    { drKind       = TypeResolve
    , drName       = typeName
    , drFromNodeId = fromId
    , drEdgeType   = edgeType
    , drScopeId    = Nothing
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.empty
    }

-- | Emit TYPE_OF edge for a parameter.
emitParamTypeOf :: Text -> Text -> JavaParam -> Analyzer ()
emitParamTypeOf file parentId param = do
  let name = jpName param
      hash = contentHash [("fn", parentId), ("name", name)]
      paramId = semanticId file "VARIABLE" name Nothing (Just hash)
      line = posLine (spanStart (jpSpan param))
      col  = posCol  (spanStart (jpSpan param))
  emitTypeEdge file paramId (jpType param) "TYPE_OF" line col

-- | Emit THROWS_TYPE edge for a throws declaration.
emitThrowsType :: Text -> Text -> Int -> Int -> JavaType -> Analyzer ()
emitThrowsType file fromId line col throwType = do
  let typeName = typeToName throwType
  emitDeferred DeferredRef
    { drKind       = TypeResolve
    , drName       = typeName
    , drFromNodeId = fromId
    , drEdgeType   = "THROWS_TYPE"
    , drScopeId    = Nothing
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.empty
    }

-- | Emit a TYPE_PARAMETER node.
emitTypeParam :: Text -> Text -> JavaTypeParam -> Analyzer ()
emitTypeParam file parentId tp = do
  let name = jtpName tp
      hash = contentHash [("parent", parentId), ("name", name)]
      nodeId = semanticId file "TYPE_PARAMETER" name Nothing (Just hash)
      line = posLine (spanStart (jtpSpan tp))
      col  = posCol  (spanStart (jtpSpan tp))

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "TYPE_PARAMETER"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (jtpSpan tp))
    , gnEndColumn = posCol  (spanEnd (jtpSpan tp))
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("boundsCount", MetaInt (length (jtpBounds tp)))
        ]
    }

  emitEdge GraphEdge
    { geSource   = parentId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit TYPE_BOUND edges for each bound
  mapM_ (emitTypeBound file nodeId line col) (jtpBounds tp)

-- | Emit a TYPE_BOUND edge for a type parameter bound.
emitTypeBound :: Text -> Text -> Int -> Int -> JavaType -> Analyzer ()
emitTypeBound file fromId line col boundType = do
  let typeName = typeToName boundType
  emitDeferred DeferredRef
    { drKind       = TypeResolve
    , drName       = typeName
    , drFromNodeId = fromId
    , drEdgeType   = "TYPE_BOUND"
    , drScopeId    = Nothing
    , drSource     = Nothing
    , drFile       = file
    , drLine       = line
    , drColumn     = col
    , drReceiver   = Nothing
    , drMetadata   = Map.empty
    }

-- ── Helpers ──────────────────────────────────────────────────────────────

-- | Extract a type name from a JavaType for edge metadata.
typeToName :: JavaType -> Text
typeToName (ClassType n _ _ _)     = n
typeToName (PrimitiveType n _)     = n
typeToName (ArrayType comp _)      = typeToName comp <> "[]"
typeToName (VoidType _)            = "void"
typeToName (WildcardType _ _ _)    = "?"
typeToName (UnionType types _)     = T.intercalate " | " (map typeToName types)
typeToName (IntersectionType ts _) = T.intercalate " & " (map typeToName ts)
typeToName (VarType _)             = "var"
typeToName (TypeUnknown _)         = "<unknown>"

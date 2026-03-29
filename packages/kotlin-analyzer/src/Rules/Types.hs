{-# LANGUAGE OverloadedStrings #-}
-- | Type references rule for Kotlin.
--
-- Handles type relationships:
--   * superTypes -> EXTENDS/IMPLEMENTS edges + deferred InheritanceResolve
--   * return type -> RETURNS edge
--   * property type -> TYPE_OF edge
--   * parameter type -> TYPE_OF edge
--   * type parameters -> TYPE_PARAMETER node (with variance in/out, reified)
--   * nullable types -> store nullable: true in edge metadata
module Rules.Types
  ( walkDeclTypeRefs
  , typeToName
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Map.Strict as Map

import KotlinAST
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

-- Top-level type ref walker

walkDeclTypeRefs :: KotlinDecl -> Analyzer ()

-- Class: superTypes + type params + member types
walkDeclTypeRefs (ClassDecl name _kind _mods typeParams _mCtor supers members _annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "CLASS" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  -- superTypes (Kotlin doesn't distinguish extends/implements syntactically,
  -- but the first class super is EXTENDS, interfaces are IMPLEMENTS)
  mapM_ (emitInheritanceEdge file nodeId line col) supers

  -- type parameters
  mapM_ (emitTypeParam file nodeId) typeParams

  -- member type refs
  mapM_ (walkMemberTypeRefs file nodeId) members

-- Object: superTypes + member types
walkDeclTypeRefs (ObjectDecl name _mods supers members _annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let nodeId = semanticId file "CLASS" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  mapM_ (emitInheritanceEdge file nodeId line col) supers
  mapM_ (walkMemberTypeRefs file nodeId) members

-- Top-level function: return type + param types + type params
walkDeclTypeRefs (FunDecl name _mods typeParams mReceiver params mRetType _body _annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let fnId = semanticId file "FUNCTION" name parent Nothing
      line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)

  case mRetType of
    Just rt -> emitTypeEdge file fnId rt "RETURNS" line col
    Nothing -> pure ()

  case mReceiver of
    Just rt -> emitTypeEdge file fnId rt "RECEIVER_TYPE" line col
    Nothing -> pure ()

  mapM_ (emitParamTypeOf file fnId) params
  mapM_ (emitTypeParam file fnId) typeParams

-- Top-level property: property type
walkDeclTypeRefs (PropertyDecl name _mods _isVal mPropType _init _getter _setter _delegated _annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let propId = semanticId file "VARIABLE" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  case mPropType of
    Just pt -> emitTypeEdge file propId pt "TYPE_OF" line col
    Nothing -> pure ()

-- Type alias: aliased type
walkDeclTypeRefs (TypeAliasDecl name _mods typeParams aliasedType _annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let taId = semanticId file "TYPE_ALIAS" name parent Nothing
      line = posLine (spanStart sp)
      col  = posCol  (spanStart sp)

  emitTypeEdge file taId aliasedType "ALIASES" line col
  mapM_ (emitTypeParam file taId) typeParams

walkDeclTypeRefs (DeclUnknown _) = pure ()

-- Member type ref walker

walkMemberTypeRefs :: Text -> Text -> KotlinMember -> Analyzer ()

-- Method: return type + param types
walkMemberTypeRefs file _parentId (FunMember name _mods typeParams mReceiver params mRetType _body _annots sp) = do
  parent <- askNamedParent
  let methodId = semanticId file "FUNCTION" name parent Nothing
      line     = posLine (spanStart sp)
      col      = posCol  (spanStart sp)

  case mRetType of
    Just rt -> emitTypeEdge file methodId rt "RETURNS" line col
    Nothing -> pure ()

  case mReceiver of
    Just rt -> emitTypeEdge file methodId rt "RECEIVER_TYPE" line col
    Nothing -> pure ()

  mapM_ (emitParamTypeOf file methodId) params
  mapM_ (emitTypeParam file methodId) typeParams

-- Property: property type
walkMemberTypeRefs file _parentId (PropertyMember name _mods _isVal mPropType _init _getter _setter _delegated _annots sp) = do
  parent <- askNamedParent
  let propId = semanticId file "VARIABLE" name parent Nothing
      line   = posLine (spanStart sp)
      col    = posCol  (spanStart sp)

  case mPropType of
    Just pt -> emitTypeEdge file propId pt "TYPE_OF" line col
    Nothing -> pure ()

-- Secondary constructor: param types
walkMemberTypeRefs file _parentId (SecondaryConstructor _mods params _deleg _delegArgs _body _annots _sp) = do
  parent <- askNamedParent
  let ctorId = semanticId file "FUNCTION" "<constructor>" parent (Just "secondary_ctor")
  mapM_ (emitParamTypeOf file ctorId) params

-- Nested class: recurse
walkMemberTypeRefs _ _ (NestedClassMember decl _) =
  walkDeclTypeRefs decl

-- Other members: skip
walkMemberTypeRefs _ _ _ = pure ()

-- Edge emission helpers

-- | Emit an EXTENDS or IMPLEMENTS edge (Kotlin doesn't syntactically distinguish,
-- so we emit as EXTENDS for all supertypes).
emitInheritanceEdge :: Text -> Text -> Int -> Int -> KotlinType -> Analyzer ()
emitInheritanceEdge file nodeId line col superType = do
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

-- | Emit a type relationship edge (RETURNS, TYPE_OF, etc.).
emitTypeEdge :: Text -> Text -> KotlinType -> Text -> Int -> Int -> Analyzer ()
emitTypeEdge file fromId kType edgeType line col = do
  let typeName = typeToName kType
      nullable = isNullable kType
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
    , drMetadata   = if nullable
        then Map.singleton "nullable" (MetaBool True)
        else Map.empty
    }

-- | Emit TYPE_OF edge for a parameter.
emitParamTypeOf :: Text -> Text -> KotlinParam -> Analyzer ()
emitParamTypeOf file parentId param = do
  let name = kpName param
      hash = contentHash [("fn", parentId), ("name", name)]
      paramId = semanticId file "VARIABLE" name Nothing (Just hash)
      line = posLine (spanStart (kpSpan param))
      col  = posCol  (spanStart (kpSpan param))
  emitTypeEdge file paramId (kpType param) "TYPE_OF" line col

-- | Emit a TYPE_PARAMETER node.
emitTypeParam :: Text -> Text -> KotlinTypeParam -> Analyzer ()
emitTypeParam file parentId tp = do
  let name = ktpName tp
      hash = contentHash [("parent", parentId), ("name", name)]
      nodeId = semanticId file "TYPE_PARAMETER" name Nothing (Just hash)
      line = posLine (spanStart (ktpSpan tp))
      col  = posCol  (spanStart (ktpSpan tp))

  emitNode GraphNode
    { gnId        = nodeId
    , gnType      = "TYPE_PARAMETER"
    , gnName      = name
    , gnFile      = file
    , gnLine      = line
    , gnColumn    = col
    , gnEndLine   = posLine (spanEnd (ktpSpan tp))
    , gnEndColumn = posCol  (spanEnd (ktpSpan tp))
    , gnExported  = False
    , gnMetadata  = Map.fromList $
        [ ("boundsCount", MetaInt (length (ktpBounds tp)))
        , ("reified",     MetaBool (ktpReified tp))
        ]
        ++ [ ("variance", MetaText v) | Just v <- [ktpVariance tp] ]
    }

  emitEdge GraphEdge
    { geSource   = parentId
    , geTarget   = nodeId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  -- Emit TYPE_BOUND edges for each bound
  mapM_ (emitTypeBound file nodeId line col) (ktpBounds tp)

-- | Emit a TYPE_BOUND edge for a type parameter bound.
emitTypeBound :: Text -> Text -> Int -> Int -> KotlinType -> Analyzer ()
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

-- Helpers

-- | Extract a type name from a KotlinType.
typeToName :: KotlinType -> Text
typeToName (SimpleType n _ nullable _) =
  if nullable then n <> "?" else n
typeToName (FunctionType _ params ret _ _ _) =
  "(" <> T.intercalate ", " (map typeToName params) <> ") -> " <> typeToName ret
typeToName (NullableType inner _) = typeToName inner <> "?"
typeToName (StarProjection _)     = "*"
typeToName (TypeUnknown _)        = "<unknown>"

-- | Check if a type is nullable.
isNullable :: KotlinType -> Bool
isNullable (SimpleType _ _ nullable _) = nullable
isNullable (FunctionType _ _ _ nullable _ _) = nullable
isNullable (NullableType _ _) = True
isNullable _ = False

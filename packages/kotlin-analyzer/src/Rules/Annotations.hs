{-# LANGUAGE OverloadedStrings #-}
-- | Annotations rule for Kotlin: ATTRIBUTE nodes + HAS_ATTRIBUTE edges.
--
-- Same pattern as Java with Kotlin-specific annotation classification.
-- Special handling: @Override -> deferred OVERRIDES edge.
module Rules.Annotations
  ( walkDeclAnnotations
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
    , askScopeId
    , askNamedParent
    )
import Grafema.SemanticId (semanticId, contentHash)

-- Top-level annotation walker

walkDeclAnnotations :: KotlinDecl -> Analyzer ()

walkDeclAnnotations (ClassDecl name _kind _mods _tps _ctor _supers members annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let itemId = semanticId file "CLASS" name parent Nothing
  mapM_ (walkAnnotation file itemId sp) annots
  mapM_ (walkMemberAnnotations file) members

walkDeclAnnotations (ObjectDecl name _mods _supers members annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let itemId = semanticId file "CLASS" name parent Nothing
  mapM_ (walkAnnotation file itemId sp) annots
  mapM_ (walkMemberAnnotations file) members

walkDeclAnnotations (FunDecl name _mods _tps _recv _params _retType _body annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let itemId = semanticId file "FUNCTION" name parent Nothing
  mapM_ (walkAnnotation file itemId sp) annots

walkDeclAnnotations (PropertyDecl name _mods _isVal _pType _init _getter _setter _deleg annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let itemId = semanticId file "VARIABLE" name parent Nothing
  mapM_ (walkAnnotation file itemId sp) annots

walkDeclAnnotations (TypeAliasDecl name _mods _tps _aliased annots sp) = do
  file   <- askFile
  parent <- askNamedParent
  let itemId = semanticId file "TYPE_ALIAS" name parent Nothing
  mapM_ (walkAnnotation file itemId sp) annots

walkDeclAnnotations (DeclUnknown _) = pure ()

-- Member annotation walker

walkMemberAnnotations :: Text -> KotlinMember -> Analyzer ()

walkMemberAnnotations file (FunMember name _mods _tps _recv _params _retType _body annots sp) = do
  parent <- askNamedParent
  let memberId = semanticId file "FUNCTION" name parent Nothing
  mapM_ (walkAnnotation file memberId sp) annots

walkMemberAnnotations file (PropertyMember name _mods _isVal _pType _init _getter _setter _deleg annots sp) = do
  parent <- askNamedParent
  let memberId = semanticId file "VARIABLE" name parent Nothing
  mapM_ (walkAnnotation file memberId sp) annots

walkMemberAnnotations file (SecondaryConstructor _mods _params _deleg _delegArgs _body annots sp) = do
  parent <- askNamedParent
  let memberId = semanticId file "FUNCTION" "<constructor>" parent (Just "secondary_ctor")
  mapM_ (walkAnnotation file memberId sp) annots

walkMemberAnnotations file (EnumEntryMember name _args _members annots sp) = do
  parent <- askNamedParent
  let memberId = semanticId file "VARIABLE" name parent Nothing
  mapM_ (walkAnnotation file memberId sp) annots

walkMemberAnnotations file (CompanionObjectMember mName _supers _members annots sp) = do
  parent <- askNamedParent
  let name = maybe "Companion" id mName
      memberId = semanticId file "CLASS" name parent (Just "companion")
  mapM_ (walkAnnotation file memberId sp) annots

walkMemberAnnotations _ (NestedClassMember decl _) =
  walkDeclAnnotations decl

walkMemberAnnotations _ _ = pure ()

-- Single annotation walker

walkAnnotation :: Text -> Text -> Span -> KotlinAnnotation -> Analyzer ()

walkAnnotation file itemId sp (MarkerAnnotation name _useSite annSp) = do
  scopeId <- askScopeId
  let kind = classifyAnnotation name
      hash = contentHash
        [ ("name", name)
        , ("line", T.pack (show (posLine (spanStart annSp))))
        ]
      attrId = semanticId file "ATTRIBUTE" name Nothing (Just hash)

  emitNode GraphNode
    { gnId        = attrId
    , gnType      = "ATTRIBUTE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = posLine (spanStart annSp)
    , gnColumn    = posCol  (spanStart annSp)
    , gnEndLine   = posLine (spanEnd annSp)
    , gnEndColumn = posCol  (spanEnd annSp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind", MetaText kind)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = attrId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  emitEdge GraphEdge
    { geSource   = itemId
    , geTarget   = attrId
    , geType     = "HAS_ATTRIBUTE"
    , geMetadata = Map.empty
    }

  -- Special: override modifier or @Override -> deferred OVERRIDES
  if name == "Override"
    then emitDeferred DeferredRef
      { drKind       = AnnotationResolve
      , drName       = "Override"
      , drFromNodeId = itemId
      , drEdgeType   = "OVERRIDES"
      , drScopeId    = Nothing
      , drSource     = Nothing
      , drFile       = file
      , drLine       = posLine (spanStart sp)
      , drColumn     = posCol  (spanStart sp)
      , drReceiver   = Nothing
      , drMetadata   = Map.empty
      }
    else pure ()

walkAnnotation file itemId _sp (NormalAnnotation name _args _useSite annSp) = do
  scopeId <- askScopeId
  let kind = classifyAnnotation name
      hash = contentHash
        [ ("name", name)
        , ("line", T.pack (show (posLine (spanStart annSp))))
        ]
      attrId = semanticId file "ATTRIBUTE" name Nothing (Just hash)

  emitNode GraphNode
    { gnId        = attrId
    , gnType      = "ATTRIBUTE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = posLine (spanStart annSp)
    , gnColumn    = posCol  (spanStart annSp)
    , gnEndLine   = posLine (spanEnd annSp)
    , gnEndColumn = posCol  (spanEnd annSp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind", MetaText kind)
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = attrId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

  emitEdge GraphEdge
    { geSource   = itemId
    , geTarget   = attrId
    , geType     = "HAS_ATTRIBUTE"
    , geMetadata = Map.empty
    }

walkAnnotation file _itemId _sp (AnnotationUnknown name annSp) = do
  scopeId <- askScopeId
  let hash = contentHash
        [ ("name", name)
        , ("line", T.pack (show (posLine (spanStart annSp))))
        ]
      attrId = semanticId file "ATTRIBUTE" name Nothing (Just hash)

  emitNode GraphNode
    { gnId        = attrId
    , gnType      = "ATTRIBUTE"
    , gnName      = name
    , gnFile      = file
    , gnLine      = posLine (spanStart annSp)
    , gnColumn    = posCol  (spanStart annSp)
    , gnEndLine   = posLine (spanEnd annSp)
    , gnEndColumn = posCol  (spanEnd annSp)
    , gnExported  = False
    , gnMetadata  = Map.fromList
        [ ("kind", MetaText "unknown")
        ]
    }

  emitEdge GraphEdge
    { geSource   = scopeId
    , geTarget   = attrId
    , geType     = "CONTAINS"
    , geMetadata = Map.empty
    }

-- Annotation classification

classifyAnnotation :: Text -> Text
classifyAnnotation "Override"        = "override"
classifyAnnotation "Deprecated"      = "diagnostic"
classifyAnnotation "Suppress"        = "lint"
classifyAnnotation "JvmStatic"       = "jvm"
classifyAnnotation "JvmOverloads"    = "jvm"
classifyAnnotation "JvmField"        = "jvm"
classifyAnnotation "JvmName"         = "jvm"
classifyAnnotation "JvmWildcard"     = "jvm"
classifyAnnotation "Throws"          = "jvm"
classifyAnnotation "JvmRecord"       = "jvm"
classifyAnnotation "Serializable"    = "serialization"
classifyAnnotation "Transient"       = "serialization"
classifyAnnotation "Test"            = "test"
classifyAnnotation "BeforeTest"      = "test"
classifyAnnotation "AfterTest"       = "test"
classifyAnnotation "Inject"          = "injection"
classifyAnnotation "Component"       = "framework"
classifyAnnotation "Service"         = "framework"
classifyAnnotation "Repository"      = "framework"
classifyAnnotation "Controller"      = "framework"
classifyAnnotation "RestController"  = "framework"
classifyAnnotation "RequestMapping"  = "framework"
classifyAnnotation "GetMapping"      = "framework"
classifyAnnotation "PostMapping"     = "framework"
classifyAnnotation "Composable"      = "framework"
classifyAnnotation "Entity"          = "persistence"
classifyAnnotation "Table"           = "persistence"
classifyAnnotation "Column"          = "persistence"
classifyAnnotation "Id"              = "persistence"
classifyAnnotation _                 = "other"

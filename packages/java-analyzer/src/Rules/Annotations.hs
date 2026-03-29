{-# LANGUAGE OverloadedStrings #-}
-- | Annotations rule: ATTRIBUTE nodes + HAS_ATTRIBUTE edges.
--
-- Handles all Java annotation types:
--   * 'MarkerAnnotation'        (e.g. @Override@)
--     -> ATTRIBUTE node + HAS_ATTRIBUTE edge
--   * 'NormalAnnotation'        (e.g. @SuppressWarnings(value="unchecked")@)
--     -> ATTRIBUTE node + HAS_ATTRIBUTE edge
--   * 'SingleMemberAnnotation'  (e.g. @Test(timeout=1000)@)
--     -> ATTRIBUTE node + HAS_ATTRIBUTE edge
--
-- Special handling:
--   * @Override -> deferred OVERRIDES edge for cross-file resolution
--   * @FunctionalInterface -> metadata on parent
--   * @Deprecated -> metadata on parent
--
-- Node types: ATTRIBUTE
-- Edge types: HAS_ATTRIBUTE, CONTAINS
--
-- Called from 'Analysis.Walker.walkFile' for each type declaration.
module Rules.Annotations
  ( walkAnnotations
  ) where

import Control.Monad (forM_)
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
    , askScopeId
    , askNamedParent
    )
import Grafema.SemanticId (semanticId, contentHash)

-- ── Top-level annotation walker ─────────────────────────────────────────

-- | Walk a type declaration for its annotations and its members' annotations.
walkAnnotations :: JavaTypeDecl -> Analyzer ()
walkAnnotations typeDecl = do
  file   <- askFile
  parent <- askNamedParent
  let (name, nodeType) = typeDeclInfo typeDecl
      itemId = semanticId file nodeType name parent Nothing
      sp     = typeDeclSpan typeDecl

  -- Walk annotations on the type declaration itself
  mapM_ (walkAnnotation file itemId sp) (typeDeclAnnotations typeDecl)

  -- Walk annotations on members
  mapM_ (walkMemberAnnotations file) (typeDeclMembers typeDecl)

-- ── Member annotation walker ────────────────────────────────────────────

-- | Walk a member for its annotations.
walkMemberAnnotations :: Text -> JavaMember -> Analyzer ()

walkMemberAnnotations file (MethodMember name _mods _tps _retType _params _throws _body annots sp) = do
  parent <- askNamedParent
  let memberId = semanticId file "FUNCTION" name parent Nothing
  mapM_ (walkAnnotation file memberId sp) annots

walkMemberAnnotations file (ConstructorMember name _mods _tps _params _throws _body annots sp) = do
  parent <- askNamedParent
  let memberId = semanticId file "FUNCTION" name parent (Just "ctor")
  mapM_ (walkAnnotation file memberId sp) annots

walkMemberAnnotations file (CompactConstructorMember name _mods _body annots sp) = do
  parent <- askNamedParent
  let memberId = semanticId file "FUNCTION" name parent (Just "compact_ctor")
  mapM_ (walkAnnotation file memberId sp) annots

walkMemberAnnotations file (FieldMember _mods _fieldType variables annots sp) = do
  parent <- askNamedParent
  let line = posLine (spanStart sp)
  forM_ variables $ \var -> do
    let hash = contentHash [("line", T.pack (show line)), ("name", jvName var)]
        varId = semanticId file "VARIABLE" (jvName var) parent (Just hash)
    mapM_ (walkAnnotation file varId sp) annots

walkMemberAnnotations file (EnumConstantMember name _args _body annots sp) = do
  parent <- askNamedParent
  let constId = semanticId file "VARIABLE" name parent Nothing
  mapM_ (walkAnnotation file constId sp) annots

walkMemberAnnotations _ (NestedTypeMember typeDecl _) =
  walkAnnotations typeDecl

walkMemberAnnotations _ _ = pure ()

-- ── Single annotation walker ────────────────────────────────────────────

-- | Walk a single annotation, emitting ATTRIBUTE node + HAS_ATTRIBUTE edge.
walkAnnotation :: Text -> Text -> Span -> JavaAnnotation -> Analyzer ()

walkAnnotation file itemId sp (MarkerAnnotation name annSp) = do
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

  -- Special: @Override -> deferred OVERRIDES
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

walkAnnotation file itemId _sp (NormalAnnotation name members annSp) = do
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
    , gnMetadata  = Map.fromList $
        [ ("kind",        MetaText kind)
        , ("memberCount", MetaInt (length members))
        ] ++
        [ ("members", MetaList (map (\(k, _) -> MetaText k) members))
        | not (null members)
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

walkAnnotation file itemId _sp (SingleMemberAnnotation name _value annSp) = do
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

-- ── Annotation classification ───────────────────────────────────────────

-- | Classify a Java annotation into a kind for metadata.
classifyAnnotation :: Text -> Text
classifyAnnotation "Override"           = "override"
classifyAnnotation "Deprecated"         = "diagnostic"
classifyAnnotation "SuppressWarnings"   = "lint"
classifyAnnotation "FunctionalInterface" = "marker"
classifyAnnotation "SafeVarargs"        = "safety"
classifyAnnotation "Test"               = "test"
classifyAnnotation "Before"             = "test"
classifyAnnotation "After"              = "test"
classifyAnnotation "BeforeEach"         = "test"
classifyAnnotation "AfterEach"          = "test"
classifyAnnotation "BeforeAll"          = "test"
classifyAnnotation "AfterAll"           = "test"
classifyAnnotation "Inject"             = "injection"
classifyAnnotation "Autowired"          = "injection"
classifyAnnotation "Component"          = "framework"
classifyAnnotation "Service"            = "framework"
classifyAnnotation "Repository"         = "framework"
classifyAnnotation "Controller"         = "framework"
classifyAnnotation "RestController"     = "framework"
classifyAnnotation "RequestMapping"     = "framework"
classifyAnnotation "GetMapping"         = "framework"
classifyAnnotation "PostMapping"        = "framework"
classifyAnnotation "PutMapping"         = "framework"
classifyAnnotation "DeleteMapping"      = "framework"
classifyAnnotation "Entity"             = "persistence"
classifyAnnotation "Table"              = "persistence"
classifyAnnotation "Column"             = "persistence"
classifyAnnotation "Id"                 = "persistence"
classifyAnnotation "Nullable"           = "nullability"
classifyAnnotation "NonNull"            = "nullability"
classifyAnnotation "NotNull"            = "nullability"
classifyAnnotation _                    = "other"

-- ── Helpers ──────────────────────────────────────────────────────────────

-- | Extract name and node type from a type declaration.
typeDeclInfo :: JavaTypeDecl -> (Text, Text)
typeDeclInfo (ClassDecl n _ _ _ _ _ _ _)    = (n, "CLASS")
typeDeclInfo (InterfaceDecl n _ _ _ _ _ _)   = (n, "INTERFACE")
typeDeclInfo (EnumDecl n _ _ _ _ _ _)        = (n, "ENUM")
typeDeclInfo (RecordDecl n _ _ _ _ _ _ _)    = (n, "RECORD")
typeDeclInfo (AnnotationTypeDecl n _ _ _)    = (n, "ANNOTATION_TYPE")

-- | Extract the span from a type declaration.
typeDeclSpan :: JavaTypeDecl -> Span
typeDeclSpan (ClassDecl _ _ _ _ _ _ _ sp)    = sp
typeDeclSpan (InterfaceDecl _ _ _ _ _ _ sp)   = sp
typeDeclSpan (EnumDecl _ _ _ _ _ _ sp)        = sp
typeDeclSpan (RecordDecl _ _ _ _ _ _ _ sp)    = sp
typeDeclSpan (AnnotationTypeDecl _ _ _ sp)    = sp

-- | Extract annotations from a type declaration.
typeDeclAnnotations :: JavaTypeDecl -> [JavaAnnotation]
typeDeclAnnotations (ClassDecl _ _ _ _ _ _ as _)    = as
typeDeclAnnotations (InterfaceDecl _ _ _ _ _ as _)   = as
typeDeclAnnotations (EnumDecl _ _ _ _ _ as _)        = as
typeDeclAnnotations (RecordDecl _ _ _ _ _ _ as _)    = as
typeDeclAnnotations (AnnotationTypeDecl _ _ _ _)     = []

-- | Extract members from a type declaration.
typeDeclMembers :: JavaTypeDecl -> [JavaMember]
typeDeclMembers (ClassDecl _ _ _ _ _ ms _ _)      = ms
typeDeclMembers (InterfaceDecl _ _ _ _ ms _ _)     = ms
typeDeclMembers (EnumDecl _ _ _ _ ms _ _)          = ms
typeDeclMembers (RecordDecl _ _ _ _ _ ms _ _)      = ms
typeDeclMembers (AnnotationTypeDecl _ _ ms _)      = ms
